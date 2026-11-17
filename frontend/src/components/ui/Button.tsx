import type { ButtonHTMLAttributes } from 'react';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-ghost';
  size?: 'sm' | 'md';
}

export function Button({
  variant = 'secondary',
  size = 'md',
  type = 'button',
  className = '',
  ...rest
}: ButtonProps) {
  const classes = [
    'ui-btn',
    `ui-btn--${variant}`,
    size === 'sm' ? 'ui-btn--sm' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return <button type={type} className={classes} {...rest} />;
}
