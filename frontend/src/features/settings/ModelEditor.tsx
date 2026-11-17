import { useEffect, useState, type FormEvent } from 'react';
import {
  Button,
  ErrorBanner,
  Field,
  Input,
  Modal,
  Select,
  Textarea,
} from '../../components/ui';
import {
  REASONING_EFFORT_LEVELS,
  type CompatConfig,
  type FormatInfo,
  type GenerationParams,
  type ModelConfig,
  type ReasoningEffort,
} from '../../core/types';
import {
  errorMessageOf,
  parseJsonObject,
  parseJsonStringMap,
} from './jsonValidation';

type TriState = '' | 'true' | 'false';

function toTriState(val: boolean | null | undefined): TriState {
  if (val === true) return 'true';
  if (val === false) return 'false';
  return '';
}

function fromTriState(val: TriState): boolean | undefined {
  if (val === 'true') return true;
  if (val === 'false') return false;
  return undefined;
}

function hasCompatOverrides(compat?: CompatConfig): boolean {
  if (!compat) return false;
  return Boolean(
    compat.maxTokensField ||
      compat.thinkingFormat ||
      compat.reasoningEffortField ||
      compat.pathOverride ||
      compat.cacheMode ||
      (compat.supportsDeveloperRole !== undefined &&
        compat.supportsDeveloperRole !== null) ||
      (compat.supportsStreamOptions !== undefined &&
        compat.supportsStreamOptions !== null) ||
      (compat.extraHeaders && Object.keys(compat.extraHeaders).length > 0) ||
      (compat.extraBody && Object.keys(compat.extraBody).length > 0),
  );
}

const EFFORT_LABELS: Record<ReasoningEffort, string> = {
  none: '关闭',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '极高',
  max: '最大',
};

interface ModelFieldErrors {
  id?: string;
  apiFormat?: string;
  contextWindow?: string;
  maxTokens?: string;
  defaultTemperature?: string;
  defaultMaxTokens?: string;
  extraHeaders?: string;
  extraBody?: string;
}

export interface ModelEditorProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  existing: ModelConfig | null;
  existingModels: readonly ModelConfig[];
  formats: readonly FormatInfo[];
  onSave: (model: ModelConfig) => Promise<void> | void;
}

