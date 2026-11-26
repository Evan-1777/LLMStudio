package service

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"

	"llmstudio/backend/internal/domain"
	"llmstudio/backend/internal/store"
)

const (
	defaultSchedulePollInterval = 15 * time.Second
	defaultScheduleGraceWindow  = 2 * time.Minute
	maxConcurrentScheduleRuns   = 4
	scheduleCleanupTimeout      = 3 * time.Second
)

// ScheduleService manages cloud-only Agent scheduled tasks and runs the background alarm scheduler.
type ScheduleService struct {
	tasks        *store.ScheduledTaskStore
	convs        *store.ConversationStore
	providers    *store.ProviderStore
	assistants   *store.AssistantStore
	chatSvc      *ChatService
	nowFn        func() time.Time
	pollInterval time.Duration
	graceWindow  time.Duration

	wakeupCh chan struct{}
	sem      chan struct{}

	mu             sync.Mutex
	started        bool
	inFlight       map[string]struct{}
	dispatchCtx    context.Context
	dispatchCancel context.CancelFunc
	loopStop       context.CancelFunc
	loopDone       chan struct{}
	taskWg         sync.WaitGroup
}

// NewScheduleService constructs a ScheduleService with production defaults.
func NewScheduleService(
	tasks *store.ScheduledTaskStore,
	convs *store.ConversationStore,
	providers *store.ProviderStore,
	assistants *store.AssistantStore,
	chatSvc *ChatService,
) *ScheduleService {
	return &ScheduleService{
		tasks:        tasks,
		convs:        convs,
		providers:    providers,
		assistants:   assistants,
		chatSvc:      chatSvc,
		nowFn:        func() time.Time { return time.Now().UTC() },
		pollInterval: defaultSchedulePollInterval,
		graceWindow:  defaultScheduleGraceWindow,
		wakeupCh:     make(chan struct{}, 1),
		sem:          make(chan struct{}, maxConcurrentScheduleRuns),
		inFlight:     make(map[string]struct{}),
	}
}

func (s *ScheduleService) now() time.Time {
	if s.nowFn != nil {
		return s.nowFn().UTC()
	}
	return time.Now().UTC()
}

func (s *ScheduleService) notifyWakeup() {
	select {
	case s.wakeupCh <- struct{}{}:
	default:
	}
}

func (s *ScheduleService) tryStartInFlight(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, exists := s.inFlight[id]; exists {
		return false
	}
	s.inFlight[id] = struct{}{}
	return true
}

func (s *ScheduleService) finishInFlight(id string) {
	s.mu.Lock()
	delete(s.inFlight, id)
	s.mu.Unlock()
}

// Start recovers any interrupted running rows from a previous process crash and starts the scheduler loop.
func (s *ScheduleService) Start(ctx context.Context) {
	s.mu.Lock()
	if s.started {
		s.mu.Unlock()
		return
	}
	s.started = true
	s.dispatchCtx, s.dispatchCancel = context.WithCancel(context.Background())
	loopCtx, loopCancel := context.WithCancel(ctx)
	s.loopStop = loopCancel
	s.loopDone = make(chan struct{})
	done := s.loopDone
	s.mu.Unlock()

	_, _ = s.tasks.RecoverInterruptedRuns(ctx, s.now())

	go func() {
		defer close(done)
		s.runLoop(loopCtx)
	}()
}

// StopScheduler stops claiming new tasks and cancels pending pre-dispatch work.
// Call ChatService.Shutdown before WaitObservers so running detached streams can finish cleanly.
func (s *ScheduleService) StopScheduler() {
	s.mu.Lock()
	if !s.started {
		s.mu.Unlock()
		return
	}
	s.started = false
	loopStop := s.loopStop
	loopDone := s.loopDone
	dispatchCancel := s.dispatchCancel
	s.mu.Unlock()

	if loopStop != nil {
		loopStop()
	}
	if dispatchCancel != nil {
		dispatchCancel()
	}
	if loopDone != nil {
		<-loopDone
	}
}

