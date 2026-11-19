import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { Popover } from '../../components/ui';
import { formatCompactTokens, type ContextUsageSnapshot } from './contextUsage';

const RING_RADIUS = 7.5;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

const SOURCE_LABELS = {
  reported: '真实用量',
  hybrid: '实测+估算',
  estimated: '字符估算',
} as const;

export function ContextUsageRing({ usage }: { usage: ContextUsageSnapshot }) {
  const [openMode, setOpenMode] = useState<'hover' | 'focus' | 'touch' | null>(
    null,
  );
  const lastPointerType = useRef('');
  const closeTimer = useRef<number>(undefined);

  const cancelClose = () => window.clearTimeout(closeTimer.current);
  useEffect(() => () => window.clearTimeout(closeTimer.current), []);

  const hoverOpen = (event: PointerEvent) => {
    if (event.pointerType === 'touch') return;
    cancelClose();
    setOpenMode((mode) => mode ?? 'hover');
  };

  const leaveClose = (event: PointerEvent) => {
    if (event.pointerType === 'touch') return;
    cancelClose();
    closeTimer.current = window.setTimeout(
      () => setOpenMode((mode) => (mode === 'hover' ? null : mode)),
      120,
    );
  };

  const level =
    usage.rawPercent === null
      ? 'unknown'
      : usage.rawPercent >= 90
        ? 'danger'
        : usage.rawPercent >= 70
          ? 'warning'
          : 'normal';

  const levelColor =
    level === 'danger'
      ? 'var(--danger)'
      : level === 'warning'
        ? 'var(--warning)'
        : 'var(--accent)';

  const ratio = usage.ratio ?? 0;
  const dashOffset = RING_CIRCUMFERENCE * (1 - ratio);

  const summaryLabel =
    usage.percent !== null
      ? `上下文占用 ${usage.percent}%（${formatCompactTokens(usage.usedTokens)} / ${formatCompactTokens(usage.contextWindow!)}）`
      : `上下文已用 ${formatCompactTokens(usage.usedTokens)}（未配置上限）`;

  return (
    <Popover
      side="top"
      align="end"
      open={openMode !== null}
      onOpenChange={(open) => {
        if (!open) setOpenMode(null);
      }}
      contentProps={{
        'aria-label': '上下文占用明细',
        onPointerEnter: hoverOpen,
        onPointerLeave: leaveClose,
        onOpenAutoFocus: (event) => event.preventDefault(),
        onCloseAutoFocus: (event) => event.preventDefault(),
      }}
      trigger={
        <button
          type="button"
          className="wb-ctx-ring-btn"
          data-level={level}
          aria-label={summaryLabel}
          onPointerEnter={hoverOpen}
          onPointerLeave={leaveClose}
          onPointerDown={(event) => {
            lastPointerType.current = event.pointerType;
            if (event.pointerType !== 'touch') event.preventDefault();
          }}
          onPointerCancel={() => {
            lastPointerType.current = '';
          }}
          onFocus={(event) => {
            if (
              lastPointerType.current !== 'touch' &&
              event.currentTarget.matches(':focus-visible')
            ) {
              setOpenMode('focus');
            }
          }}
          onBlur={() =>
            setOpenMode((mode) => (mode === 'focus' ? null : mode))
          }
          onClick={(event) => {
            event.preventDefault();
            if (lastPointerType.current === 'touch') {
              setOpenMode((mode) => (mode === 'touch' ? null : 'touch'));
            } else if (event.detail === 0) {
              setOpenMode('focus');
            }
            lastPointerType.current = '';
          }}
        >
          <svg
            width={20}
            height={20}
            viewBox="0 0 20 20"
            className="wb-ctx-ring"
            aria-hidden="true"
          >
            <circle
              cx={10}
              cy={10}
              r={RING_RADIUS}
              fill="none"
              strokeWidth={2.1}
              stroke={
                usage.contextWindow === null
                  ? 'var(--text-tertiary)'
                  : 'var(--border-strong)'
              }
              strokeDasharray={usage.contextWindow === null ? '2.5 2.5' : undefined}
              opacity={usage.contextWindow === null ? 0.55 : 0.45}
            />
            {usage.contextWindow !== null && ratio > 0 ? (
              <circle
                cx={10}
                cy={10}
                r={RING_RADIUS}
                fill="none"
                strokeWidth={2.1}
                strokeLinecap="round"
                stroke={levelColor}
                strokeDasharray={RING_CIRCUMFERENCE}
                strokeDashoffset={dashOffset}
                transform="rotate(-90 10 10)"
              />
            ) : null}
          </svg>
        </button>
      }
    >
      <div className="wb-ctx-popover">
        <div className="wb-ctx-popover__head">
          <span>上下文窗口</span>
          <span style={{ color: level === 'unknown' ? 'var(--text-secondary)' : levelColor }}>
            {usage.percent !== null ? `${usage.percent}%` : '未配置上限'}
          </span>
        </div>

        <div className="wb-ctx-bar" aria-hidden="true">
          <div
            className="wb-ctx-bar__fill"
            style={{
              width: `${Math.round(ratio * 100)}%`,
              backgroundColor:
                usage.contextWindow === null ? 'var(--text-tertiary)' : levelColor,
            }}
          />
        </div>

        <div className="wb-ctx-rows">
          <div className="wb-ctx-row">
            <span>当前上下文（{SOURCE_LABELS[usage.source]}）</span>
            <span>{usage.usedTokens.toLocaleString()}</span>
          </div>
          <div className="wb-ctx-row">
            <span>窗口上限</span>
            <span>
              {usage.contextWindow !== null
                ? usage.contextWindow.toLocaleString()
                : '未配置'}
            </span>
          </div>
          <div className="wb-ctx-row">
            <span>剩余可用</span>
            <span>
              {usage.remainingTokens !== null
                ? usage.remainingTokens.toLocaleString()
                : '—'}
            </span>
          </div>
          {usage.draftTokens > 0 ? (
            <div className="wb-ctx-row">
              <span>草稿估算</span>
              <span>{usage.draftTokens.toLocaleString()}</span>
            </div>
          ) : null}
          <div className="wb-ctx-row">
            <span>消息数</span>
            <span>{usage.messageCount}</span>
          </div>
          {usage.sessionTotalTokens > 0 ? (
            <div className="wb-ctx-row">
              <span>累计消耗</span>
              <span>{usage.sessionTotalTokens.toLocaleString()}</span>
            </div>
          ) : null}
          {usage.sessionCacheReadTokens > 0 ? (
            <div className="wb-ctx-row">
              <span>缓存命中</span>
              <span>{usage.sessionCacheReadTokens.toLocaleString()}</span>
            </div>
          ) : null}
        </div>
      </div>
    </Popover>
  );
}