export function ModelEditor({
  open,
  onOpenChange,
  existing,
  existingModels,
  formats,
  onSave,
}: ModelEditorProps) {
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [apiFormat, setApiFormat] = useState('');
  const [contextWindow, setContextWindow] = useState('');
  const [maxTokens, setMaxTokens] = useState('');
  const [reasoning, setReasoning] = useState(false);
  const [supportsText, setSupportsText] = useState(true);
  const [supportsImage, setSupportsImage] = useState(false);

  const [defaultTemperature, setDefaultTemperature] = useState('');
  const [defaultMaxTokens, setDefaultMaxTokens] = useState('');
  const [defaultReasoningEffort, setDefaultReasoningEffort] = useState('');

  const [compatOpen, setCompatOpen] = useState(false);
  const [maxTokensField, setMaxTokensField] = useState('');
  const [thinkingFormat, setThinkingFormat] = useState('');
  const [reasoningEffortField, setReasoningEffortField] = useState('');
  const [pathOverride, setPathOverride] = useState('');
  const [cacheMode, setCacheMode] = useState('');
  const [supportsDeveloperRole, setSupportsDeveloperRole] = useState<TriState>('');
  const [supportsStreamOptions, setSupportsStreamOptions] = useState<TriState>('');
  const [extraHeadersText, setExtraHeadersText] = useState('');
  const [extraBodyText, setExtraBodyText] = useState('');

  const [fieldErrors, setFieldErrors] = useState<ModelFieldErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    const defaultFmt = formats[0]?.id ?? '';
    const modalities = existing?.inputModalities ?? ['text'];
    setId(existing?.id ?? '');
    setName(existing?.name ?? '');
    setApiFormat(existing?.apiFormat || defaultFmt);
    setContextWindow(
      existing?.contextWindow && existing.contextWindow > 0
        ? String(existing.contextWindow)
        : '',
    );
    setMaxTokens(
      existing?.maxTokens && existing.maxTokens > 0
        ? String(existing.maxTokens)
        : '',
    );
    setReasoning(Boolean(existing?.reasoning));
    setSupportsText(modalities.includes('text'));
    setSupportsImage(modalities.includes('image'));

    setDefaultTemperature(
      existing?.defaultParams?.temperature !== undefined
        ? String(existing.defaultParams.temperature)
        : '',
    );
    setDefaultMaxTokens(
      existing?.defaultParams?.maxTokens !== undefined
        ? String(existing.defaultParams.maxTokens)
        : '',
    );
    setDefaultReasoningEffort(existing?.defaultParams?.reasoningEffort ?? '');

    setCompatOpen(hasCompatOverrides(existing?.compat));
    setMaxTokensField(existing?.compat?.maxTokensField ?? '');
    setThinkingFormat(existing?.compat?.thinkingFormat ?? '');
    setReasoningEffortField(existing?.compat?.reasoningEffortField ?? '');
    setPathOverride(existing?.compat?.pathOverride ?? '');
    setCacheMode(existing?.compat?.cacheMode ?? '');
    setSupportsDeveloperRole(toTriState(existing?.compat?.supportsDeveloperRole));
    setSupportsStreamOptions(toTriState(existing?.compat?.supportsStreamOptions));
    setExtraHeadersText(
      existing?.compat?.extraHeaders &&
        Object.keys(existing.compat.extraHeaders).length > 0
        ? JSON.stringify(existing.compat.extraHeaders, null, 2)
        : '',
    );
    setExtraBodyText(
      existing?.compat?.extraBody &&
        Object.keys(existing.compat.extraBody).length > 0
        ? JSON.stringify(existing.compat.extraBody, null, 2)
        : '',
    );

    setFieldErrors({});
    setSubmitError(null);
  }, [open, existing, formats]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const errors: ModelFieldErrors = {};

    const trimmedId = id.trim();
    if (!trimmedId) {
      errors.id = 'Model ID 不能为空';
    } else {
      const hasDup = existingModels.some(
        (m) => m.id === trimmedId && m.id !== existing?.id,
      );
      if (hasDup) {
        errors.id = `Model ID "${trimmedId}" 已存在`;
      }
    }

    if (!apiFormat.trim()) {
      errors.apiFormat = '请选择 API Format';
    }

    let parsedContextWindow: number | undefined;
    if (contextWindow.trim() !== '') {
      const n = Number(contextWindow.trim());
      if (!Number.isInteger(n) || n < 0) {
        errors.contextWindow = '上下文窗口须为非负整数';
      } else if (n > 0) {
        parsedContextWindow = n;
      }
    }

    let parsedMaxTokens: number | undefined;
    if (maxTokens.trim() !== '') {
      const n = Number(maxTokens.trim());
      if (!Number.isInteger(n) || n < 0) {
        errors.maxTokens = '最大输出 Token 须为非负整数';
      } else if (n > 0) {
        parsedMaxTokens = n;
      }
    }

    let parsedDefaultTemp: number | undefined;
    if (defaultTemperature.trim() !== '') {
      const n = Number(defaultTemperature.trim());
      if (!Number.isFinite(n) || n < 0 || n > 2) {
        errors.defaultTemperature = 'Temperature 须在 0 到 2 之间';
      } else {
        parsedDefaultTemp = n;
      }
    }

    let parsedDefaultMaxTok: number | undefined;
    if (defaultMaxTokens.trim() !== '') {
      const n = Number(defaultMaxTokens.trim());
      if (!Number.isInteger(n) || n < 1) {
        errors.defaultMaxTokens = '默认 Max Tokens 须为正整数';
      } else {
        parsedDefaultMaxTok = n;
      }
    }

    const headersParsed = parseJsonStringMap(extraHeadersText, 'extraHeaders');
    if (!headersParsed.ok) {
      errors.extraHeaders = headersParsed.error;
    }

    const bodyParsed = parseJsonObject(extraBodyText, 'extraBody');
    if (!bodyParsed.ok) {
      errors.extraBody = bodyParsed.error;
    }

    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      if (errors.extraHeaders || errors.extraBody) {
        setCompatOpen(true);
      }
      return;
    }

    setFieldErrors({});
    setSubmitError(null);

    const preservedExtras = (existing?.inputModalities ?? []).filter(
      (mod) => mod !== 'text' && mod !== 'image',
    );
    const inputModalities: string[] = [
      ...(supportsText ? ['text'] : []),
      ...(supportsImage ? ['image'] : []),
      ...preservedExtras,
    ];

    const compat: CompatConfig = {};
    if (maxTokensField.trim()) compat.maxTokensField = maxTokensField.trim();
    if (thinkingFormat.trim()) compat.thinkingFormat = thinkingFormat.trim();
    if (reasoningEffortField.trim()) {
      compat.reasoningEffortField = reasoningEffortField.trim();
    }
    if (pathOverride.trim()) compat.pathOverride = pathOverride.trim();
    if (cacheMode.trim()) compat.cacheMode = cacheMode.trim();
    const devRole = fromTriState(supportsDeveloperRole);
    if (devRole !== undefined) compat.supportsDeveloperRole = devRole;
    const streamOpts = fromTriState(supportsStreamOptions);
    if (streamOpts !== undefined) compat.supportsStreamOptions = streamOpts;
    if (headersParsed.ok && Object.keys(headersParsed.value).length > 0) {
      compat.extraHeaders = headersParsed.value;
    }
    if (bodyParsed.ok && bodyParsed.value && Object.keys(bodyParsed.value).length > 0) {
      compat.extraBody = bodyParsed.value;
    }

    const defaultParams: GenerationParams = {};
    if (parsedDefaultTemp !== undefined) {
      defaultParams.temperature = parsedDefaultTemp;
    }
    if (parsedDefaultMaxTok !== undefined) {
      defaultParams.maxTokens = parsedDefaultMaxTok;
    }
    if (defaultReasoningEffort) {
      defaultParams.reasoningEffort = defaultReasoningEffort as ReasoningEffort;
    }

    const nextModel: ModelConfig = {
      id: trimmedId,
      name: name.trim() || trimmedId,
      apiFormat: apiFormat.trim(),
      ...(parsedContextWindow !== undefined
        ? { contextWindow: parsedContextWindow }
        : {}),
      ...(parsedMaxTokens !== undefined ? { maxTokens: parsedMaxTokens } : {}),
      ...(reasoning ? { reasoning: true } : {}),
      ...(inputModalities.length > 0 ? { inputModalities } : {}),
      ...(Object.keys(compat).length > 0 ? { compat } : {}),
      ...(Object.keys(defaultParams).length > 0 ? { defaultParams } : {}),
    };

    setSaving(true);
    try {
      await onSave(nextModel);
      onOpenChange(false);
    } catch (err) {
      setSubmitError(errorMessageOf(err, '保存模型失败'));
    } finally {
      setSaving(false);
    }
  };

  const hasExistingCustomFormat =
    Boolean(existing?.apiFormat) &&
    !formats.some((f) => f.id === existing?.apiFormat);

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (!saving) onOpenChange(next);
      }}
      title={existing ? '编辑模型' : '添加模型'}
      wide
      footer={
        <>
          <Button
            variant="secondary"
            disabled={saving}
            onClick={() => onOpenChange(false)}
          >
            取消
          </Button>
          <Button
            type="submit"
            form="model-editor-form"
            variant="primary"
            disabled={saving}
          >
            {saving ? '保存中...' : '保存'}
          </Button>
        </>
      }
    >
      <form
        id="model-editor-form"
        noValidate
        onSubmit={(e) => void handleSubmit(e)}
        style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
      >
        {submitError ? <ErrorBanner message={submitError} /> : null}

        <div className="st-grid-2">
          <Field label="Model ID" htmlFor="model-id" error={fieldErrors.id}>
            <Input
              id="model-id"
              value={id}
              onChange={(e) => setId(e.target.value)}
              placeholder="gpt-4.1"
              required
            />
          </Field>
          <Field label="显示名称" htmlFor="model-name">
            <Input
              id="model-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="GPT-4.1"
            />
          </Field>
        </div>

        <div className="st-grid-3">
          <Field
            label="API Format"
            htmlFor="model-api-format"
            error={fieldErrors.apiFormat}
          >
            <Select
              id="model-api-format"
              value={apiFormat}
              onChange={(e) => setApiFormat(e.target.value)}
            >
              {formats.length === 0 && !hasExistingCustomFormat ? (
                <option value="">暂无可用格式</option>
              ) : null}
              {hasExistingCustomFormat && existing?.apiFormat ? (
                <option value={existing.apiFormat}>{existing.apiFormat}</option>
              ) : null}
              {formats.map((fmt) => (
                <option key={fmt.id} value={fmt.id}>
                  {fmt.displayName}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="上下文窗口"
            htmlFor="model-context-window"
            error={fieldErrors.contextWindow}
          >
            <Input
              id="model-context-window"
              type="number"
              min="0"
              placeholder="128000"
              value={contextWindow}
              onChange={(e) => setContextWindow(e.target.value)}
            />
          </Field>
          <Field
            label="最大输出 Token"
            htmlFor="model-max-tokens"
            error={fieldErrors.maxTokens}
          >
            <Input
              id="model-max-tokens"
              type="number"
              min="0"
              placeholder="32768"
              value={maxTokens}
              onChange={(e) => setMaxTokens(e.target.value)}
            />
          </Field>
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>
          <label className="st-check-row">
            <input
              type="checkbox"
              className="st-checkbox"
              checked={reasoning}
              onChange={(e) => setReasoning(e.target.checked)}
            />
            <span>推理模型</span>
          </label>
          <label className="st-check-row">
            <input
              type="checkbox"
              className="st-checkbox"
              checked={supportsText}
              onChange={(e) => setSupportsText(e.target.checked)}
            />
            <span>文本输入</span>
          </label>
          <label className="st-check-row">
            <input
              type="checkbox"
              className="st-checkbox"
              checked={supportsImage}
              onChange={(e) => setSupportsImage(e.target.checked)}
            />
            <span>视觉输入</span>
          </label>
        </div>

        <div className="st-grid-3">
          <Field
            label="默认 Temperature"
            htmlFor="model-default-temp"
            error={fieldErrors.defaultTemperature}
          >
            <Input
              id="model-default-temp"
              type="number"
              step="0.1"
              min="0"
              max="2"
              placeholder="继承"
              value={defaultTemperature}
              onChange={(e) => setDefaultTemperature(e.target.value)}
            />
          </Field>
          <Field
            label="默认 Max Tokens"
            htmlFor="model-default-max-tokens"
            error={fieldErrors.defaultMaxTokens}
          >
            <Input
              id="model-default-max-tokens"
              type="number"
              min="1"
              placeholder="继承"
              value={defaultMaxTokens}
              onChange={(e) => setDefaultMaxTokens(e.target.value)}
            />
          </Field>
          <Field label="默认思考强度" htmlFor="model-default-effort">
            <Select
              id="model-default-effort"
              value={defaultReasoningEffort}
              onChange={(e) => setDefaultReasoningEffort(e.target.value)}
            >
              <option value="">继承</option>
              {REASONING_EFFORT_LEVELS.map((lvl) => (
                <option key={lvl} value={lvl}>
                  {EFFORT_LABELS[lvl]}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <details
          className="st-details"
          open={compatOpen}
          onToggle={(e) => setCompatOpen(e.currentTarget.open)}
        >
          <summary className="st-details__summary">协议兼容覆盖</summary>
          <div className="st-details__body">
            <div className="st-grid-2">
              <Field label="maxTokensField" htmlFor="compat-max-tokens-field">
                <Input
                  id="compat-max-tokens-field"
                  compact
                  placeholder="继承"
                  value={maxTokensField}
                  onChange={(e) => setMaxTokensField(e.target.value)}
                />
              </Field>
              <Field label="thinkingFormat" htmlFor="compat-thinking-format">
                <Input
                  id="compat-thinking-format"
                  compact
                  placeholder="继承"
                  value={thinkingFormat}
                  onChange={(e) => setThinkingFormat(e.target.value)}
                />
              </Field>
            </div>

            <div className="st-grid-2">
              <Field
                label="reasoningEffortField"
                htmlFor="compat-reasoning-field"
              >
                <Input
                  id="compat-reasoning-field"
                  compact
                  placeholder="继承"
                  value={reasoningEffortField}
                  onChange={(e) => setReasoningEffortField(e.target.value)}
                />
              </Field>
              <Field label="pathOverride" htmlFor="compat-path-override">
                <Input
                  id="compat-path-override"
                  compact
                  placeholder="继承"
                  value={pathOverride}
                  onChange={(e) => setPathOverride(e.target.value)}
                />
              </Field>
            </div>

            <div className="st-grid-2">
              <Field
                label="supportsDeveloperRole"
                htmlFor="compat-developer-role"
              >
                <Select
                  id="compat-developer-role"
                  compact
                  value={supportsDeveloperRole}
                  onChange={(e) =>
                    setSupportsDeveloperRole(e.target.value as TriState)
                  }
                >
                  <option value="">继承</option>
                  <option value="true">true</option>
                  <option value="false">false</option>
                </Select>
              </Field>
              <Field
                label="supportsStreamOptions"
                htmlFor="compat-stream-options"
              >
                <Select
                  id="compat-stream-options"
                  compact
                  value={supportsStreamOptions}
                  onChange={(e) =>
                    setSupportsStreamOptions(e.target.value as TriState)
                  }
                >
                  <option value="">继承</option>
                  <option value="true">true</option>
                  <option value="false">false</option>
                </Select>
              </Field>
            </div>

            <Field label="cacheMode" htmlFor="compat-cache-mode">
              <Select
                id="compat-cache-mode"
                compact
                value={cacheMode}
                onChange={(e) => setCacheMode(e.target.value)}
              >
                <option value="">继承</option>
                <option value="auto">auto</option>
                <option value="implicit">implicit</option>
                <option value="explicit">explicit</option>
                <option value="disabled">disabled</option>
              </Select>
            </Field>

            <Field
              label="extraHeaders (JSON)"
              htmlFor="compat-extra-headers"
              error={fieldErrors.extraHeaders}
            >
              <Textarea
                id="compat-extra-headers"
                rows={2}
                className="st-mono"
                placeholder="{}"
                value={extraHeadersText}
                onChange={(e) => setExtraHeadersText(e.target.value)}
              />
            </Field>

            <Field
              label="extraBody (JSON)"
              htmlFor="compat-extra-body"
              error={fieldErrors.extraBody}
            >
              <Textarea
                id="compat-extra-body"
                rows={3}
                className="st-mono"
                placeholder="{}"
                value={extraBodyText}
                onChange={(e) => setExtraBodyText(e.target.value)}
              />
            </Field>
          </div>
        </details>
      </form>
    </Modal>
  );
}