// WaitObservers waits for all in-flight task dispatches and outcome observers to persist or ctx to expire.
func (s *ScheduleService) WaitObservers(ctx context.Context) error {
	done := make(chan struct{})
	go func() {
		s.taskWg.Wait()
		close(done)
	}()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Stop stops the scheduler and waits for observers to finish within ctx.
func (s *ScheduleService) Stop(ctx context.Context) error {
	s.StopScheduler()
	return s.WaitObservers(ctx)
}

func (s *ScheduleService) runLoop(ctx context.Context) {
	s.tick(ctx)
	interval := s.pollInterval
	if interval <= 0 {
		interval = defaultSchedulePollInterval
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.tick(ctx)
		case <-s.wakeupCh:
			s.tick(ctx)
		}
	}
}

func (s *ScheduleService) tick(ctx context.Context) {
	if ctx.Err() != nil {
		return
	}
	now := s.now()
	claimed, err := s.tasks.ClaimDue(ctx, now, s.graceWindow, func(t domain.ScheduledTask, ref time.Time) *time.Time {
		next, calcErr := ComputeNextScheduleRun(ref, t.Hour, t.Minute, t.Weekdays, t.Timezone)
		if calcErr != nil {
			return nil
		}
		return next
	})
	if err != nil || len(claimed) == 0 {
		return
	}

	s.mu.Lock()
	dispatchCtx := s.dispatchCtx
	s.mu.Unlock()
	if dispatchCtx == nil {
		dispatchCtx = ctx
	}

	for _, task := range claimed {
		if !s.tryStartInFlight(task.ID) {
			continue
		}
		s.taskWg.Add(1)
		go func(t domain.ScheduledTask) {
			defer s.taskWg.Done()
			defer s.finishInFlight(t.ID)

			select {
			case s.sem <- struct{}{}:
			case <-dispatchCtx.Done():
				_ = s.recordOutcomeWithTimeout(t.ID, domain.ScheduleStatusFailed, "服务停机中断", "")
				return
			}
			defer func() { <-s.sem }()

			convID, ps, err := s.launchTask(dispatchCtx, t, true)
			if err != nil {
				return
			}
			s.observeRun(t.ID, convID, ps)
		}(task)
	}
}

// List returns all scheduled tasks, optionally filtered by bound conversation ID.
func (s *ScheduleService) List(ctx context.Context, conversationID string) ([]domain.ScheduledTask, error) {
	return s.tasks.List(ctx, strings.TrimSpace(conversationID))
}

// Get returns a scheduled task by ID.
func (s *ScheduleService) Get(ctx context.Context, id string) (domain.ScheduledTask, error) {
	return s.tasks.Get(ctx, strings.TrimSpace(id))
}

