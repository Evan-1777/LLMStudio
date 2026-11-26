package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"llmstudio/backend/internal/domain"
)

// ScheduledTaskStore manages ScheduledTask persistence and atomic due-task claiming in SQLite.
type ScheduledTaskStore struct {
	db *sql.DB
}

// NewScheduledTaskStore constructs a ScheduledTaskStore backed by db.
func NewScheduledTaskStore(db *sql.DB) *ScheduledTaskStore {
	return &ScheduledTaskStore{db: db}
}

const scheduledTaskSelectCols = `
	t.id, t.name, t.prompt, t.enabled, t.hour, t.minute, t.weekdays_json, t.timezone,
	t.max_runs, t.run_count, t.bind_mode, t.conversation_id, COALESCE(c.title, ''),
	t.assistant_id, t.provider_id, t.model_id, t.next_run_at, t.last_run_at,
	t.last_status, t.last_error, t.last_conversation_id, t.created_at, t.updated_at
`

// List returns scheduled tasks, optionally filtered by conversationID.
func (s *ScheduledTaskStore) List(ctx context.Context, conversationID string) ([]domain.ScheduledTask, error) {
	query := `
		SELECT ` + scheduledTaskSelectCols + `
		FROM scheduled_tasks t
		LEFT JOIN conversations c ON t.conversation_id = c.id
	`
	var args []any
	if conversationID != "" {
		query += ` WHERE t.conversation_id = ?`
		args = append(args, conversationID)
	}
	query += ` ORDER BY t.enabled DESC, COALESCE(t.next_run_at, '9999') ASC, t.created_at DESC`

	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("list scheduled tasks: %w", err)
	}
	defer rows.Close()

	tasks := make([]domain.ScheduledTask, 0)
	for rows.Next() {
		task, err := scanScheduledTask(rows)
		if err != nil {
			return nil, err
		}
		tasks = append(tasks, task)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate scheduled tasks: %w", err)
	}
	return tasks, nil
}

