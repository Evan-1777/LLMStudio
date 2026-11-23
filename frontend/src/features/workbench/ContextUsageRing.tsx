import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { Button, Icon, LoadingSpinner, Popover } from '../../components/ui';
import { formatCompactTokens, type ContextUsageSnapshot } from './contextUsage';

const RING_RADIUS = 6.75;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

const SOURCE_LABELS = {
  reported: '实测',
  hybrid: '实测+估算',
  estimated: '估算',
} as const;

export interface ContextUsageRingProps {
  usage: ContextUsageSnapshot;
  onCompact?: () => Promise<void> | void;
  canCompact?: boolean;
  isCompacting?: boolean;
  triggerTabIndex?: number;
}

export function ContextUsageRing({
  usage,
  onCompact,
  canCompact = false,
  isCompacting = false,
  triggerTabIndex,
}: ContextUsageRingProps) {
  const [openMode, setOpenMode] = useState<'hover' | 'focus' | 'pinned' | null>(
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

  const triggerLabel =
    usage.percent !== null
      ? `${usage.percent}%`
      : usage.usedTokens > 0
        ? formatCompactTokens(usage.usedTokens)
        : '';

  const showSecondaryStats =
    usage.sessionTotalTokens > 0 || usage.sessionCacheReadTokens > 0;
  const compactDisabled = !canCompact || isCompacting;
  const compactTitle = isCompacting
    ? '正在压缩上下文'
    : canCompact
      ? '压缩早先对话历史以释放上下文窗口'
      : '至少需要一轮完整对话（≥ 2 条有效消息）才可压缩';

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
          tabIndex={triggerTabIndex}
          data-level={level}
          data-compacting={isCompacting ? 'true' : undefined}
          aria-label={summaryLabel}
          aria-busy={isCompacting || undefined}
          aria-expanded={openMode !== null}
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
              setOpenMode((mode) => mode ?? 'focus');
            }
          }}
          onBlur={() =>
            setOpenMode((mode) => (mode === 'focus' ? null : mode))
          }
          onClick={(event) => {
            event.preventDefault();
            cancelClose();
            setOpenMode((mode) => (mode === 'pinned' ? null : 'pinned'));
            lastPointerType.current = '';
          }}
        >
          <svg
            width={18}
            height={18}
            viewBox="0 0 18 18"
            className={`wb-ctx-ring ${isCompacting ? 'wb-ctx-ring--spinning' : ''}`.trim()}
            aria-hidden="true"
          >
            <circle
              cx={9}
              cy={9}
              r={RING_RADIUS}
              fill="none"
              strokeWidth={2}
              stroke={
                usage.contextWindow === null
                  ? 'var(--text-tertiary)'
                  : 'var(--border-strong)'
              }
              strokeDasharray={
                isCompacting
                  ? '14 28'
                  : usage.contextWindow === null
                    ? '2.5 2.5'
                    : undefined
              }
              opacity={usage.contextWindow === null && !isCompacting ? 0.55 : 0.45}
            />
            {isCompacting ? (
              <circle
                cx={9}
                cy={9}
                r={RING_RADIUS}
                fill="none"
                strokeWidth={2}
                strokeLinecap="round"
                stroke="var(--accent)"
                strokeDasharray={`${RING_CIRCUMFERENCE * 0.32} ${RING_CIRCUMFERENCE}`}
                transform="rotate(-90 9 9)"
              />
            ) : usage.contextWindow !== null && ratio > 0 ? (
              <circle
                cx={9}
                cy={9}
                r={RING_RADIUS}
                fill="none"
                strokeWidth={2}
                strokeLinecap="round"
                className="wb-ctx-ring__arc"
                stroke={levelColor}
                strokeDasharray={RING_CIRCUMFERENCE}
                strokeDashoffset={dashOffset}
                transform="rotate(-90 9 9)"
              />
            ) : null}
          </svg>
          {triggerLabel ? (
            <span className="wb-ctx-ring-label">{triggerLabel}</span>
          ) : null}
        </button>
      }
    >
      <div className="wb-ctx-popover">
        <div className="wb-ctx-popover__head">
          <span className="wb-ctx-popover__title">上下文</span>
          <span className="wb-ctx-source-badge">
            {SOURCE_LABELS[usage.source]}
          </span>
        </div>

        <div className="wb-ctx-popover__hero">
          <span
            className="wb-ctx-popover__metric"
            style={{
              color: level === 'unknown' ? 'var(--text-primary)' : levelColor,
            }}
          >
            {usage.percent !== null
              ? `${usage.percent}%`
              : formatCompactTokens(usage.usedTokens)}
          </span>
          <span className="wb-ctx-popover__fraction">
            {usage.contextWindow !== null
              ? `${formatCompactTokens(usage.usedTokens)} / ${formatCompactTokens(usage.contextWindow)}`
              : '未配置上限'}
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

        <div className="wb-ctx-divider" />

        <div className="wb-ctx-rows">
          <div className="wb-ctx-row">
            <span>当前占用</span>
            <span>{usage.usedTokens.toLocaleString()}</span>
          </div>
          {usage.remainingTokens !== null ? (
            <div className="wb-ctx-row">
              <span>剩余可用</span>
              <span>{usage.remainingTokens.toLocaleString()}</span>
            </div>
          ) : null}
          {usage.draftTokens > 0 ? (
            <div className="wb-ctx-row">
              <span>草稿估算</span>
              <span>{usage.draftTokens.toLocaleString()}</span>
            </div>
          ) : null}
          <div className="wb-ctx-row">
            <span className="wb-ctx-row__label-wrap">
              <span>有效消息</span>
              {usage.compactedCount > 0 ? (
                <span className="wb-ctx-compacted-tag">
                  已折叠 {usage.compactedCount} 条
                </span>
              ) : null}
            </span>
            <span>{usage.activeMessageCount}</span>
          </div>
        </div>

        {showSecondaryStats ? (
          <>
            <div className="wb-ctx-divider" />
            <div className="wb-ctx-rows wb-ctx-rows--secondary">
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
          </>
        ) : null}

        {onCompact ? (
          <>
            <div className="wb-ctx-divider" />
            <Button
              variant="secondary"
              size="sm"
              className="wb-ctx-compact-btn"
              disabled={compactDisabled}
              aria-disabled={compactDisabled || undefined}
              title={compactTitle}
              onClick={() => void onCompact()}
            >
              {isCompacting ? (
                <>
                  <LoadingSpinner size="sm" />
                  <span>正在压缩…</span>
                </>
              ) : (
                <>
                  <Icon name="compress" size={14} />
                  <span>压缩上下文</span>
                </>
              )}
            </Button>
          </>
        ) : null}
      </div>
    </Popover>
  );
}