// Create validates and persists a new scheduled task, computing nextRunAt if enabled.
func (s *ScheduleService) Create(ctx context.Context, in domain.ScheduleCreateInput) (domain.ScheduledTask, error) {
	name := strings.TrimSpace(in.Name)
	if name == "" {
		return domain.ScheduledTask{}, domain.NewError(domain.ErrCodeInvalidArgument, "任务名称不能为空", nil)
	}
	prompt := strings.TrimSpace(in.Prompt)
	if prompt == "" {
		return domain.ScheduledTask{}, domain.NewError(domain.ErrCodeInvalidArgument, "提示词不能为空", nil)
	}
	if err := domain.ValidateScheduleTime(in.Hour, in.Minute); err != nil {
		return domain.ScheduledTask{}, err
	}
	if in.MaxRuns < 0 {
		return domain.ScheduledTask{}, domain.NewError(domain.ErrCodeInvalidArgument, "执行次数不能为负数", nil)
	}
	weekdays, err := domain.NormalizeWeekdays(in.Weekdays)
	if err != nil {
		return domain.ScheduledTask{}, err
	}
	tz := strings.TrimSpace(in.Timezone)
	if tz == "" {
		tz = "UTC"
	}
	if _, err := resolveBuiltinTimezone(tz); err != nil {
		return domain.ScheduledTask{}, domain.NewError(domain.ErrCodeInvalidArgument, err.Error(), err)
	}

	bindMode := strings.TrimSpace(in.BindMode)
	if bindMode == "" {
		if in.ConversationID != nil && strings.TrimSpace(*in.ConversationID) != "" {
			bindMode = domain.ScheduleBindModeConversation
		} else {
			bindMode = domain.ScheduleBindModeNew
		}
	}

	enabled := true
	if in.Enabled != nil {
		enabled = *in.Enabled
	}

	task := domain.ScheduledTask{
		Name:        name,
		Prompt:      prompt,
		Enabled:     enabled,
		Hour:        in.Hour,
		Minute:      in.Minute,
		Weekdays:    weekdays,
		Timezone:    tz,
		MaxRuns:     in.MaxRuns,
		BindMode:    bindMode,
		AssistantID: strings.TrimSpace(in.AssistantID),
		ProviderID:  strings.TrimSpace(in.ProviderID),
		ModelID:     strings.TrimSpace(in.ModelID),
	}
	if in.ConversationID != nil {
		cid := strings.TrimSpace(*in.ConversationID)
		if cid != "" {
			task.ConversationID = &cid
		}
	}

	if err := s.validateScheduleTarget(ctx, &task); err != nil {
		return domain.ScheduledTask{}, err
	}

	if task.Enabled {
		next, err := ComputeNextScheduleRun(s.now(), task.Hour, task.Minute, task.Weekdays, task.Timezone)
		if err != nil {
			return domain.ScheduledTask{}, domain.NewError(domain.ErrCodeInvalidArgument, err.Error(), err)
		}
		task.NextRunAt = next
	}

	created, err := s.tasks.Create(ctx, task)
	if err != nil {
		return domain.ScheduledTask{}, err
	}
	if created.Enabled {
		s.notifyWakeup()
	}
	return created, nil
}

// CreateFromTopic is used by the Agent schedule tool to create a task bound to topicID
// or as a new-topic schedule inheriting topicID's assistant/provider/model.
func (s *ScheduleService) CreateFromTopic(ctx context.Context, topicID string, bindCurrent bool, in domain.ScheduleCreateInput) (domain.ScheduledTask, error) {
	topic, err := s.convs.Get(ctx, strings.TrimSpace(topicID))
	if err != nil {
		return domain.ScheduledTask{}, err
	}
	if bindCurrent {
		in.BindMode = domain.ScheduleBindModeConversation
		id := topic.ID
		in.ConversationID = &id
	} else {
		in.BindMode = domain.ScheduleBindModeNew
		in.ConversationID = nil
		if strings.TrimSpace(in.AssistantID) == "" {
			in.AssistantID = topic.AssistantID
		}
		if strings.TrimSpace(in.ProviderID) == "" {
			in.ProviderID = topic.ProviderID
		}
		if strings.TrimSpace(in.ModelID) == "" {
			in.ModelID = topic.ModelID
		}
	}
	return s.Create(ctx, in)
}

