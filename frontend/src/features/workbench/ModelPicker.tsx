import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Icon, Input, Popover } from '../../components/ui';
import type { ModelConfig, ProviderConfig, ReasoningEffort } from '../../core/types';

export interface SelectedModelRef {
  provider: ProviderConfig;
  model: ModelConfig;
}

export const REASONING_EFFORT_OPTIONS: ReadonlyArray<{
  value: ReasoningEffort;
  label: string;
}> = [
  { value: 'none', label: 'Off' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra High' },
  { value: 'max', label: 'Max' },
];

export function formatReasoningEffortLabel(effort: ReasoningEffort): string {
  return (
    REASONING_EFFORT_OPTIONS.find((item) => item.value === effort)?.label ??
    'Off'
  );
}

export function resolveModelOption(
  providers: ProviderConfig[],
  providerId: string,
  modelId: string,
): SelectedModelRef | null {
  for (const p of providers) {
    if (!p.enabled || p.id !== providerId) continue;
    for (const m of p.models) {
      if (m.id === modelId) return { provider: p, model: m };
    }
  }
  return null;
}

export function getDefaultModelOption(
  providers: ProviderConfig[],
): SelectedModelRef | null {
  const usable: SelectedModelRef[] = [];
  const all: SelectedModelRef[] = [];
  for (const p of providers) {
    if (!p.enabled) continue;
    const isUsable = p.authType === 'none' || p.apiKeySet;
    for (const m of p.models) {
      const ref = { provider: p, model: m };
      all.push(ref);
      if (isUsable) usable.push(ref);
    }
  }
  return usable[0] ?? all[0] ?? null;
}

export function ModelPicker({
  providers,
  selectedProviderId,
  selectedModelId,
  reasoningEffort,
  onChangeReasoningEffort,
  disabled = false,
  busy = false,
  savingEffort = false,
  onSelect,
}: {
  providers: ProviderConfig[];
  selectedProviderId: string;
  selectedModelId: string;
  reasoningEffort: ReasoningEffort;
  onChangeReasoningEffort: (effort: ReasoningEffort) => Promise<boolean> | void;
  disabled?: boolean;
  busy?: boolean;
  savingEffort?: boolean;
  onSelect: (providerId: string, modelId: string) => void;
}) {
  const location = useLocation();
  const descriptionId = useId();
  const effortInputId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [previewEffort, setPreviewEffort] = useState<ReasoningEffort | null>(
    null,
  );

  const pointerDownRef = useRef(false);
  const latestPreviewRef = useRef<ReasoningEffort | null>(null);
  const pointerCleanupRef = useRef<(() => void) | null>(null);
  const onChangeEffortRef = useRef(onChangeReasoningEffort);
  onChangeEffortRef.current = onChangeReasoningEffort;
  const confirmedEffortRef = useRef(reasoningEffort);
  confirmedEffortRef.current = reasoningEffort;

  const clearPointerListeners = useCallback(() => {
    pointerCleanupRef.current?.();
    pointerCleanupRef.current = null;
  }, []);

  useEffect(() => () => clearPointerListeners(), [clearPointerListeners]);

  useEffect(() => {
    if (!pointerDownRef.current && !savingEffort) {
      setPreviewEffort(null);
      latestPreviewRef.current = null;
    }
  }, [reasoningEffort, savingEffort]);

  const commitEffort = useCallback(
    (next: ReasoningEffort) => {
      if (next === confirmedEffortRef.current) {
        if (!savingEffort) {
          setPreviewEffort(null);
          latestPreviewRef.current = null;
        }
        return;
      }
      setPreviewEffort(next);
      const res = onChangeEffortRef.current(next);
      if (res && typeof (res as Promise<unknown>).then === 'function') {
        void (res as Promise<boolean>).finally(() => {
          if (!pointerDownRef.current) {
            setPreviewEffort(null);
            latestPreviewRef.current = null;
          }
        });
      }
    },
    [savingEffort],
  );

  const finishPointerDrag = useCallback(() => {
    clearPointerListeners();
    if (!pointerDownRef.current) return;
    pointerDownRef.current = false;
    const pending = latestPreviewRef.current;
    latestPreviewRef.current = null;
    if (pending) {
      commitEffort(pending);
    } else {
      setPreviewEffort(null);
    }
  }, [clearPointerListeners, commitEffort]);

  const displayedEffort = previewEffort ?? reasoningEffort;
  const activeEffortIndex = Math.max(
    0,
    REASONING_EFFORT_OPTIONS.findIndex((item) => item.value === displayedEffort),
  );
  const activeEffortLabel = REASONING_EFFORT_OPTIONS[activeEffortIndex].label;

  const enabledProviders = useMemo(
    () => providers.filter((p) => p.enabled && p.models.length > 0),
    [providers],
  );

  const current = useMemo(
    () =>
      resolveModelOption(providers, selectedProviderId, selectedModelId) ??
      getDefaultModelOption(providers),
    [providers, selectedProviderId, selectedModelId],
  );

  const filteredGroups = useMemo(() => {
    const q = query.trim().toLowerCase();
    return enabledProviders
      .map((provider) => {
        const models = q
          ? provider.models.filter(
              (m) =>
                m.name.toLowerCase().includes(q) ||
                m.id.toLowerCase().includes(q) ||
                provider.name.toLowerCase().includes(q),
            )
          : provider.models;
        return { provider, models };
      })
      .filter((g) => g.models.length > 0);
  }, [enabledProviders, query]);

  const modelLabel = current ? current.model.name : '选择模型';

  return (
    <Popover
      side="top"
      align="start"
      open={open}
      onOpenChange={(next) => {
        if (next && (disabled || busy)) return;
        setOpen(next);
        if (!next) {
          setQuery('');
          if (pointerDownRef.current) {
            finishPointerDrag();
          }
        }
      }}
      contentProps={{
        'aria-label': '模型与思考档位',
      }}
      trigger={
        <button
          type="button"
          className={`wb-model-btn ${busy ? 'wb-model-btn--busy' : ''}`.trim()}
          aria-label="选择模型"
          aria-describedby={descriptionId}
          aria-busy={busy || savingEffort || undefined}
          aria-disabled={disabled || busy || undefined}
          disabled={disabled}
          title={
            savingEffort
              ? '正在保存思考强度'
              : current
                ? `${current.model.name} · ${activeEffortLabel}`
                : `选择模型 · ${activeEffortLabel}`
          }
        >
          <span className="wb-model-btn__name">{modelLabel}</span>
          <span className="wb-model-btn__effort">{activeEffortLabel}</span>
          <Icon
            name="chevronDown"
            size={12}
            className="wb-model-btn__chevron"
          />
          <span id={descriptionId} className="ui-visually-hidden">
            {current
              ? `当前模型 ${current.model.name}，Reasoning ${activeEffortLabel}`
              : `未选择模型，Reasoning ${activeEffortLabel}`}
          </span>
        </button>
      }
    >
      <div className="wb-model-popover">
        <Input
          compact
          type="search"
          aria-label="搜索模型"
          placeholder="搜索模型"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoFocus
        />

        <div className="wb-model-list" role="listbox" aria-label="可用模型">
          {enabledProviders.length === 0 ? (
            <div className="wb-model-empty">尚未配置模型服务</div>
          ) : filteredGroups.length === 0 ? (
            <div className="wb-model-empty">没有匹配的模型</div>
          ) : (
            filteredGroups.map(({ provider, models }) => (
              <div key={provider.id}>
                <div className="wb-model-group-label">{provider.name}</div>
                {models.map((model) => {
                  const active =
                    current?.provider.id === provider.id &&
                    current?.model.id === model.id;
                  const hasVision = model.inputModalities?.includes('image');
                  return (
                    <button
                      key={`${provider.id}:${model.id}`}
                      type="button"
                      role="option"
                      aria-selected={active}
                      className={`wb-model-option ${active ? 'wb-model-option--active' : ''}`.trim()}
                      onClick={() => {
                        onSelect(provider.id, model.id);
                        setOpen(false);
                        setQuery('');
                      }}
                    >
                      <span className="wb-model-option__name">{model.name}</span>
                      <span className="wb-model-option__meta">
                        {hasVision ? <span>视觉</span> : null}
                        {model.reasoning ? <span>推理</span> : null}
                      </span>
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>

        <div className="wb-reasoning">
          <div className="wb-reasoning__head">
            <label htmlFor={effortInputId}>Reasoning</label>
            <output htmlFor={effortInputId} aria-hidden="true">
              {activeEffortLabel}
            </output>
          </div>
          <div
            className="wb-effort-control"
            style={{
              ['--effort-progress' as string]: `${activeEffortIndex * 20}%`,
            }}
          >
            <div className="wb-effort-track" aria-hidden="true">
              {REASONING_EFFORT_OPTIONS.map((item) => (
                <i key={item.value} />
              ))}
            </div>
            <input
              id={effortInputId}
              type="range"
              min={0}
              max={REASONING_EFFORT_OPTIONS.length - 1}
              step={1}
              value={activeEffortIndex}
              aria-label="Reasoning"
              aria-valuetext={activeEffortLabel}
              disabled={disabled || savingEffort}
              className="wb-effort-range"
              onPointerDown={() => {
                clearPointerListeners();
                pointerDownRef.current = true;
                latestPreviewRef.current = null;
                const onUp = () => finishPointerDrag();
                window.addEventListener('pointerup', onUp, { once: true });
                window.addEventListener('pointercancel', onUp, { once: true });
                pointerCleanupRef.current = () => {
                  window.removeEventListener('pointerup', onUp);
                  window.removeEventListener('pointercancel', onUp);
                };
              }}
              onPointerUp={finishPointerDrag}
              onPointerCancel={finishPointerDrag}
              onChange={(e) => {
                const idx = Number(e.currentTarget.value);
                const opt = REASONING_EFFORT_OPTIONS[idx];
                if (!opt) return;
                if (pointerDownRef.current) {
                  latestPreviewRef.current = opt.value;
                  setPreviewEffort(opt.value);
                } else {
                  commitEffort(opt.value);
                }
              }}
            />
          </div>
          <div className="wb-effort-ends" aria-hidden="true">
            <span>Off</span>
            <span>Max</span>
          </div>
        </div>

        <div className="wb-model-footer">
          <Link
            to="/settings/providers"
            state={{ from: `${location.pathname}${location.search}` }}
            className="ui-menu-item"
            onClick={() => setOpen(false)}
          >
            管理模型服务
          </Link>
        </div>
      </div>
    </Popover>
  );
}
