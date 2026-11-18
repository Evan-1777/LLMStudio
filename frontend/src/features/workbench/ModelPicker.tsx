import { useId, useMemo, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Input, Popover } from '../../components/ui';
import type { ModelConfig, ProviderConfig } from '../../core/types';

export interface SelectedModelRef {
  provider: ProviderConfig;
  model: ModelConfig;
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
  disabled = false,
  busy = false,
  onSelect,
}: {
  providers: ProviderConfig[];
  selectedProviderId: string;
  selectedModelId: string;
  disabled?: boolean;
  busy?: boolean;
  onSelect: (providerId: string, modelId: string) => void;
}) {
  const location = useLocation();
  const descriptionId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

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

  const label = current ? current.model.name : '选择模型';

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (disabled || busy) return;
        setOpen(next);
        if (!next) setQuery('');
      }}
      trigger={
        <button
          type="button"
          className={`wb-model-btn ${busy ? 'wb-model-btn--busy' : ''}`.trim()}
          aria-label="选择模型"
          aria-describedby={descriptionId}
          aria-busy={busy || undefined}
          aria-disabled={disabled || busy || undefined}
          disabled={disabled}
          title="选择模型"
        >
          <span className="wb-model-btn__name">{label}</span>
          <span id={descriptionId} className="ui-visually-hidden">
            {current ? `当前模型 ${current.model.name}` : '未选择模型'}
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
