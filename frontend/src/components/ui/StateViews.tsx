import type { ReactNode } from 'react';
import { Button } from './Button';
import { Icon, type IconName } from './Icon';

export function LoadingSpinner({
  label,
  size = 'md',
}: {
  label?: string;
  size?: 'sm' | 'md';
}) {
  return (
    <span
      role="status"
      aria-label={!label ? '加载中' : undefined}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}
    >
      <span
        className={`ui-spinner ${size === 'sm' ? 'ui-spinner--sm' : ''}`.trim()}
        aria-hidden="true"
      />
      {label ? (
        <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
          {label}
        </span>
      ) : null}
    </span>
  );
}

export function EmptyState({
  icon,
  title,
  action,
}: {
  icon?: IconName;
  title: string;
  action?: ReactNode;
}) {
  return (
    <div className="ui-empty-state">
      {icon ? <Icon name={icon} size={28} /> : null}
      <h2 className="ui-empty-state__title">{title}</h2>
      {action}
    </div>
  );
}

export function ErrorBanner({
  message,
  onRetry,
  action,
}: {
  message: string;
  onRetry?: () => void;
  action?: ReactNode;
}) {
  return (
    <div className="ui-banner-error" role="alert">
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
        <Icon name="warning" size={16} />
        <span>{message}</span>
      </span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        {onRetry ? (
          <Button variant="secondary" size="sm" onClick={onRetry}>
            重试
          </Button>
        ) : null}
        {action}
      </span>
    </div>
  );
}