// Get fetches a single scheduled task by ID.
func (s *ScheduledTaskStore) Get(ctx context.Context, id string) (domain.ScheduledTask, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT `+scheduledTaskSelectCols+`
		FROM scheduled_tasks t
		LEFT JOIN conversations c ON t.conversation_id = c.id
		WHERE t.id = ?
	`, id)
	task, err := scanScheduledTask(row)
	if errors.Is(err, sql.ErrNoRows) {
		return domain.ScheduledTask{}, domain.NewError(domain.ErrCodeNotFound, "scheduled task not found", err)
	}
	if err != nil {
		return domain.ScheduledTask{}, fmt.Errorf("get scheduled task %s: %w", id, err)
	}
	return task, nil
}

// Create persists a new scheduled task.
func (s *ScheduledTaskStore) Create(ctx context.Context, task domain.ScheduledTask) (domain.ScheduledTask, error) {
	now := time.Now().UTC()
	if task.ID == "" {
		task.ID = domain.NewUUID()
	}
	if task.CreatedAt.IsZero() {
		task.CreatedAt = now
	}
	if task.UpdatedAt.IsZero() {
		task.UpdatedAt = task.CreatedAt
	}
	weekdaysJSON, err := marshalWeekdays(task.Weekdays)
	if err != nil {
		return domain.ScheduledTask{}, err
	}

	_, err = s.db.ExecContext(ctx, `
		INSERT INTO scheduled_tasks (
			id, name, prompt, enabled, hour, minute, weekdays_json, timezone,
			max_runs, run_count, bind_mode, conversation_id, assistant_id, provider_id, model_id,
			next_run_at, last_run_at, last_status, last_error, last_conversation_id, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`,
		task.ID, task.Name, task.Prompt, boolToInt(task.Enabled), task.Hour, task.Minute,
		weekdaysJSON, task.Timezone, task.MaxRuns, task.RunCount, task.BindMode,
		nullableString(task.ConversationID), task.AssistantID, task.ProviderID, task.ModelID,
		nullableTimeArg(task.NextRunAt), nullableTimeArg(task.LastRunAt),
		task.LastStatus, task.LastError, task.LastConversationID,
		formatTime(task.CreatedAt), formatTime(task.UpdatedAt),
	)
	if err != nil {
		return domain.ScheduledTask{}, fmt.Errorf("create scheduled task: %w", err)
	}
	return s.Get(ctx, task.ID)
}

// Update persists updated schedule configuration fields.
func (s *ScheduledTaskStore) Update(ctx context.Context, task domain.ScheduledTask) (domain.ScheduledTask, error) {
	if task.UpdatedAt.IsZero() {
		task.UpdatedAt = time.Now().UTC()
	}
	weekdaysJSON, err := marshalWeekdays(task.Weekdays)
	if err != nil {
		return domain.ScheduledTask{}, err
	}

	res, err := s.db.ExecContext(ctx, `
		UPDATE scheduled_tasks
		SET name = ?, prompt = ?, enabled = ?, hour = ?, minute = ?, weekdays_json = ?, timezone = ?,
		    max_runs = ?, run_count = ?, bind_mode = ?, conversation_id = ?,
		    assistant_id = ?, provider_id = ?, model_id = ?,
		    next_run_at = ?, last_error = ?, updated_at = ?
		WHERE id = ?
	`,
		task.Name, task.Prompt, boolToInt(task.Enabled), task.Hour, task.Minute,
		weekdaysJSON, task.Timezone, task.MaxRuns, task.RunCount, task.BindMode,
		nullableString(task.ConversationID), task.AssistantID, task.ProviderID, task.ModelID,
		nullableTimeArg(task.NextRunAt), task.LastError, formatTime(task.UpdatedAt), task.ID,
	)
	if err != nil {
		return domain.ScheduledTask{}, fmt.Errorf("update scheduled task %s: %w", task.ID, err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return domain.ScheduledTask{}, fmt.Errorf("update scheduled task rows %s: %w", task.ID, err)
	}
	if n == 0 {
		return domain.ScheduledTask{}, domain.NewError(domain.ErrCodeNotFound, "scheduled task not found", nil)
	}
	return s.Get(ctx, task.ID)
}

// Delete removes a scheduled task by ID.
func (s *ScheduledTaskStore) Delete(ctx context.Context, id string) error {
	res, err := s.db.ExecContext(ctx, `DELETE FROM scheduled_tasks WHERE id = ?`, id)
	if err != nil {
		return fmt.Errorf("delete scheduled task %s: %w", id, err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return fmt.Errorf("delete scheduled task rows %s: %w", id, err)
	}
	if n == 0 {
		return domain.NewError(domain.ErrCodeNotFound, "scheduled task not found", nil)
	}
	return nil
}

// ClaimDue atomically claims due enabled tasks within a single transaction.
// Tasks overdue beyond graceWindow have next_run_at advanced without triggering or incrementing run_count.
// Claimed tasks advance next_run_at and mark last_status='running' without incrementing run_count yet;
// run_count and max_runs exhaustion are finalized via MarkRunDispatched after Prepare succeeds.
func (s *ScheduledTaskStore) ClaimDue(
	ctx context.Context,
	now time.Time,
	graceWindow time.Duration,
	computeNext func(domain.ScheduledTask, time.Time) *time.Time,
) ([]domain.ScheduledTask, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("begin claim due tx: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	nowUTC := now.UTC()
	nowStr := formatTime(nowUTC)

	rows, err := tx.QueryContext(ctx, `
		SELECT `+scheduledTaskSelectCols+`
		FROM scheduled_tasks t
		LEFT JOIN conversations c ON t.conversation_id = c.id
		WHERE t.enabled = 1
		  AND t.next_run_at IS NOT NULL
		  AND t.next_run_at <= ?
		  AND t.last_status != ?
		ORDER BY t.next_run_at ASC
	`, nowStr, domain.ScheduleStatusRunning)
	if err != nil {
		return nil, fmt.Errorf("query due scheduled tasks: %w", err)
	}

	var candidates []domain.ScheduledTask
	for rows.Next() {
		t, err := scanScheduledTask(rows)
		if err != nil {
			_ = rows.Close()
			return nil, err
		}
		candidates = append(candidates, t)
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return nil, fmt.Errorf("iterate due scheduled tasks: %w", err)
	}
	_ = rows.Close()

	claimed := make([]domain.ScheduledTask, 0, len(candidates))
	for _, t := range candidates {
		nextAt := computeNext(t, nowUTC)
		if t.NextRunAt != nil && graceWindow > 0 && nowUTC.Sub(*t.NextRunAt) > graceWindow {
			if _, err := tx.ExecContext(ctx, `
				UPDATE scheduled_tasks
				SET next_run_at = ?, updated_at = ?
				WHERE id = ?
			`, nullableTimeArg(nextAt), nowStr, t.ID); err != nil {
				return nil, fmt.Errorf("advance overdue scheduled task %s: %w", t.ID, err)
			}
			continue
		}

		if _, err := tx.ExecContext(ctx, `
			UPDATE scheduled_tasks
			SET last_run_at = ?, last_status = ?, last_error = '', next_run_at = ?, updated_at = ?
			WHERE id = ?
		`, nowStr, domain.ScheduleStatusRunning, nullableTimeArg(nextAt), nowStr, t.ID); err != nil {
			return nil, fmt.Errorf("claim scheduled task %s: %w", t.ID, err)
		}

		lastAt := nowUTC
		t.LastRunAt = &lastAt
		t.LastStatus = domain.ScheduleStatusRunning
		t.LastError = ""
		t.NextRunAt = nextAt
		t.UpdatedAt = nowUTC
		claimed = append(claimed, t)
	}

	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("commit claim due tx: %w", err)
	}
	return claimed, nil
}

// MarkRunDispatched atomically increments run_count, records last_conversation_id,
// and disables the task if max_runs has been reached.
func (s *ScheduledTaskStore) MarkRunDispatched(ctx context.Context, id, lastConvID string, now time.Time) error {
	nowStr := formatTime(now.UTC())
	_, err := s.db.ExecContext(ctx, `
		UPDATE scheduled_tasks
		SET run_count = run_count + 1,
		    last_conversation_id = CASE WHEN ? != '' THEN ? ELSE last_conversation_id END,
		    enabled = CASE WHEN max_runs > 0 AND run_count + 1 >= max_runs THEN 0 ELSE enabled END,
		    next_run_at = CASE WHEN max_runs > 0 AND run_count + 1 >= max_runs THEN NULL ELSE next_run_at END,
		    updated_at = ?
		WHERE id = ?
	`, lastConvID, lastConvID, nowStr, id)
	if err != nil {
		return fmt.Errorf("mark scheduled task dispatched %s: %w", id, err)
	}
	return nil
}

// MarkManualRunStart atomically marks an idle task as running for manual RunNow without altering next_run_at or run_count.
func (s *ScheduledTaskStore) MarkManualRunStart(ctx context.Context, id string, now time.Time) (domain.ScheduledTask, error) {
	nowStr := formatTime(now.UTC())
	res, err := s.db.ExecContext(ctx, `
		UPDATE scheduled_tasks
		SET last_run_at = ?, last_status = ?, last_error = '', updated_at = ?
		WHERE id = ? AND last_status != ?
	`, nowStr, domain.ScheduleStatusRunning, nowStr, id, domain.ScheduleStatusRunning)
	if err != nil {
		return domain.ScheduledTask{}, fmt.Errorf("mark manual run start %s: %w", id, err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return domain.ScheduledTask{}, fmt.Errorf("mark manual run start rows %s: %w", id, err)
	}
	if n == 0 {
		if _, getErr := s.Get(ctx, id); getErr != nil {
			return domain.ScheduledTask{}, getErr
		}
		return domain.ScheduledTask{}, domain.NewError(domain.ErrCodeConflict, "定时任务正在执行中", nil)
	}
	return s.Get(ctx, id)
}

// RecoverInterruptedRuns marks any tasks left in 'running' status from a prior crash/restart as failed.
func (s *ScheduledTaskStore) RecoverInterruptedRuns(ctx context.Context, now time.Time) (int64, error) {
	nowStr := formatTime(now.UTC())
	res, err := s.db.ExecContext(ctx, `
		UPDATE scheduled_tasks
		SET last_status = ?, last_error = '服务重启中断', updated_at = ?
		WHERE last_status = ?
	`, domain.ScheduleStatusFailed, nowStr, domain.ScheduleStatusRunning)
	if err != nil {
		return 0, fmt.Errorf("recover interrupted runs: %w", err)
	}
	n, _ := res.RowsAffected()
	return n, nil
}

// RecordRunOutcome persists the terminal status, optional error summary, and non-empty last_conversation_id.
func (s *ScheduledTaskStore) RecordRunOutcome(ctx context.Context, id, status, errMsg, lastConvID string) error {
	nowStr := formatTime(time.Now().UTC())
	_, err := s.db.ExecContext(ctx, `
		UPDATE scheduled_tasks
		SET last_status = ?,
		    last_error = ?,
		    last_conversation_id = CASE WHEN ? != '' THEN ? ELSE last_conversation_id END,
		    updated_at = ?
		WHERE id = ?
	`, status, errMsg, lastConvID, lastConvID, nowStr, id)
	if err != nil {
		return fmt.Errorf("record scheduled task outcome %s: %w", id, err)
	}
	return nil
}

// SetDisabledWithError disables a task and clears next_run_at with an explicit failure message.
func (s *ScheduledTaskStore) SetDisabledWithError(ctx context.Context, id, errMsg string) error {
	nowStr := formatTime(time.Now().UTC())
	_, err := s.db.ExecContext(ctx, `
		UPDATE scheduled_tasks
		SET enabled = 0, next_run_at = NULL, last_status = ?, last_error = ?, updated_at = ?
		WHERE id = ?
	`, domain.ScheduleStatusFailed, errMsg, nowStr, id)
	if err != nil {
		return fmt.Errorf("disable scheduled task %s: %w", id, err)
	}
	return nil
}

func marshalWeekdays(days []int) (string, error) {
	if len(days) == 0 {
		return "[]", nil
	}
	b, err := json.Marshal(days)
	if err != nil {
		return "", fmt.Errorf("encode weekdays: %w", err)
	}
	return string(b), nil
}

func nullableTimeArg(t *time.Time) any {
	if t == nil {
		return nil
	}
	return formatTime(*t)
}

func scanScheduledTask(s rowScanner) (domain.ScheduledTask, error) {
	var (
		t            domain.ScheduledTask
		enabledInt   int
		weekdaysJSON string
		convID       sql.NullString
		nextRunRaw   sql.NullString
		lastRunRaw   sql.NullString
		createdRaw   string
		updatedRaw   string
	)
	if err := s.Scan(
		&t.ID, &t.Name, &t.Prompt, &enabledInt, &t.Hour, &t.Minute, &weekdaysJSON, &t.Timezone,
		&t.MaxRuns, &t.RunCount, &t.BindMode, &convID, &t.ConversationTitle,
		&t.AssistantID, &t.ProviderID, &t.ModelID, &nextRunRaw, &lastRunRaw,
		&t.LastStatus, &t.LastError, &t.LastConversationID, &createdRaw, &updatedRaw,
	); err != nil {
		return domain.ScheduledTask{}, err
	}
	t.Enabled = enabledInt != 0
	if convID.Valid {
		v := convID.String
		t.ConversationID = &v
	}
	t.Weekdays = []int{}
	if weekdaysJSON != "" {
		if err := json.Unmarshal([]byte(weekdaysJSON), &t.Weekdays); err != nil {
			return domain.ScheduledTask{}, fmt.Errorf("decode weekdays for %s: %w", t.ID, err)
		}
		if t.Weekdays == nil {
			t.Weekdays = []int{}
		}
	}
	if nextRunRaw.Valid && nextRunRaw.String != "" {
		parsed, err := parseTime(nextRunRaw.String)
		if err != nil {
			return domain.ScheduledTask{}, fmt.Errorf("parse next_run_at for %s: %w", t.ID, err)
		}
		t.NextRunAt = &parsed
	}
	if lastRunRaw.Valid && lastRunRaw.String != "" {
		parsed, err := parseTime(lastRunRaw.String)
		if err != nil {
			return domain.ScheduledTask{}, fmt.Errorf("parse last_run_at for %s: %w", t.ID, err)
		}
		t.LastRunAt = &parsed
	}
	var err error
	if t.CreatedAt, err = parseTime(createdRaw); err != nil {
		return domain.ScheduledTask{}, fmt.Errorf("parse created_at for %s: %w", t.ID, err)
	}
	if t.UpdatedAt, err = parseTime(updatedRaw); err != nil {
		return domain.ScheduledTask{}, fmt.Errorf("parse updated_at for %s: %w", t.ID, err)
	}
	return t, nil
}
