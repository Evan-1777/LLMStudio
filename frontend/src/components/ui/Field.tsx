import type {
  InputHTMLAttributes,
  ReactNode,
  Ref,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';

export interface FieldProps {
  label: string;
  htmlFor?: string;
  error?: string | null;
  children: ReactNode;
}

export function Field({ label, htmlFor, error, children }: FieldProps) {
  return (
    <div className="ui-field">
      <label className="ui-field__label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {error ? (
        <span className="ui-field__error" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  ref?: Ref<HTMLInputElement>;
  compact?: boolean;
}

export function Input({ ref, compact = false, className = '', ...rest }: InputProps) {
  return (
    <input
      ref={ref}
      className={`ui-input ${compact ? 'ui-input--sm' : ''} ${className}`.trim()}
      {...rest}
    />
  );
}

export interface TextareaProps
  extends TextareaHTMLAttributes<HTMLTextAreaElement> {}

export function Textarea({ className = '', ...rest }: TextareaProps) {
  return <textarea className={`ui-textarea ${className}`.trim()} {...rest} />;
}

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  compact?: boolean;
}

export function Select({ compact = false, className = '', ...rest }: SelectProps) {
  return (
    <select
      className={`ui-select ${compact ? 'ui-select--sm' : ''} ${className}`.trim()}
      {...rest}
    />
  );
}

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  ariaLabel?: string;
  title?: string;
  disabled?: boolean;
}

export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  disabled = false,
}: {
  value: T;
  options: readonly SegmentedOption<T>[];
  onChange: (next: T) => void;
  ariaLabel: string;
  disabled?: boolean;
}) {
  return (
    <div className="ui-segmented" role="radiogroup" aria-label={ariaLabel}>
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={opt.ariaLabel}
            title={opt.title ?? opt.ariaLabel}
            className={`ui-segmented__item ${
              active ? 'ui-segmented__item--active' : ''
            }`.trim()}
            disabled={disabled || opt.disabled}
            onClick={() => onChange(opt.value)}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
