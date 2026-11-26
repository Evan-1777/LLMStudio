import { useCallback, useEffect, useState } from 'react';
import { useApp } from '../../app/AppProvider';
import {
  Button,
  ErrorBanner,
  Icon,
  IconButton,
  LoadingSpinner,
  Switch,
} from '../../components/ui';
import type { Conversation, ScheduledTask, TopicScope } from '../../core/types';
import {
  formatAlarmTime,
  formatLastStatus,
  formatRunProgress,
  formatScheduleError,
  formatWeekdays,
} from './scheduleFormat';
import './schedule.css';

export interface TopicScheduleListProps {
  conversation: Conversation;
  scope?: TopicScope;
  refreshTrigger: number;
  onCreateNew: () => void;
  onEditTask: (task: ScheduledTask) => void;
  onDeleteTask: (task: ScheduledTask) => void;
  onReloadActiveConversation: () => Promise<void>;
  onSchedulesChanged: () => void;
}

export function TopicScheduleList({
  conversation,
  scope,
  refreshTrigger,
  onCreateNew,
  onEditTask,
  onDeleteTask,
  onReloadActiveConversation,
  onSchedulesChanged,
}: TopicScheduleListProps) {
  const { gateway, markConversationRunning, toast } = useApp();
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadSeq, setReloadSeq] = useState(0);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [runningId, setRunningId] = useState<string | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    gateway
      .listScheduledTasks(conversation.id, ctrl.signal, scope)
      .then((list) => {
        if (ctrl.signal.aborted) return;
        setTasks(list);
      })
      .catch((err) => {
        if (ctrl.signal.aborted) return;
        setError(formatScheduleError(err, '加载话题定时任务失败'));
      })
      .finally(() => {
        if (!ctrl.signal.aborted) {
          setLoading(false);
        }
      });
    return () => ctrl.abort();
  }, [conversation.id, gateway, refreshTrigger, reloadSeq, scope]);

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
        onSchedulesChanged();
        await onReloadActiveConversation();
      } catch (err) {
        toast(formatScheduleError(err, '触发任务失败'), 'error');
      } finally {
        setRunningId(null);
      }
    },
    [
      gateway,
      markConversationRunning,
      onReloadActiveConversation,
      onSchedulesChanged,
      runningId,
      scope,
      toast,
    ],
  );

  return (
    <div className="sched-topic-list">
      <div className="sched-topic-list__head">
        <span className="sched-topic-list__title">
          <Icon name="alarmClock" size={14} />
          <span>话题定时任务</span>
        </span>
      </div>

      {loading && tasks.length === 0 ? (
        <div className="sched-topic-list__empty">
          <LoadingSpinner size="sm" label="加载中" />
        </div>
      ) : error && tasks.length === 0 ? (
        <ErrorBanner message={error} onRetry={() => setReloadSeq((n) => n + 1)} />
      ) : tasks.length === 0 ? (
        <div className="sched-topic-list__empty">暂无绑定定时任务</div>
      ) : (
        <div className="sched-topic-list__items" role="list">
          {tasks.map((task) => {
            const statusInfo = formatLastStatus(task.lastStatus);
            return (
              <div key={task.id} role="listitem" className="sched-topic-item">
                <div className="sched-topic-item__top">
                  <div className="sched-card__clock-wrap">
                    <span className="sched-topic-item__clock">
                      {formatAlarmTime(task.hour, task.minute)}
                    </span>
                    <span className="sched-topic-item__name" title={task.name}>
                      {task.name}
                    </span>
                  </div>
                  <Switch
                    checked={task.enabled}
                    label={`${task.enabled ? '停用' : '启用'} ${task.name}`}
                    disabled={togglingId === task.id}
                    onCheckedChange={(checked) =>
                      void handleToggle(task, checked)
                    }
                  />
                </div>
                <div className="sched-topic-item__bottom">
                  <span className="sched-topic-item__meta">
                    {formatWeekdays(task.weekdays)} ·{' '}
                    {formatRunProgress(task.runCount, task.maxRuns)}
                    {statusInfo.label ? ` · ${statusInfo.label}` : ''}
                  </span>
                  <div className="sched-card__actions">
                    <IconButton
                      size="sm"
                      icon="play"
                      label={`立即执行 ${task.name}`}
                      loading={runningId === task.id}
                      disabled={
                        task.lastStatus === 'running' || Boolean(runningId)
                      }
                      onClick={() => void handleRunNow(task)}
                    />
                    <IconButton
                      size="sm"
                      icon="edit"
                      label={`编辑 ${task.name}`}
                      onClick={() => onEditTask(task)}
                    />
                    <IconButton
                      size="sm"
                      icon="trash"
                      tone="danger"
                      label={`删除 ${task.name}`}
                      onClick={() => onDeleteTask(task)}
                    />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="sched-topic-list__foot">
        <Button variant="secondary" size="sm" onClick={onCreateNew}>
          <Icon name="plus" size={14} />
          <span>新建绑定任务</span>
        </Button>
      </div>
    </div>
  );
}
