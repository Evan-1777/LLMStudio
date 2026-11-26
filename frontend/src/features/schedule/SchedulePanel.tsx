import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../../app/AppProvider';
import {
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorBanner,
  Icon,
  IconButton,
  LoadingSpinner,
  SegmentedControl,
  Switch,
} from '../../components/ui';
import type { ScheduledTask, TopicScope } from '../../core/types';
import { ScheduleDialog } from './ScheduleDialog';
import {
  formatAlarmTime,
  formatLastStatus,
  formatNextRunLabel,
  formatRunProgress,
  formatScheduleError,
  formatWeekdays,
} from './scheduleFormat';
import './schedule.css';

type FilterMode = 'all' | 'enabled' | 'disabled';

export interface SchedulePanelProps {
  scope?: TopicScope;
  cloudOffline: boolean;
  activeConversationId: string | null;
  defaultAssistantId?: string;
  defaultProviderId?: string;
  defaultModelId?: string;
  refreshTrigger: number;
  createTrigger: number;
  onOpenConversation: (conversationId: string) => void;
  onReloadActiveConversation: () => Promise<void>;
  onSchedulesChanged: () => void;
}

export function SchedulePanel({
  scope,
  cloudOffline,
  activeConversationId,
  defaultAssistantId,
  defaultProviderId,
  defaultModelId,
  refreshTrigger,
  createTrigger,
  onOpenConversation,
  onReloadActiveConversation,
  onSchedulesChanged,
}: SchedulePanelProps) {
  const {
    gateway,
    connectionEpoch,
    resources,
    refreshConversations,
    markConversationRunning,
    toast,
  } = useApp();

  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterMode>('all');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<ScheduledTask | null>(null);
  const [deletingTask, setDeletingTask] = useState<ScheduledTask | null>(null);
  const [deletingBusy, setDeletingBusy] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [reloadSeq, setReloadSeq] = useState(0);
  const lastCreateTriggerRef = useRef(createTrigger);

  useEffect(() => {
    if (createTrigger === lastCreateTriggerRef.current) return;
    lastCreateTriggerRef.current = createTrigger;
    if (cloudOffline) return;
    setEditingTask(null);
    setDialogOpen(true);
  }, [cloudOffline, createTrigger]);

  useEffect(() => {
    if (cloudOffline) {
      setLoading(false);
      setError(null);
      return;
    }
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    gateway
      .listScheduledTasks(undefined, ctrl.signal, scope)
      .then((list) => {
        if (ctrl.signal.aborted) return;
        setTasks(list);
      })
      .catch((err) => {
        if (ctrl.signal.aborted) return;
        setError(formatScheduleError(err, '加载定时任务失败'));
      })
      .finally(() => {
        if (!ctrl.signal.aborted) {
          setLoading(false);
        }
      });
    return () => ctrl.abort();
  }, [cloudOffline, connectionEpoch, gateway, refreshTrigger, reloadSeq, scope]);

  const cloudConvMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const conv of resources.cloudConversations) {
      map.set(conv.id, conv.title || '未命名话题');
    }
    return map;
  }, [resources.cloudConversations]);

  const filteredTasks = useMemo(() => {
    if (filter === 'enabled') return tasks.filter((t) => t.enabled);
    if (filter === 'disabled') return tasks.filter((t) => !t.enabled);
    return tasks;
  }, [filter, tasks]);

  const handleToggle = useCallback(
    async (task: ScheduledTask, nextEnabled: boolean) => {
      if (togglingId) return;
      setTogglingId(task.id);
      const resetExhausted =
        nextEnabled && task.maxRuns > 0 && task.runCount >= task.maxRuns;
      try {
        const updated = await gateway.updateScheduledTask(
          task.id,
          {
            enabled: nextEnabled,
            ...(resetExhausted ? { resetRunCount: true } : {}),
          },
          undefined,
          scope,
        );
        setTasks((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
        onSchedulesChanged();
      } catch (err) {
        toast(formatScheduleError(err, '切换状态失败'), 'error');
      } finally {
        setTogglingId(null);
      }
    },
    [gateway, onSchedulesChanged, scope, toast, togglingId],
  );

  const handleRunNow = useCallback(
    async (task: ScheduledTask) => {
      if (runningId) return;
      setRunningId(task.id);
      try {
        const res = await gateway.runScheduledTaskNow(task.id, undefined, scope);
        setTasks((prev) =>
          prev.map((t) => (t.id === res.schedule.id ? res.schedule : t)),
        );
        if (res.conversationId) {
          markConversationRunning(res.conversationId, true, 'cloud');
        }
        await refreshConversations(scope);
        onSchedulesChanged();
        if (res.conversationId && res.conversationId === activeConversationId) {
          await onReloadActiveConversation();
        } else if (res.conversationId) {
          toast(`已触发「${task.name}」`, {
            action: {
              label: '查看话题',
              onClick: () => onOpenConversation(res.conversationId),
            },
          });
        }
      } catch (err) {
        toast(formatScheduleError(err, '触发任务失败'), 'error');
      } finally {
        setRunningId(null);
      }
    },
    [
      activeConversationId,
      gateway,
      markConversationRunning,
      onOpenConversation,
      onReloadActiveConversation,
      onSchedulesChanged,
      refreshConversations,
      runningId,
      scope,
      toast,
    ],
  );

  const handleConfirmDelete = useCallback(async () => {
    if (!deletingTask || deletingBusy) return;
    setDeletingBusy(true);
    try {
      await gateway.deleteScheduledTask(deletingTask.id, undefined, scope);
      setTasks((prev) => prev.filter((t) => t.id !== deletingTask.id));
      setDeletingTask(null);
      onSchedulesChanged();
    } catch (err) {
      toast(formatScheduleError(err, '删除失败'), 'error');
    } finally {
      setDeletingBusy(false);
    }
  }, [deletingBusy, deletingTask, gateway, onSchedulesChanged, scope, toast]);

  if (cloudOffline) {
    return (
      <div className="sched-panel">
        <div className="sched-panel__center">
          <EmptyState icon="cloud" title="云端离线" />
        </div>
      </div>
    );
  }

  return (
    <div className="sched-panel">
      <div className="sched-panel__filter">
        <SegmentedControl<FilterMode>
          ariaLabel="定时任务筛选"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: '全部' },
            { value: 'enabled', label: '启用' },
            { value: 'disabled', label: '停用' },
          ]}
        />
      </div>

      {loading && tasks.length === 0 ? (
        <div className="sched-panel__center">
          <LoadingSpinner label="加载定时任务" />
        </div>
      ) : error && tasks.length === 0 ? (
        <div className="sched-panel__center">
          <ErrorBanner
            message={error}
            onRetry={() => setReloadSeq((n) => n + 1)}
          />
        </div>
      ) : filteredTasks.length === 0 ? (
        <div className="sched-panel__center">
          <EmptyState
            icon="alarmClock"
            title={tasks.length === 0 ? '暂无定时任务' : '无匹配定时任务'}
            action={
              tasks.length === 0 ? (
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => {
                    setEditingTask(null);
                    setDialogOpen(true);
                  }}
                >
                  新建定时任务
                </Button>
              ) : undefined
            }
          />
        </div>
      ) : (
        <div className="sched-panel__list" role="list" aria-label="定时任务列表">
          {filteredTasks.map((task) => {
            const statusInfo = formatLastStatus(task.lastStatus);
            const nextLabel = task.enabled
              ? formatNextRunLabel(task.nextRunAt)
              : '';
            const boundConvExists = Boolean(
              task.bindMode === 'conversation' &&
                task.conversationId &&
                cloudConvMap.has(task.conversationId),
            );
            const boundTitle =
              task.conversationId && cloudConvMap.get(task.conversationId)
                ? cloudConvMap.get(task.conversationId)!
                : task.conversationTitle || '';
            const lastConvExists = Boolean(
              task.lastConversationId && cloudConvMap.has(task.lastConversationId),
            );

            return (
              <article
                key={task.id}
                role="listitem"
                className={`sched-card ${!task.enabled ? 'sched-card--disabled' : ''}`.trim()}
              >
                <div className="sched-card__head">
                  <div className="sched-card__clock-wrap">
                    <span className="sched-card__clock">
                      {formatAlarmTime(task.hour, task.minute)}
                    </span>
                    <span className="sched-card__name" title={task.name}>
                      {task.name}
                    </span>
                  </div>
                  <Switch
                    checked={task.enabled}
                    label={`${task.enabled ? '停用' : '启用'} ${task.name}`}
                    disabled={togglingId === task.id}
                    onCheckedChange={(checked) => void handleToggle(task, checked)}
                  />
                </div>

                <div className="sched-card__meta">
                  <span>{formatWeekdays(task.weekdays)}</span>
                  <span className="sched-card__dot-sep" aria-hidden="true">
                    ·
                  </span>
                  <span>{formatRunProgress(task.runCount, task.maxRuns)}</span>
                  {nextLabel ? (
                    <>
                      <span className="sched-card__dot-sep" aria-hidden="true">
                        ·
                      </span>
                      <span>下次 {nextLabel}</span>
                    </>
                  ) : null}
                </div>

                <div>
                  {task.bindMode === 'new' ? (
                    <span className="sched-card__target">
                      <Icon name="plus" size={12} />
                      <span className="sched-card__target-text">新建 Agent 话题</span>
                    </span>
                  ) : boundConvExists && task.conversationId ? (
                    <button
                      type="button"
                      className="sched-card__target sched-card__target--link"
                      title={boundTitle}
                      onClick={() => onOpenConversation(task.conversationId!)}
                    >
                      <Icon name="terminal" size={12} />
                      <span className="sched-card__target-text">{boundTitle}</span>
                      <Icon name="chevronRight" size={12} />
                    </button>
                  ) : !task.conversationId ? (
                    <span className="sched-card__target sched-card__target--missing">
                      <Icon name="warning" size={12} />
                      <span className="sched-card__target-text">绑定话题已删除</span>
                    </span>
                  ) : (
                    <span className="sched-card__target">
                      <Icon name="terminal" size={12} />
                      <span className="sched-card__target-text">
                        {boundTitle || '已绑定话题'}
                      </span>
                    </span>
                  )}
                </div>

                {task.lastError ? (
                  <div className="sched-card__error" title={task.lastError}>
                    {task.lastError}
                  </div>
                ) : null}

                <div className="sched-card__foot">
                  <div className="sched-card__status-group">
                    {statusInfo.label ? (
                      <span
                        className={`sched-status-pill sched-status-pill--${statusInfo.tone}`}
                      >
                        {statusInfo.label}
                      </span>
                    ) : null}
                    {lastConvExists && task.lastConversationId ? (
                      <IconButton
                        size="sm"
                        icon="messageSquare"
                        label="打开最近执行话题"
                        onClick={() => onOpenConversation(task.lastConversationId!)}
                      />
                    ) : null}
                  </div>

                  <div className="sched-card__actions">
                    <IconButton
                      size="sm"
                      icon="play"
                      label={`立即执行 ${task.name}`}
                      loading={runningId === task.id}
                      disabled={task.lastStatus === 'running' || Boolean(runningId)}
                      onClick={() => void handleRunNow(task)}
                    />
                    <IconButton
                      size="sm"
                      icon="edit"
                      label={`编辑 ${task.name}`}
                      onClick={() => {
                        setEditingTask(task);
                        setDialogOpen(true);
                      }}
                    />
                    <IconButton
                      size="sm"
                      icon="trash"
                      tone="danger"
                      label={`删除 ${task.name}`}
                      onClick={() => setDeletingTask(task)}
                    />
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}

      <ScheduleDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        editingTask={editingTask}
        defaultAssistantId={defaultAssistantId}
        defaultProviderId={defaultProviderId}
        defaultModelId={defaultModelId}
        scope={scope}
        onSaved={(saved) => {
          setTasks((prev) => {
            const exists = prev.some((t) => t.id === saved.id);
            return exists
              ? prev.map((t) => (t.id === saved.id ? saved : t))
              : [saved, ...prev];
          });
          onSchedulesChanged();
        }}
      />

      <ConfirmDialog
        open={deletingTask !== null}
        onOpenChange={(open) => {
          if (!open && !deletingBusy) setDeletingTask(null);
        }}
        title="删除定时任务"
        message={
          deletingTask
            ? `确定删除「${deletingTask.name}」吗？此操作不可撤销。`
            : ''
        }
        confirmLabel="删除"
        busy={deletingBusy}
        onConfirm={handleConfirmDelete}
      />
    </div>
  );
}
