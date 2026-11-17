import { useMemo, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Icon, Input, Popover } from '../../components/ui';
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
  onSelect,
}: {
  providers: ProviderConfig[];
  selectedProviderId: string;
  selectedModelId: string;
  disabled?: boolean;
  onSelect: (providerId: string, modelId: string) => void;
}) {
  const location = useLocation();
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

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (disabled) return;
        setOpen(next);
        if (!next) setQuery('');
      }}
      trigger={
        <button
          type="button"
          className="wb-model-btn"
          aria-label="选择模型"
          disabled={disabled}
        >
          <Icon name="cpu" size={14} />
          <span className="wb-model-btn__name">
            {current ? current.model.name : '选择模型'}
          </span>
          {current ? (
            <span className="wb-model-btn__prov wb-desktop-only">
              {current.provider.name}
            </span>
          ) : null}
          <Icon name="chevronsUpDown" size={13} />
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
          {filteredGroups.length === 0 ? (
            <div
              style={{
                padding: '18px 8px',
                textAlign: 'center',
                fontSize: 12,
                color: 'var(--text-tertiary)',
              }}
            >
              无可用模型
            </div>
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
                      <span
                        style={{
                          minWidth: 0,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {model.name}
                      </span>
                      <span className="wb-model-option__meta">
                        {hasVision ? (
                          <span title="视觉输入">
                            <Icon name="image" size={13} />
                          </span>
                        ) : null}
                        {model.reasoning ? (
                          <span title="推理模型">
                            <Icon name="lightbulb" size={13} />
                          </span>
                        ) : null}
                        {active ? <Icon name="check" size={14} /> : null}
                      </span>
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>

        <div
          style={{
            marginTop: 6,
            paddingTop: 6,
            borderTop: '1px solid var(--border-hairline)',
          }}
        >
          <Link
            to="/settings/providers"
            state={{ from: `${location.pathname}${location.search}` }}
            className="ui-menu-item"
            style={{ fontSize: 12, color: 'var(--text-secondary)' }}
            onClick={() => setOpen(false)}
          >
            <Icon name="settings" size={14} />
            <span>管理模型服务</span>
          </Link>
        </div>
      </div>
    </Popover>
  );
}
