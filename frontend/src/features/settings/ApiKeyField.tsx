import { useState } from 'react';
import { Button, IconButton, Input } from '../../components/ui';

export interface ApiKeyFieldProps {
  id: string;
  value: string;
  clearApiKey: boolean;
  apiKeySet: boolean;
  apiKeyMasked?: string;
  placeholder?: string;
  disabled?: boolean;
  onValueChange: (next: string) => void;
  onClearApiKeyChange: (next: boolean) => void;
}

export function ApiKeyField({
  id,
  value,
  clearApiKey,
  apiKeySet,
  apiKeyMasked,
  placeholder,
  disabled = false,
  onValueChange,
  onClearApiKeyChange,
}: ApiKeyFieldProps) {
  const [visible, setVisible] = useState(false);

  const resolvedPlaceholder = clearApiKey
    ? '保存后将清空已存密钥'
    : placeholder ??
      (apiKeySet
        ? `已保存 (${apiKeyMasked || '****'})`
        : '输入 API Key');

  return (
    <div className="st-key-field">
      <div className="ui-input-group">
        <Input
          id={id}
          type={visible ? 'text' : 'password'}
          value={value}
          placeholder={resolvedPlaceholder}
          disabled={disabled || clearApiKey}
          autoComplete="off"
          onChange={(e) => {
            if (clearApiKey && e.target.value) {
              onClearApiKeyChange(false);
            }
            onValueChange(e.target.value);
          }}
        />
        <IconButton
          size="sm"
          icon={visible ? 'eyeOff' : 'eye'}
          label={visible ? '隐藏密钥' : '显示密钥'}
          disabled={disabled || clearApiKey}
          onClick={() => setVisible((v) => !v)}
        />
        {apiKeySet ? (
          <Button
            size="sm"
            variant={clearApiKey ? 'danger-ghost' : 'ghost'}
            disabled={disabled}
            aria-pressed={clearApiKey}
            onClick={() => {
              const nextClear = !clearApiKey;
              onClearApiKeyChange(nextClear);
              if (nextClear) {
                onValueChange('');
                setVisible(false);
              }
            }}
          >
            {clearApiKey ? '取消清空' : '清空密钥'}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
