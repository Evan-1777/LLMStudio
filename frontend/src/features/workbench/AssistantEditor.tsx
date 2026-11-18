import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useApp } from '../../app/AppProvider';
import {
  AvatarField,
  Button,
  ConfirmDialog,
  ErrorBanner,
  Field,
  Input,
  Modal,
  Select,
  Textarea,
} from '../../components/ui';
import { GatewayError } from '../../core/gateway';
import {
  REASONING_EFFORT_LEVELS,
  type Assistant,
  type ReasoningEffort,
} from '../../core/types';

const EFFORT_LABELS: Record<ReasoningEffort, string> = {
  none: '关闭',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '极高',
  max: '最大',
};

export function AssistantEditor({
  open,
  onOpenChange,
  assistant,
  onSaved,
  onDeleted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  assistant: Assistant | null;
  onSaved: (saved: Assistant) => void;
  onDeleted: (deletedId: string) => void;
}) {
  const { gateway, resources, upsertLocalAssistant, removeLocalAssistant, refreshConversations, toast } =
    useApp();

  const [name, setName] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [modelValue, setModelValue] = useState('');
  const [temperature, setTemperature] = useState('');
  const [maxTokens, setMaxTokens] = useState('');
  const [reasoningEffort, setReasoningEffort] = useState<string>('');
  const [avatarDataUrl, setAvatarDataUrl] = useState('');
  const [avatarTouched, setAvatarTouched] = useState(false);
  const [avatarError, setAvatarError] = useState<string | null>(null);

  const [nameError, setNameError] = useState<string | null>(null);
  const [apiError, setApiError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const modelOptions = useMemo(() => {
    const items: Array<{ key: string; providerId: string; modelId: string; label: string }> = [];
    for (const p of resources.providers) {
      if (!p.enabled) continue;
      for (const m of p.models) {
        items.push({
          key: `${p.id}::${m.id}`,
          providerId: p.id,
          modelId: m.id,
          label: `${m.name} (${p.name})`,
        });
      }
    }
    return items;
  }, [resources.providers]);

  useEffect(() => {
    if (!open) return;
    setName(assistant?.name ?? '');
    setSystemPrompt(assistant?.systemPrompt ?? '');
    if (assistant?.defaultProviderId && assistant?.defaultModelId) {
      setModelValue(
        `${assistant.defaultProviderId}::${assistant.defaultModelId}`,
      );
    } else {
      setModelValue('');
    }
    setTemperature(
      assistant?.params.temperature !== undefined
        ? String(assistant.params.temperature)
        : '',
    );
    setMaxTokens(
      assistant?.params.maxTokens !== undefined
        ? String(assistant.params.maxTokens)
        : '',
    );
    setReasoningEffort(assistant?.params.reasoningEffort ?? '');
    setAvatarDataUrl(assistant?.avatarDataUrl ?? '');
    setAvatarTouched(false);
    setAvatarError(null);
    setNameError(null);
    setApiError(null);
  }, [open, assistant]);

  const canDelete = Boolean(
    assistant && !assistant.isDefault && assistant.id !== 'default',
  );

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) {
      setNameError('助手名称不能为空');
      return;
    }
    setNameError(null);
    setApiError(null);

    let parsedTemp: number | undefined;
    if (temperature.trim() !== '') {
      const n = Number(temperature.trim());
      if (!Number.isFinite(n) || n < 0 || n > 2) {
        setApiError('Temperature 须在 0 到 2 之间');
        return;
      }
      parsedTemp = n;
    }

    let parsedMaxTokens: number | undefined;
    if (maxTokens.trim() !== '') {
      const n = Number(maxTokens.trim());
      if (!Number.isInteger(n) || n < 1) {
        setApiError('Max Tokens 须为正整数');
        return;
      }
      parsedMaxTokens = n;
    }

    const [defaultProviderId = '', defaultModelId = ''] = modelValue
      ? modelValue.split('::')
      : [];

    const payload = {
      name: trimmedName,
      systemPrompt,
      defaultProviderId,
      defaultModelId,
      params: {
        ...(parsedTemp !== undefined ? { temperature: parsedTemp } : {}),
        ...(parsedMaxTokens !== undefined ? { maxTokens: parsedMaxTokens } : {}),
        ...(reasoningEffort
          ? { reasoningEffort: reasoningEffort as ReasoningEffort }
          : {}),
      },
      // Editing keeps the stored avatar unless the draft was actually changed.
      ...(assistant && !avatarTouched ? {} : { avatarDataUrl }),
    };

    setSaving(true);
    try {
      const saved = assistant
        ? await gateway.updateAssistant(assistant.id, payload)
        : await gateway.createAssistant(payload);
      upsertLocalAssistant(saved);
      onSaved(saved);
      onOpenChange(false);
    } catch (err) {
      setApiError(
        err instanceof GatewayError ? err.message : '保存助手失败，请重试',
      );
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!assistant || !canDelete) return;
    setDeleting(true);
    setApiError(null);
    try {
      await gateway.deleteAssistant(assistant.id);
      removeLocalAssistant(assistant.id);
      await refreshConversations();
      setConfirmDeleteOpen(false);
      onOpenChange(false);
      onDeleted(assistant.id);
      toast('助手已删除');
    } catch (err) {
      setConfirmDeleteOpen(false);
      setApiError(
        err instanceof GatewayError ? err.message : '删除助手失败',
      );
    } finally {
      setDeleting(false);
    }
  };

  const currentModelInOptions =
    !modelValue || modelOptions.some((opt) => opt.key === modelValue);

  return (
    <>
      <Modal
        open={open}
        onOpenChange={(next) => {
          if (!saving && !deleting) onOpenChange(next);
        }}
        title={assistant ? '编辑助手' : '添加助手'}
        footer={
          <>
            {canDelete ? (
              <Button
                variant="danger-ghost"
                disabled={saving || deleting}
                onClick={() => setConfirmDeleteOpen(true)}
                style={{ marginRight: 'auto' }}
              >
                删除助手
              </Button>
            ) : null}
            <Button
              variant="secondary"
              disabled={saving || deleting}
              onClick={() => onOpenChange(false)}
            >
              取消
            </Button>
            <Button
              type="submit"
              form="assistant-editor-form"
              variant="primary"
              disabled={saving || deleting}
            >
              {saving ? '保存中...' : '保存'}
            </Button>
          </>
        }
      >
        <form
          id="assistant-editor-form"
          noValidate
          onSubmit={(e) => void handleSubmit(e)}
          style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
        >
          {apiError ? <ErrorBanner message={apiError} /> : null}

          <div className="wb-assistant-identity">
            <AvatarField
              value={avatarDataUrl}
              kind="assistant"
              label="助手头像"
              busy={saving}
              onChange={(next) => {
                setAvatarDataUrl(next);
                setAvatarTouched(true);
                setAvatarError(null);
              }}
              onError={setAvatarError}
            />
            <div className="wb-assistant-identity__name">
              <Field label="名称" htmlFor="assistant-name" error={nameError}>
                <Input
                  id="assistant-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={80}
                  required
                />
              </Field>
            </div>
          </div>
          {avatarError ? (
            <span className="ui-field__error" role="alert">
              {avatarError}
            </span>
          ) : null}

          <Field label="系统提示词" htmlFor="assistant-system-prompt">
            <Textarea
              id="assistant-system-prompt"
              rows={4}
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
            />
          </Field>

          <Field label="默认模型" htmlFor="assistant-default-model">
            <Select
              id="assistant-default-model"
              value={currentModelInOptions ? modelValue : ''}
              onChange={(e) => setModelValue(e.target.value)}
            >
              <option value="">跟随当前选择</option>
              {modelOptions.map((opt) => (
                <option key={opt.key} value={opt.key}>
                  {opt.label}
                </option>
              ))}
            </Select>
          </Field>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
              gap: 8,
            }}
          >
            <Field label="Temperature" htmlFor="assistant-temp">
              <Input
                id="assistant-temp"
                type="number"
                step="0.1"
                min="0"
                max="2"
                placeholder="默认"
                value={temperature}
                onChange={(e) => setTemperature(e.target.value)}
              />
            </Field>
            <Field label="Max Tokens" htmlFor="assistant-max-tokens">
              <Input
                id="assistant-max-tokens"
                type="number"
                min="1"
                placeholder="默认"
                value={maxTokens}
                onChange={(e) => setMaxTokens(e.target.value)}
              />
            </Field>
            <Field label="思考强度" htmlFor="assistant-effort">
              <Select
                id="assistant-effort"
                value={reasoningEffort}
                onChange={(e) => setReasoningEffort(e.target.value)}
              >
                <option value="">默认</option>
                {REASONING_EFFORT_LEVELS.map((lvl) => (
                  <option key={lvl} value={lvl}>
                    {EFFORT_LABELS[lvl]}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        </form>
      </Modal>

      <ConfirmDialog
        open={confirmDeleteOpen}
        onOpenChange={setConfirmDeleteOpen}
        title="删除助手？"
        message={`确认删除「${assistant?.name ?? ''}」？其下话题将归入默认助手。`}
        confirmLabel="删除"
        busy={deleting}
        onConfirm={handleDelete}
      />
    </>
  );
}
