import type { ButtonHTMLAttributes } from 'react';

export interface SwitchProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onChange'> {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label?: string;
}

export function Switch({
  checked,
  onCheckedChange,
  label,
  className = '',
  type = 'button',
  ...rest
}: SwitchProps) {
  return (
    <button
      type={type}
      role="switch"
      aria-checked={checked}
      aria-label={label ?? rest['aria-label']}
      className={`ui-switch ${className}`.trim()}
      onClick={() => onCheckedChange(!checked)}
      {...rest}
    >
      <span className="ui-switch__thumb" />
    </button>
  );
}