// Update modifies an existing scheduled task, supports rebinding or mode switching, and recalculates nextRunAt.
func (s *ScheduleService) Update(ctx context.Context, id string, in domain.ScheduleUpdateInput) (domain.ScheduledTask, error) {
	task, err := s.tasks.Get(ctx, strings.TrimSpace(id))
	if err != nil {
		return domain.ScheduledTask{}, err
	}

	if in.Name != nil {
		name := strings.TrimSpace(*in.Name)
		if name == "" {
			return domain.ScheduledTask{}, domain.NewError(domain.ErrCodeInvalidArgument, "任务名称不能为空", nil)
		}
		task.Name = name
	}
	if in.Prompt != nil {
		prompt := strings.TrimSpace(*in.Prompt)
		if prompt == "" {
			return domain.ScheduledTask{}, domain.NewError(domain.ErrCodeInvalidArgument, "提示词不能为空", nil)
		}
		task.Prompt = prompt
	}
	if in.Hour != nil {
		task.Hour = *in.Hour
	}
	if in.Minute != nil {
		task.Minute = *in.Minute
	}
	if err := domain.ValidateScheduleTime(task.Hour, task.Minute); err != nil {
		return domain.ScheduledTask{}, err
	}
	if in.Weekdays != nil {
		weekdays, err := domain.NormalizeWeekdays(*in.Weekdays)
		if err != nil {
			return domain.ScheduledTask{}, err
		}
		task.Weekdays = weekdays
	}
	if in.Timezone != nil {
		tz := strings.TrimSpace(*in.Timezone)
		if tz == "" {
			tz = "UTC"
		}
		if _, err := resolveBuiltinTimezone(tz); err != nil {
			return domain.ScheduledTask{}, domain.NewError(domain.ErrCodeInvalidArgument, err.Error(), err)
		}
		task.Timezone = tz
	}
	if in.MaxRuns != nil {
		if *in.MaxRuns < 0 {
			return domain.ScheduledTask{}, domain.NewError(domain.ErrCodeInvalidArgument, "执行次数不能为负数", nil)
		}
		task.MaxRuns = *in.MaxRuns
	}
	if in.ResetRunCount != nil && *in.ResetRunCount {
		task.RunCount = 0
	}
	if in.BindMode != nil {
		task.BindMode = strings.TrimSpace(*in.BindMode)
		if task.BindMode == domain.ScheduleBindModeNew {
			task.ConversationID = nil
		}
	}
	if in.ConversationID != nil {
		cid := strings.TrimSpace(*in.ConversationID)
		if cid == "" {
			task.ConversationID = nil
		} else {
			task.ConversationID = &cid
		}
	}
	if in.AssistantID != nil {
		task.AssistantID = strings.TrimSpace(*in.AssistantID)
	}
	if in.ProviderID != nil {
		task.ProviderID = strings.TrimSpace(*in.ProviderID)
	}
	if in.ModelID != nil {
		task.ModelID = strings.TrimSpace(*in.ModelID)
	}
	if in.Enabled != nil {
		task.Enabled = *in.Enabled
	}

	if err := s.validateScheduleTarget(ctx, &task); err != nil {
		return domain.ScheduledTask{}, err
	}

	if task.Enabled {
		if task.MaxRuns > 0 && task.RunCount >= task.MaxRuns {
			return domain.ScheduledTask{}, domain.NewError(domain.ErrCodeInvalidArgument, "已达到最大执行次数，请增大次数或重置计数后再启用", nil)
		}
		next, err := ComputeNextScheduleRun(s.now(), task.Hour, task.Minute, task.Weekdays, task.Timezone)
		if err != nil {
			return domain.ScheduledTask{}, domain.NewError(domain.ErrCodeInvalidArgument, err.Error(), err)
		}
		task.NextRunAt = next
		task.LastError = ""
	} else {
		task.NextRunAt = nil
	}

	task.UpdatedAt = s.now()
	updated, err := s.tasks.Update(ctx, task)
	if err != nil {
		return domain.ScheduledTask{}, err
	}
	if updated.Enabled {
		s.notifyWakeup()
	}
	return updated, nil
}

// Delete removes a scheduled task by ID.
func (s *ScheduleService) Delete(ctx context.Context, id string) error {
	return s.tasks.Delete(ctx, strings.TrimSpace(id))
}

// RunNow immediately triggers a scheduled task without altering its planned nextRunAt or scheduled runCount.
func (s *ScheduleService) RunNow(ctx context.Context, id string) (domain.ScheduledTask, string, error) {
	id = strings.TrimSpace(id)
	if !s.tryStartInFlight(id) {
		return domain.ScheduledTask{}, "", domain.NewError(domain.ErrCodeConflict, "定时任务正在执行中", nil)
	}

	task, err := s.tasks.MarkManualRunStart(ctx, id, s.now())
	if err != nil {
		s.finishInFlight(id)
		return domain.ScheduledTask{}, "", err
	}

	convID, ps, err := s.launchTask(ctx, task, false)
	if err != nil {
		s.finishInFlight(id)
		return domain.ScheduledTask{}, "", err
	}

	s.taskWg.Add(1)
	go func() {
		defer s.taskWg.Done()
		defer s.finishInFlight(task.ID)
		s.observeRun(task.ID, convID, ps)
	}()

	updated, getErr := s.tasks.Get(ctx, task.ID)
	if getErr != nil {
		return task, convID, nil
	}
	return updated, convID, nil
}

