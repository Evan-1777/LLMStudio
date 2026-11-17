import { useCallback, useEffect, useMemo, useState } from 'react';
import { useApp } from '../../app/AppProvider';
import {
  Button,
  EmptyState,
  ErrorBanner,
  Icon,
  Input,
  LoadingSpinner,
  Modal,
} from '../../components/ui';
import type {
  DiscoveredModel,
  ModelConfig,
  ProviderProbeInput,
} from '../../core/types';
import { deriveModelGroup } from './endpoint';
import { errorMessageOf } from './jsonValidation';

export interface ModelImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  providerId: string;
  providerName: string;
  probeInput: ProviderProbeInput;
  existingModels: readonly ModelConfig[];
  onImport: (models: ModelConfig[]) => Promise<void>;
}

function toModelConfig(item: DiscoveredModel): ModelConfig {
  return {
    id: item.id,
    name: item.name || item.id,
    apiFormat: item.apiFormat,
    ...(item.contextWindow && item.contextWindow > 0
      ? { contextWindow: item.contextWindow }
      : {}),
    ...(item.maxTokens && item.maxTokens > 0
      ? { maxTokens: item.maxTokens }
      : {}),
    ...(item.reasoning ? { reasoning: true } : {}),
    ...(item.inputModalities && item.inputModalities.length > 0
      ? { inputModalities: item.inputModalities }
      : {}),
  };
}

export function ModelImportDialog({
  open,
  onOpenChange,
  providerId,
  providerName,
  probeInput,
  existingModels,
  onImport,
}: ModelImportDialogProps) {
  const { gateway } = useApp();

  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [discovered, setDiscovered] = useState<DiscoveredModel[]>([]);
  const [search, setSearch] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState(false);

  const existingIds = useMemo(
    () => new Set(existingModels.map((m) => m.id)),
    [existingModels],
  );

  const runFetch = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setFetchError(null);
      setSaveError(null);
      try {
        const models = await gateway.fetchProviderModels(
          providerId,
          probeInput,
          signal,
        );
        if (signal?.aborted) return;
        setDiscovered(models);
        setSelectedIds(new Set());
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        if (err instanceof Error && err.name === 'AbortError') return;
        setFetchError(errorMessageOf(err, '获取远端模型失败'));
      } finally {
        if (!signal?.aborted) {
          setLoading(false);
        }
      }
    },
    [gateway, probeInput, providerId],
  );

  useEffect(() => {
    if (!open) return;
    setSearch('');
    setDiscovered([]);
    setSelectedIds(new Set());
    const ctrl = new AbortController();
    void runFetch(ctrl.signal);
    return () => ctrl.abort();
  }, [open, runFetch]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return discovered;
    return discovered.filter(
      (m) =>
        m.id.toLowerCase().includes(q) ||
        m.name.toLowerCase().includes(q) ||
        m.group.toLowerCase().includes(q),
    );
  }, [discovered, search]);

  const groups = useMemo(() => {
    const map = new Map<string, DiscoveredModel[]>();
    for (const model of filtered) {
      const groupName = model.group?.trim() || deriveModelGroup(model.id);
      const list = map.get(groupName);
      if (list) list.push(model);
      else map.set(groupName, [model]);
    }
    return [...map.entries()];
  }, [filtered]);

  const selectableFiltered = useMemo(
    () => filtered.filter((m) => !existingIds.has(m.id)),
    [existingIds, filtered],
  );

  const toggleId = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleConfirm = async () => {
    const additions = discovered
      .filter((m) => selectedIds.has(m.id) && !existingIds.has(m.id))
      .map(toModelConfig);
    if (additions.length === 0) return;

    setImporting(true);
    setSaveError(null);
    try {
      await onImport(additions);
      onOpenChange(false);
    } catch (err) {
      setSaveError(errorMessageOf(err, '导入模型失败'));
    } finally {
      setImporting(false);
    }
  };

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (!importing) onOpenChange(next);
      }}
      title={`获取模型 · ${providerName}`}
      wide
      footer={
        <>
          <Button
            variant="secondary"
            disabled={importing}
            onClick={() => onOpenChange(false)}
          >
            取消
          </Button>
          <Button
            variant="primary"
            disabled={loading || importing || selectedIds.size === 0}
            onClick={() => void handleConfirm()}
          >
            {importing ? '导入中...' : `导入 (${selectedIds.size})`}
          </Button>
        </>
      }
    >
      {saveError ? <ErrorBanner message={saveError} /> : null}

      {loading ? (
        <div style={{ padding: '24px 0', display: 'grid', placeItems: 'center' }}>
          <LoadingSpinner label="正在获取远端模型列表" />
        </div>
      ) : fetchError ? (
        <ErrorBanner message={fetchError} onRetry={() => void runFetch()} />
      ) : discovered.length === 0 ? (
        <EmptyState
          icon="cpu"
          title="未发现可用模型"
          action={
            <Button variant="secondary" onClick={() => void runFetch()}>
              重新获取
            </Button>
          }
        />
      ) : (
        <>
          <div className="st-actions-bar">
            <div className="st-search-wrap" style={{ flex: 1, minWidth: 160 }}>
              <Icon name="search" size={14} className="st-search-icon" />
              <Input
                compact
                className="st-search-input"
                aria-label="搜索远端模型"
                placeholder="搜索远端模型"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <Button
              size="sm"
              variant="ghost"
              disabled={selectableFiltered.length === 0}
              onClick={() =>
                setSelectedIds((prev) => {
                  const next = new Set(prev);
                  for (const m of selectableFiltered) next.add(m.id);
                  return next;
                })
              }
            >
              全选可见
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={selectedIds.size === 0}
              onClick={() => setSelectedIds(new Set())}
            >
              清空选择
            </Button>
          </div>

          {groups.length === 0 ? (
            <EmptyState title="无匹配模型" />
          ) : (
            <div className="st-import-list">
              {groups.map(([groupName, models]) => (
                <div key={groupName} className="st-model-group">
                  <div className="st-model-group__head">
                    <span>{groupName}</span>
                    <span>({models.length})</span>
                  </div>
                  {models.map((m) => {
                    const alreadyExists = existingIds.has(m.id);
                    const checked = alreadyExists || selectedIds.has(m.id);
                    return (
                      <label
                        key={m.id}
                        className={`st-import-item ${
                          alreadyExists ? 'st-import-item--disabled' : ''
                        }`.trim()}
                      >
                        <input
                          type="checkbox"
                          className="st-checkbox"
                          checked={checked}
                          disabled={alreadyExists}
                          onChange={() => toggleId(m.id)}
                        />
                        <div className="st-model-main">
                          <span className="st-model-name">{m.name || m.id}</span>
                          {m.name && m.name !== m.id ? (
                            <span className="st-model-id">{m.id}</span>
                          ) : null}
                        </div>
                        <div className="st-model-meta">
                          {m.reasoning ? (
                            <Icon name="lightbulb" size={14} />
                          ) : null}
                          <span className="st-badge">{m.apiFormat}</span>
                          {alreadyExists ? (
                            <span className="st-badge st-badge--accent">
                              已配置
                            </span>
                          ) : null}
                        </div>
                      </label>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </Modal>
  );
}
