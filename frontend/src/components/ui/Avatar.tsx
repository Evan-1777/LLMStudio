import { useEffect, useId, useRef, useState } from 'react';
import { fileToAvatarDataUrl } from '../../core/avatar';
import { Icon } from './Icon';
import { IconButton } from './Icon';

export type AvatarKind = 'user' | 'assistant';

/** Shared avatar frame: the stored image when available, the role glyph otherwise. */
export function Avatar({
  src,
  kind,
  size = 32,
  className = '',
}: {
  src?: string;
  kind: AvatarKind;
  size?: number;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  const showImage = Boolean(src) && !failed;

  return (
    <span
      className={`ui-avatar ${className}`.trim()}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      {showImage ? (
        <img
          className="ui-avatar__img"
          src={src}
          alt=""
          onError={() => setFailed(true)}
        />
      ) : (
        <Icon name={kind === 'user' ? 'user' : 'bot'} size={Math.round(size * 0.52)} />
      )}
    </span>
  );
}

/** Avatar preview with replace and clear actions backed by the caller's draft. */
export function AvatarField({
  value,
  kind,
  label,
  onChange,
  disabled = false,
  busy = false,
  onError,
}: {
  value: string;
  kind: AvatarKind;
  /** Field name used in the action labels, e.g. 用户头像. */
  label: string;
  onChange: (next: string) => void;
  disabled?: boolean;
  busy?: boolean;
  onError: (message: string | null) => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const errorId = useId();
  const [reading, setReading] = useState(false);

  const handleFile = async (file?: File) => {
    if (!file || reading) return;
    setReading(true);
    onError(null);
    try {
      onChange(await fileToAvatarDataUrl(file));
    } catch (err) {
      onError(err instanceof Error ? err.message : '无法读取该图片');
    } finally {
      setReading(false);
      // Reset so picking the same file again still fires a change event.
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const blocked = disabled || busy || reading;

  return (
    <div className="ui-avatar-field">
      <Avatar src={value} kind={kind} size={48} />
      <div className="ui-avatar-field__actions">
        <IconButton
          size="sm"
          icon="image"
          label={`更换${label}`}
          disabled={blocked}
          onClick={() => inputRef.current?.click()}
        />
        {value ? (
          <IconButton
            size="sm"
            icon="trash"
            tone="danger"
            label={`清除${label}`}
            disabled={blocked}
            onClick={() => onChange('')}
          />
        ) : null}
        {busy || reading ? (
          <span className="ui-spinner ui-spinner--sm" role="status" aria-label={`正在保存${label}`} />
        ) : null}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="ui-avatar-field__input"
        aria-label={`${label}文件`}
        aria-describedby={errorId}
        tabIndex={-1}
        onChange={(e) => void handleFile(e.target.files?.[0])}
      />
      <span id={errorId} hidden />
    </div>
  );
}
