import { useEffect, useId, useMemo, useState, type FormEvent } from 'react';
import { useApp } from '../../app/AppProvider';
import {
  Button,
  ErrorBanner,
  Field,
  Icon,
  Input,
  Modal,
  SegmentedControl,
  Select,
  Switch,
  Textarea,
} from '../../components/ui';
import type {
  Conversation,
  CreateScheduledTaskInput,
  ScheduleBindMode,
  ScheduledTask,
  TopicScope,
  UpdateScheduledTaskInput,
} from '../../core/types';
import {
  COMMON_TIMEZONES,
  WEEKDAY_PILLS,
  buildCloudAgentConversations,
  formatAlarmTime,
  formatScheduleError,
  formatWeekdays,
  getCloudEligibleModels,
  getDefaultTimezone,
  makeModelSelectionKey,
  normalizeWeekdays,
  parseModelSelectionKey,
  parseTimeValue,
} from './scheduleFormat';
import './schedule.css';

export interface ScheduleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editingTask?: ScheduledTask | null;
  lockedConversation?: Conversation | null;
  defaultAssistantId?: string;
  defaultProviderId?: string;
  defaultModelId?: string;
  scope?: TopicScope;
  onSaved?: (task: ScheduledTask) => void;
}

export function ScheduleDialog({
  open,
  onOpenChange,
  editingTask = null,
  lockedConversation = null,
  defaultAssistantId,
  defaultProviderId,
  defaultModelId,
  scope,
  onSaved,
}: ScheduleDialogProps) {
  const { gateway, resources } = useApp();
  const baseId = useId();
  const isEdit = Boolean(editingTask);

  const cloudModels = useMemo(
    () => getCloudEligibleModels(resources.providers),
    [resources.providers],
  );

  const cloudAgentConversations = useMemo(() => {
    const base = buildCloudAgentConversations(
      resources.cloudConversations,
      resources.assistants,
    );
    if (
      lockedConversation &&
      !lockedConversation.ephemeral &&
      !base.some((item) => item.id === lockedConversation.id)
    ) {
      const assistant = resources.assistants.find(
        (a) => a.id === (lockedConversation.assistantId || 'default'),
      );
      base.unshift({
        id: lockedConversation.id,
        title: lockedConversation.title || '未命名话题',
        assistantId: lockedConversation.assistantId || 'default',
        assistantName: assistant?.name ?? '默认助手',
        updatedAt: lockedConversation.updatedAt || '',
      });
    }
    return base;
  }, [lockedConversation, resources.assistants, resources.cloudConversations]);

  const [name, setName] = useState('');
  const [timeValue, setTimeValue] = useState('09:00');
  const [weekdays, setWeekdays] = useState<number[]>([]);
  const [timezone, setTimezone] = useState<string>('UTC');
  const [timezoneEditing, setTimezoneEditing] = useState(false);
  const [runLimitMode, setRunLimitMode] = useState<'unlimited' | 'limited'>('unlimited');
  const [maxRunsText, setMaxRunsText] = useState('1');
  const [bindMode, setBindMode] = useState<ScheduleBindMode>('new');
  const [assistantId, setAssistantId] = useState('default');
  const [modelKey, setModelKey] = useState('');
  const [conversationId, setConversationId] = useState('');
  const [prompt, setPrompt] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{
    name?: string;
    time?: string;
    maxRuns?: string;
    target?: string;
    prompt?: string;
  }>({});

  const resolveDefaultModelKey = (targetAssistantId: string): string => {
    const asst = resources.assistants.find((a) => a.id === targetAssistantId);
    const preferred = [
      makeModelSelectionKey(defaultProviderId ?? '', defaultModelId ?? ''),
      makeModelSelectionKey(
        asst?.defaultProviderId ?? '',
        asst?.defaultModelId ?? '',
      ),
    ];
    for (const candidate of preferred) {
      if (candidate && cloudModels.some((m) => m.key === candidate)) {
        return candidate;
      }
    }
    return cloudModels.find((m) => m.usable)?.key ?? cloudModels[0]?.key ?? '';
  };

  useEffect(() => {
    if (!open) return;
    setSubmitError(null);
    setFieldErrors({});
    setTimezoneEditing(false);

    if (editingTask) {
      setName(editingTask.name);
      setTimeValue(formatAlarmTime(editingTask.hour, editingTask.minute));
      setWeekdays(normalizeWeekdays(editingTask.weekdays));
      setTimezone(editingTask.timezone || getDefaultTimezone());
      setRunLimitMode(editingTask.maxRuns > 0 ? 'limited' : 'unlimited');
      setMaxRunsText(editingTask.maxRuns > 0 ? String(editingTask.maxRuns) : '1');
      setBindMode(editingTask.bindMode);
      const nextAssistantId =
        editingTask.assistantId ||
        defaultAssistantId ||
        resources.assistants[0]?.id ||
        'default';
      setAssistantId(nextAssistantId);
      const editKey = makeModelSelectionKey(
        editingTask.providerId,
        editingTask.modelId,
      );
      setModelKey(
        cloudModels.some((m) => m.key === editKey)
          ? editKey
          : resolveDefaultModelKey(nextAssistantId),
      );
      setConversationId(editingTask.conversationId ?? '');
      setPrompt(editingTask.prompt);
      setEnabled(editingTask.enabled);
      return;
    }

    const initialAssistant =
      lockedConversation?.assistantId ||
      defaultAssistantId ||
      resources.assistants[0]?.id ||
      'default';
    setName('');
    setTimeValue('09:00');
    setWeekdays([]);
    setTimezone(getDefaultTimezone());
    setRunLimitMode('unlimited');
    setMaxRunsText('1');
    setBindMode(lockedConversation ? 'conversation' : 'new');
    setAssistantId(initialAssistant);
    setModelKey(resolveDefaultModelKey(initialAssistant));
    setConversationId(
      lockedConversation?.id ?? cloudAgentConversations[0]?.id ?? '',
    );
    setPrompt('');
    setEnabled(true);
    // Intentionally re-initialize only when dialog opens or target context changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editingTask?.id, lockedConversation?.id]);

  const handleToggleWeekday = (day: number) => {
    setWeekdays((prev) =>
      prev.includes(day)
        ? prev.filter((item) => item !== day)
        : normalizeWeekdays([...prev, day]),
    );
  };

  const handleAssistantChange = (nextAssistantId: string) => {
    setAssistantId(nextAssistantId);
    const asst = resources.assistants.find((a) => a.id === nextAssistantId);
    const asstModelKey = makeModelSelectionKey(
      asst?.defaultProviderId ?? '',
      asst?.defaultModelId ?? '',
    );
    if (asstModelKey && cloudModels.some((m) => m.key === asstModelKey)) {
      setModelKey(asstModelKey);
    }
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;

    const nextErrors: typeof fieldErrors = {};
    const trimmedName = name.trim();
    if (!trimmedName) {
      nextErrors.name = '请输入任务名称';
    }
    const parsedTime = parseTimeValue(timeValue);
    if (!parsedTime) {
      nextErrors.time = '请选择有效唤醒时间';
    }
    let nextMaxRuns = 0;
    if (runLimitMode === 'limited') {
      const parsedRuns = Number(maxRunsText);
      if (!Number.isInteger(parsedRuns) || parsedRuns < 1) {
        nextErrors.maxRuns = '执行次数须为正整数';
      } else {
        nextMaxRuns = parsedRuns;
      }
    }
    const parsedModel = parseModelSelectionKey(modelKey);
    const chosenConversationId =
      bindMode === 'conversation'
        ? (lockedConversation && !isEdit ? lockedConversation.id : conversationId)
        : '';

    if (bindMode === 'new') {
      if (!parsedModel) {
        nextErrors.target = '请先配置可用的云端模型';
      }
    } else if (!chosenConversationId) {
      nextErrors.target = '请选择绑定的 Agent 话题';
    }

    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt) {
      nextErrors.prompt = '请输入提示词';
    }

    if (Object.keys(nextErrors).length > 0 || !parsedTime) {
      setFieldErrors(nextErrors);
      return;
    }

    setFieldErrors({});
    setSubmitError(null);
    setBusy(true);
    const effectiveTimezone = timezone.trim() || 'UTC';

    try {
      let saved: ScheduledTask;
      if (editingTask) {
        const shouldResetCount =
          editingTask.maxRuns > 0 &&
          editingTask.runCount >= editingTask.maxRuns &&
          enabled &&
          nextMaxRuns > 0 &&
          nextMaxRuns <= editingTask.runCount;
        const patch: UpdateScheduledTaskInput = {
          name: trimmedName,
          prompt: trimmedPrompt,
          enabled,
          hour: parsedTime.hour,
          minute: parsedTime.minute,
          weekdays,
          timezone: effectiveTimezone,
          maxRuns: nextMaxRuns,
          ...(shouldResetCount ? { resetRunCount: true } : {}),
          bindMode,
          ...(bindMode === 'conversation'
            ? { conversationId: chosenConversationId }
            : {
                assistantId,
                providerId: parsedModel?.providerId ?? '',
                modelId: parsedModel?.modelId ?? '',
              }),
        };
        saved = await gateway.updateScheduledTask(
          editingTask.id,
          patch,
          undefined,
          scope,
        );
      } else {
        const payload: CreateScheduledTaskInput = {
          name: trimmedName,
          prompt: trimmedPrompt,
          enabled,
          hour: parsedTime.hour,
          minute: parsedTime.minute,
          weekdays,
          timezone: effectiveTimezone,
          maxRuns: nextMaxRuns,
          bindMode,
          ...(bindMode === 'conversation'
            ? { conversationId: chosenConversationId }
            : {
                assistantId,
                providerId: parsedModel?.providerId ?? '',
                modelId: parsedModel?.modelId ?? '',
              }),
        };
        saved = await gateway.createScheduledTask(payload, undefined, scope);
      }
      onSaved?.(saved);
      onOpenChange(false);
    } catch (err) {
      setSubmitError(formatScheduleError(err, '保存定时任务失败'));
    } finally {
      setBusy(false);
    }
  };

  const formId = `${baseId}-form`;
  const tzListId = `${baseId}-tz-list`;
  const lockedTargetOption = lockedConversation
    ? cloudAgentConversations.find((c) => c.id === lockedConversation.id)
    : undefined;

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      busy={busy}
      title={isEdit ? '编辑定时任务' : '新建定时任务'}
      footer={
        <>
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            取消
          </Button>
          <Button type="submit" form={formId} variant="primary" loading={busy}>
            {isEdit ? '保存' : '创建'}
          </Button>
        </>
      }
    >
      <form id={formId} className="sched-dialog" onSubmit={(e) => void handleSubmit(e)}>
        {submitError ? <ErrorBanner message={submitError} /> : null}

        <Field
          label="任务名称"
          htmlFor={`${baseId}-name`}
          error={fieldErrors.name}
        >
          <Input
            id={`${baseId}-name`}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如：每日简报"
            disabled={busy}
            autoFocus
          />
        </Field>

        <Field label="唤醒时间" htmlFor={`${baseId}-time`} error={fieldErrors.time}>
          <div className="sched-time-card">
            <div className="sched-time-card__top">
              <input
                id={`${baseId}-time`}
                type="time"
                aria-label="唤醒时间"
                className="sched-time-input"
                value={timeValue}
                disabled={busy}
                onChange={(e) => setTimeValue(e.target.value)}
              />
              <div className="sched-time-meta">
                <span className="sched-repeat-pill">
                  {formatWeekdays(weekdays)}
                </span>
                <button
                  type="button"
                  className="sched-tz-chip"
                  aria-label="修改时区"
                  aria-expanded={timezoneEditing}
                  disabled={busy}
                  onClick={() => setTimezoneEditing((v) => !v)}
                >
                  <span className="sched-tz-chip__text">{timezone || 'UTC'}</span>
                  <Icon name="edit" size={11} />
                </button>
              </div>
            </div>

            <div className="sched-weekdays" role="group" aria-label="重复周期">
              {WEEKDAY_PILLS.map((pill) => {
                const pressed = weekdays.includes(pill.value);
                return (
                  <button
                    key={pill.value}
                    type="button"
                    className="sched-weekday-btn"
                    aria-label={pill.full}
                    aria-pressed={pressed}
                    disabled={busy}
                    onClick={() => handleToggleWeekday(pill.value)}
                  >
                    {pill.short}
                  </button>
                );
              })}
            </div>

            {timezoneEditing ? (
              <div className="sched-tz-editor">
                <Input
                  compact
                  list={tzListId}
                  aria-label="IANA 时区"
                  value={timezone}
                  disabled={busy}
                  placeholder="Asia/Shanghai"
                  onChange={(e) => setTimezone(e.target.value)}
                />
                <datalist id={tzListId}>
                  {COMMON_TIMEZONES.map((tz) => (
                    <option key={tz} value={tz} />
                  ))}
                </datalist>
              </div>
            ) : null}
          </div>
        </Field>

        <Field
          label="执行次数"
          htmlFor={`${baseId}-quota`}
          error={fieldErrors.maxRuns}
        >
          <div className="sched-inline-row">
            <SegmentedControl<'unlimited' | 'limited'>
              ariaLabel="执行次数模式"
              value={runLimitMode}
              disabled={busy}
              onChange={(next) => {
                setRunLimitMode(next);
                if (next === 'limited' && (!maxRunsText || Number(maxRunsText) < 1)) {
                  setMaxRunsText('1');
                }
              }}
              options={[
                { value: 'unlimited', label: '持续' },
                { value: 'limited', label: '定次' },
              ]}
            />
            {runLimitMode === 'limited' ? (
              <Input
                id={`${baseId}-quota`}
                compact
                type="number"
                min={1}
                max={9999}
                aria-label="最大执行次数"
                className="sched-quota-input"
                value={maxRunsText}
                disabled={busy}
                onChange={(e) => setMaxRunsText(e.target.value)}
              />
            ) : null}
          </div>
        </Field>

        <Field label="执行目标" error={fieldErrors.target}>
          <div className="sched-target-stack">
            {lockedConversation && !isEdit ? (
              <div className="sched-locked-topic">
                <Icon name="terminal" size={14} />
                <span className="sched-locked-topic__title">
                  {lockedTargetOption
                    ? `${lockedTargetOption.title} · ${lockedTargetOption.assistantName}`
                    : lockedConversation.title || '当前话题'}
                </span>
              </div>
            ) : (
              <>
                <SegmentedControl<ScheduleBindMode>
                  ariaLabel="执行目标模式"
                  value={bindMode}
                  disabled={busy}
                  onChange={(next) => {
                    setBindMode(next);
                    if (next === 'conversation' && !conversationId) {
                      setConversationId(cloudAgentConversations[0]?.id ?? '');
                    }
                  }}
                  options={[
                    { value: 'new', label: '新建话题' },
                    { value: 'conversation', label: '绑定话题' },
                  ]}
                />

                {bindMode === 'new' ? (
                  <div className="sched-grid-2">
                    <Select
                      aria-label="助手"
                      value={assistantId}
                      disabled={busy}
                      onChange={(e) => handleAssistantChange(e.target.value)}
                    >
                      {resources.assistants.map((asst) => (
                        <option key={asst.id} value={asst.id}>
                          {asst.name}
                        </option>
                      ))}
                    </Select>
                    <Select
                      aria-label="云端模型"
                      value={modelKey}
                      disabled={busy || cloudModels.length === 0}
                      onChange={(e) => setModelKey(e.target.value)}
                    >
                      {cloudModels.length === 0 ? (
                        <option value="">无可用云端模型</option>
                      ) : (
                        cloudModels.map((item) => (
                          <option key={item.key} value={item.key}>
                            {item.model.name || item.model.id} · {item.provider.name}
                          </option>
                        ))
                      )}
                    </Select>
                  </div>
                ) : (
                  <Select
                    aria-label="目标 Agent 话题"
                    value={conversationId}
                    disabled={busy || cloudAgentConversations.length === 0}
                    onChange={(e) => setConversationId(e.target.value)}
                  >
                    {cloudAgentConversations.length === 0 ? (
                      <option value="">无可用云端 Agent 话题</option>
                    ) : (
                      <>
                        {!conversationId ? (
                          <option value="">选择 Agent 话题</option>
                        ) : null}
                        {cloudAgentConversations.map((conv) => (
                          <option key={conv.id} value={conv.id}>
                            {conv.title} · {conv.assistantName}
                          </option>
                        ))}
                      </>
                    )}
                  </Select>
                )}
              </>
            )}
          </div>
        </Field>

        <Field
          label="提示词"
          htmlFor={`${baseId}-prompt`}
          error={fieldErrors.prompt}
        >
          <Textarea
            id={`${baseId}-prompt`}
            rows={4}
            value={prompt}
            disabled={busy}
            placeholder="到达设定时间后向 Agent 发送的指令"
            onChange={(e) => setPrompt(e.target.value)}
          />
        </Field>

        {isEdit ? (
          <div className="sched-inline-row" style={{ justifyContent: 'space-between' }}>
            <span className="ui-field__label">启用状态</span>
            <Switch
              checked={enabled}
              label="启用定时任务"
              disabled={busy}
              onCheckedChange={setEnabled}
            />
          </div>
        ) : null}
      </form>
    </Modal>
  );
}