func (s *ScheduleService) validateScheduleTarget(ctx context.Context, task *domain.ScheduledTask) error {
	switch task.BindMode {
	case domain.ScheduleBindModeConversation:
		if task.ConversationID == nil || strings.TrimSpace(*task.ConversationID) == "" {
			return domain.NewError(domain.ErrCodeInvalidArgument, "绑定模式必须指定目标 Agent 话题", nil)
		}
		conv, err := s.convs.Get(ctx, *task.ConversationID)
		if err != nil {
			return err
		}
		if conv.Ephemeral {
			return domain.NewError(domain.ErrCodeInvalidArgument, "不能绑定临时会话", nil)
		}
		if conv.Mode != domain.ConversationModeAgent {
			return domain.NewError(domain.ErrCodeInvalidArgument, "定时任务仅支持绑定 Agent 模式话题", nil)
		}
		if err := s.validateCloudModel(ctx, conv.ProviderID, conv.ModelID); err != nil {
			return err
		}
		if task.AssistantID == "" {
			task.AssistantID = conv.AssistantID
		}
		if task.ProviderID == "" {
			task.ProviderID = conv.ProviderID
		}
		if task.ModelID == "" {
			task.ModelID = conv.ModelID
		}
		return nil

	case domain.ScheduleBindModeNew:
		task.ConversationID = nil
		if task.AssistantID == "" {
			task.AssistantID = domain.DefaultAssistantID
		}
		if s.assistants != nil {
			if _, err := s.assistants.Get(ctx, task.AssistantID); err != nil {
				return err
			}
		}
		return s.validateCloudModel(ctx, task.ProviderID, task.ModelID)

	default:
		return domain.NewError(domain.ErrCodeInvalidArgument, fmt.Sprintf("invalid bindMode %q", task.BindMode), nil)
	}
}

func (s *ScheduleService) validateCloudModel(ctx context.Context, providerID, modelID string) error {
	providerID = strings.TrimSpace(providerID)
	modelID = strings.TrimSpace(modelID)
	if providerID == "" || modelID == "" {
		return domain.NewError(domain.ErrCodeInvalidArgument, "必须选择云端供应商与模型", nil)
	}
	prov, err := s.providers.Get(ctx, providerID)
	if err != nil {
		return err
	}
	if !prov.Enabled {
		return domain.NewError(domain.ErrCodeInvalidArgument, fmt.Sprintf("供应商 %q 已禁用", prov.Name), nil)
	}
	if prov.LocalRequest {
		return domain.NewError(domain.ErrCodeInvalidArgument, "定时任务不支持仅限浏览器直连的供应商", nil)
	}
	if _, ok := findModel(prov.Models, modelID); !ok {
		return domain.NewError(domain.ErrCodeNotFound, fmt.Sprintf("供应商 %q 中未找到模型 %q", prov.Name, modelID), nil)
	}
	return nil
}

