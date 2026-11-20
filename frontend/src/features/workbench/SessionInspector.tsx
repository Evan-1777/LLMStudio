import { useEffect, useState, type FormEvent } from 'react';
import { useApp } from '../../app/AppProvider';
import {
  Button,
  ErrorBanner,
  Field,
  IconButton,
  Input,
  Textarea,
} from '../../components/ui';
import { GatewayError } from '../../core/gateway';
import type { Conversation, GenerationParams, TopicScope } from '../../core/types';

export interface DraftSessionParams {
  systemPrompt: string;
  params: GenerationParams;
}

export function SessionInspector({
  conversation,
  draftParams,
  isBusy,
  scope,
  onClose,
  onSaved,
  onSaveDraft,
}: {
  conversation: Conversation | null;
  draftParams?: DraftSessionParams;
  isBusy: boolean;
  scope?: TopicScope;
  onClose: () => void;
  onSaved: (updated: Conversation) => void;
  onSaveDraft?: (next: DraftSessionParams) => void;
}) {
  const { gateway, toast } = useApp();

  const [systemPrompt, setSystemPrompt] = useState('');
  const [tempEnabled, setTempEnabled] = useState(false);
  const [temperature, setTemperature] = useState(0.7);
  const [maxTokens, setMaxTokens] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const srcPrompt = conversation
      ? conversation.systemPrompt ?? ''
      : draftParams?.systemPrompt ?? '';
    const srcParams = conversation
      ? conversation.params
      : draftParams?.params ?? {};

    setSystemPrompt(srcPrompt);
    if (
      srcParams.temperature !== undefined &&
      srcParams.temperature !== null
    ) {
      setTempEnabled(true);
      setTemperature(srcParams.temperature);
    } else {
      setTempEnabled(false);
      setTemperature(0.7);
    }
    setMaxTokens(
      srcParams.maxTokens !== undefined && srcParams.maxTokens !== null
        ? String(srcParams.maxTokens)
        : '',
    );
    setError(null);
  }, [conversation, draftParams]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (isBusy) return;
    setError(null);

    let parsedMaxTokens: number | null = null;
    if (maxTokens.trim() !== '') {
      const n = Number(maxTokens.trim());
      if (!Number.isInteger(n) || n < 1) {
        setError('最大输出 Token 须为正整数');
        return;
      }
      parsedMaxTokens = n;
    }

    if (!conversation) {
      onSaveDraft?.({
        systemPrompt,
        params: {
          ...(tempEnabled ? { temperature } : {}),
          ...(parsedMaxTokens !== null ? { maxTokens: parsedMaxTokens } : {}),
        },
      });
      toast('已应用到新话题草稿');
      return;
    }

    setSaving(true);
    try {
      const updated = await gateway.patchConversation(
        conversation.id,
        {
          systemPrompt,
          params: {
            temperature: tempEnabled ? temperature : null,
            maxTokens: parsedMaxTokens,
          },
        },
        undefined,
        scope,
      );
      onSaved(updated);
      toast('话题参数已保存');
    } catch (err) {
      setError(
        err instanceof GatewayError ? err.message : '保存话题参数失败',
      );
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    if (isBusy) return;
    setError(null);
    if (!conversation) {
      setSystemPrompt('');
      setTempEnabled(false);
      setTemperature(0.7);
      setMaxTokens('');
      onSaveDraft?.({ systemPrompt: '', params: {} });
      toast('已恢复继承值');
      return;
    }

    setSaving(true);
    try {
      const updated = await gateway.patchConversation(
        conversation.id,
        {
          systemPrompt: '',
          params: null,
        },
        undefined,
        scope,
      );
      onSaved(updated);
      toast('已恢复继承值');
    } catch (err) {
      setError(
        err instanceof GatewayError ? err.message : '重置参数失败',
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="wb-inspector" onSubmit={(e) => void handleSubmit(e)}>
      <div className="wb-history__head">
        <span>话题参数</span>
        <IconButton
          size="sm"
          icon="close"
          label="关闭话题参数"
          onClick={onClose}
        />
      </div>

      <div className="wb-inspector__body">
        {error ? <ErrorBanner message={error} /> : null}

      <Field label="系统提示词" htmlFor="session-system-prompt">
        <Textarea
          id="session-system-prompt"
          rows={5}
          value={systemPrompt}
          disabled={isBusy || saving}
          placeholder="继承助手"
          onChange={(e) => setSystemPrompt(e.target.value)}
        />
      </Field>

      <div className="ui-field">
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <label
            htmlFor="session-temp-toggle"
            className="ui-field__label"
            style={{ cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }}
          >
            <input
              id="session-temp-toggle"
              type="checkbox"
              checked={tempEnabled}
              disabled={isBusy || saving}
              onChange={(e) => setTempEnabled(e.target.checked)}
            />
            <span>Temperature</span>
          </label>
          <output
            htmlFor="session-temp-range"
            style={{ fontSize: 12, color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums' }}
          >
            {tempEnabled ? temperature.toFixed(1) : '继承'}
          </output>
        </div>
        <input
          id="session-temp-range"
          type="range"
          className="wb-range"
          min="0"
          max="2"
          step="0.1"
          value={temperature}
          disabled={!tempEnabled || isBusy || saving}
          onChange={(e) => setTemperature(Number(e.target.value))}
        />
      </div>

      <Field label="最大输出 Token" htmlFor="session-max-tokens">
        <Input
          id="session-max-tokens"
          type="number"
          min="1"
          placeholder="继承"
          value={maxTokens}
          disabled={isBusy || saving}
          onChange={(e) => setMaxTokens(e.target.value)}
        />
      </Field>

      <div className="wb-inspector__foot">
        <Button type="submit" variant="primary" disabled={isBusy || saving}>
          {saving ? '保存中...' : '保存'}
        </Button>
        <Button
          variant="ghost"
          disabled={isBusy || saving}
          onClick={() => void handleReset()}
        >
          恢复继承值
        </Button>
      </div>
      </div>
    </form>
  );
}