func (s *ScheduleService) launchTask(ctx context.Context, task domain.ScheduledTask, fromSchedule bool) (string, *PreparedStream, error) {
	recordLaunchErr := func(status, msg string) {
		if fromSchedule && task.BindMode == domain.ScheduleBindModeConversation && msg == "绑定话题已删除" {
			bgCtx, cancel := context.WithTimeout(context.Background(), scheduleCleanupTimeout)
			_ = s.tasks.SetDisabledWithError(bgCtx, task.ID, msg)
			cancel()
			return
		}
		_ = s.recordOutcomeWithTimeout(task.ID, status, msg, "")
	}

	var (
		targetConvID   string
		createdNewConv bool
	)

	if task.BindMode == domain.ScheduleBindModeConversation {
		if task.ConversationID == nil || strings.TrimSpace(*task.ConversationID) == "" {
			msg := "绑定话题已删除"
			recordLaunchErr(domain.ScheduleStatusFailed, msg)
			return "", nil, domain.NewError(domain.ErrCodeNotFound, msg, nil)
		}
		conv, err := s.convs.Get(ctx, *task.ConversationID)
		if err != nil {
			msg := err.Error()
			if appErr, ok := domain.AsAppError(err); ok && appErr.Code == domain.ErrCodeNotFound {
				msg = "绑定话题已删除"
			}
			recordLaunchErr(domain.ScheduleStatusFailed, msg)
			return "", nil, err
		}
		if conv.Ephemeral || conv.Mode != domain.ConversationModeAgent {
			msg := "绑定话题不是持久化 Agent 模式"
			recordLaunchErr(domain.ScheduleStatusFailed, msg)
			return "", nil, domain.NewError(domain.ErrCodeInvalidArgument, msg, nil)
		}
		if err := s.validateCloudModel(ctx, conv.ProviderID, conv.ModelID); err != nil {
			recordLaunchErr(domain.ScheduleStatusFailed, err.Error())
			return "", nil, err
		}
		targetConvID = conv.ID
	} else {
		if err := s.validateCloudModel(ctx, task.ProviderID, task.ModelID); err != nil {
			recordLaunchErr(domain.ScheduleStatusFailed, err.Error())
			return "", nil, err
		}
		assistantID := strings.TrimSpace(task.AssistantID)
		if assistantID == "" {
			assistantID = domain.DefaultAssistantID
		}
		createdConv, err := s.convs.Create(ctx, domain.Conversation{
			AssistantID: assistantID,
			Title:       task.Name,
			ProviderID:  task.ProviderID,
			ModelID:     task.ModelID,
			Mode:        domain.ConversationModeAgent,
		})
		if err != nil {
			recordLaunchErr(domain.ScheduleStatusFailed, err.Error())
			return "", nil, err
		}
		targetConvID = createdConv.ID
		createdNewConv = true
	}

	ps, err := s.chatSvc.Prepare(ctx, StreamChatInput{
		ConversationID:  targetConvID,
		Text:            task.Prompt,
		MCPToolsEnabled: domain.BoolPtr(true),
	})
	if err != nil {
		if createdNewConv {
			bgCtx, cancel := context.WithTimeout(context.Background(), scheduleCleanupTimeout)
			_ = s.convs.Delete(bgCtx, targetConvID)
			cancel()
		}
		if fromSchedule {
			if appErr, ok := domain.AsAppError(err); ok && appErr.Code == domain.ErrCodeConflict {
				_ = s.recordOutcomeWithTimeout(task.ID, domain.ScheduleStatusSkipped, appErr.Message, "")
				return "", nil, err
			}
		}
		_ = s.recordOutcomeWithTimeout(task.ID, domain.ScheduleStatusFailed, err.Error(), "")
		return "", nil, err
	}

	if fromSchedule {
		bgCtx, cancel := context.WithTimeout(context.Background(), scheduleCleanupTimeout)
		_ = s.tasks.MarkRunDispatched(bgCtx, task.ID, targetConvID, s.now())
		cancel()
	} else {
		_ = s.recordOutcomeWithTimeout(task.ID, domain.ScheduleStatusRunning, "", targetConvID)
	}

	return targetConvID, ps, nil
}

func (s *ScheduleService) observeRun(taskID, convID string, ps *PreparedStream) {
	stopReason, errMsg, completed := ps.WaitDetachedOutcome(context.Background())
	if !completed {
		_ = s.recordOutcomeWithTimeout(taskID, domain.ScheduleStatusFailed, "运行状态未知", convID)
		return
	}
	switch stopReason {
	case domain.StopReasonError:
		if errMsg == "" {
			errMsg = "Agent 执行失败"
		}
		_ = s.recordOutcomeWithTimeout(taskID, domain.ScheduleStatusFailed, errMsg, convID)
	case domain.StopReasonAborted:
		if errMsg == "" {
			errMsg = "运行已取消"
		}
		_ = s.recordOutcomeWithTimeout(taskID, domain.ScheduleStatusFailed, errMsg, convID)
	default:
		_ = s.recordOutcomeWithTimeout(taskID, domain.ScheduleStatusSucceeded, "", convID)
	}
}

func (s *ScheduleService) recordOutcomeWithTimeout(id, status, errMsg, lastConvID string) error {
	bgCtx, cancel := context.WithTimeout(context.Background(), scheduleCleanupTimeout)
	defer cancel()
	return s.tasks.RecordRunOutcome(bgCtx, id, status, errMsg, lastConvID)
}
