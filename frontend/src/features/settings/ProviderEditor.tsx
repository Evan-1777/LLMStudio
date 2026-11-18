import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useApp } from '../../app/AppProvider';
import {
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorBanner,
  Field,
  Icon,
  IconButton,
  Input,
  Select,
  Switch,
  Textarea,
} from '../../components/ui';
import {
  importLegacyProviderKeys,
} from '../../core/localProviderKeys';
import type {
  AuthType,
  ModelConfig,
  ProviderConfig,
  ProviderProbeInput,
} from '../../core/types';
import { ApiKeyField } from './ApiKeyField';
import { ModelEditor } from './ModelEditor';
import { ModelImportDialog } from './ModelImportDialog';
import { buildEndpointPreview, deriveModelGroup, extractHost } from './endpoint';
import {
  errorMessageOf,
  parseJsonStringMap,
  validateHttpUrl,
} from './jsonValidation';

const AUTH_TYPES: readonly AuthType[] = [
  'bearer',
  'x-api-key',
  'query-key',
  'header-key',
  'none',
];

function serializeHeaders(headers?: Record<string, string>): string {
  if (!headers || Object.keys(headers).length === 0) return '';
  return JSON.stringify(headers, null, 2);
}

interface ProviderFieldErrors {
  name?: string;
  baseURL?: string;
  headers?: string;
}

export interface ProviderEditorProps {
  provider: ProviderConfig;
  onDeleted: (deletedId: string) => void;
}

export function ProviderEditor({ provider, onDeleted }: ProviderEditorProps) {
  const {
    gateway,
    resources,
    upsertLocalProvider,
    removeLocalProvider,
    registerDirtyGuard,
    refreshProviders,
    toast,
  } = useApp();

  const [name, setName] = useState(provider.name);
  const [adapter, setAdapter] = useState(provider.adapter);
  const [baseURL, setBaseURL] = useState(provider.baseURL);
  const [authType, setAuthType] = useState(provider.authType);
  const [apiKey, setApiKey] = useState('');
  const [clearApiKey, setClearApiKey] = useState(false);
  const [localRequest, setLocalRequest] = useState(
    Boolean(provider.localRequest),
  );
  const [headersText, setHeadersText] = useState(() =>
    serializeHeaders(provider.headers),
  );
  const [initialHeadersText, setInitialHeadersText] = useState(() =>
    serializeHeaders(provider.headers),
  );

  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<ProviderFieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [toggling, setToggling] = useState(false);

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    text: string;
  } | null>(null);

  const [modelSearch, setModelSearch] = useState('');
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(
    () => new Set(),
  );
  const [previewModelId, setPreviewModelId] = useState<string | null>(
    provider.models[0]?.id ?? null,
  );

  const [modelEditorOpen, setModelEditorOpen] = useState(false);
  const [editingModel, setEditingModel] = useState<ModelConfig | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const syncDraftFromProvider = (p: ProviderConfig) => {
    const serialized = serializeHeaders(p.headers);
    setName(p.name);
    setAdapter(p.adapter);
    setBaseURL(p.baseURL);
    setAuthType(p.authType);
    setApiKey('');
    setClearApiKey(false);
    setLocalRequest(Boolean(p.localRequest));
    setHeadersText(serialized);
    setInitialHeadersText(serialized);
    setFieldErrors({});
    setFormError(null);
    setTestResult(null);
    setModelSearch('');
    setPreviewModelId(p.models[0]?.id ?? null);
  };

  const prevProviderIdRef = useRef(provider.id);
  useEffect(() => {
    if (prevProviderIdRef.current !== provider.id) {
      prevProviderIdRef.current = provider.id;
      syncDraftFromProvider(provider);
    }
  }, [provider]);

  // Adopt any pre-migration browser credential exactly once; the gateway refuses
  // to overwrite values it or another browser already committed.
  useEffect(() => {
    if (!provider.localRequest) return;
    let cancelled = false;
    void importLegacyProviderKeys(gateway, [provider.id]).then(() => {
      if (cancelled) return;
      void refreshProviders();
    });
    return () => {
      cancelled = true;
    };
  }, [gateway, provider.id, provider.localRequest, refreshProviders]);

  const isDirty =
    name.trim() !== provider.name ||
    adapter !== provider.adapter ||
    baseURL.trim() !== provider.baseURL ||
    authType !== provider.authType ||
    apiKey.trim() !== '' ||
    clearApiKey ||
    localRequest !== Boolean(provider.localRequest) ||
    headersText !== initialHeadersText;

  const isDirtyRef = useRef(isDirty);
  isDirtyRef.current = isDirty;

  useEffect(() => {
    registerDirtyGuard(() => isDirtyRef.current);
    return () => registerDirtyGuard(null);
  }, [registerDirtyGuard]);

  const activePreviewModel = useMemo(() => {
    if (provider.models.length === 0) return null;
    if (previewModelId) {
      const found = provider.models.find((m) => m.id === previewModelId);
      if (found) return found;
    }
    return provider.models[0];
  }, [previewModelId, provider.models]);

  const endpointPreview = useMemo(
    () =>
      buildEndpointPreview({
        baseURL,
        model: activePreviewModel,
        formats: resources.formats,
      }),
    [activePreviewModel, baseURL, resources.formats],
  );

  const buildProbeInput = (): ProviderProbeInput | null => {
    const errors: ProviderFieldErrors = {};
    const urlErr = validateHttpUrl(baseURL, 'API 地址');
    if (urlErr) errors.baseURL = urlErr;

    const headersParsed = parseJsonStringMap(headersText, '请求头');
    if (!headersParsed.ok) {
      errors.headers = headersParsed.error;
    }

    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      if (errors.headers) setAdvancedOpen(true);
      return null;
    }
    setFieldErrors({});

    return {
      baseURL: baseURL.trim(),
      authType,
      ...(apiKey.trim() && !clearApiKey ? { apiKey: apiKey.trim() } : {}),
      headers: headersParsed.ok ? headersParsed.value : {},
    };
  };

  const handleTestConnection = async () => {
    const probe = buildProbeInput();
    if (!probe) return;
    setTesting(true);
    setTestResult(null);
    setFormError(null);
    try {
      // The gateway resolves stored credentials, including local-request providers.
      const res = await gateway.testProviderConnection(provider.id, probe);
      setTestResult({
        ok: res.ok,
        text: `${res.message || '连接正常'} · ${res.latencyMs} ms · ${res.modelCount} 个模型`,
      });
    } catch (err) {
      setTestResult({
        ok: false,
        text: errorMessageOf(err, '连接测试失败'),
      });
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async (e: FormEvent) => {
    e.preventDefault();
    const errors: ProviderFieldErrors = {};
    const trimmedName = name.trim();
    if (!trimmedName) errors.name = '名称不能为空';
    const urlErr = validateHttpUrl(baseURL, 'API 地址');
    if (urlErr) errors.baseURL = urlErr;
    const headersParsed = parseJsonStringMap(headersText, '请求头');
    if (!headersParsed.ok) errors.headers = headersParsed.error;

    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      if (errors.headers) setAdvancedOpen(true);
      return;
    }

    setFieldErrors({});
    setFormError(null);
    setSaving(true);
    try {
      const trimmedKey = apiKey.trim();
      const updated = await gateway.updateProvider(provider.id, {
        name: trimmedName,
        adapter,
        baseURL: baseURL.trim(),
        authType,
        ...(clearApiKey
          ? { clearApiKey: true }
          : trimmedKey
            ? { apiKey: trimmedKey }
            : {}),
        headers: headersParsed.ok ? headersParsed.value : {},
        models: provider.models,
        enabled: provider.enabled,
        localRequest,
      });
      upsertLocalProvider(updated);
      const savedHeaders = serializeHeaders(updated.headers);
      setName(updated.name);
      setAdapter(updated.adapter);
      setBaseURL(updated.baseURL);
      setAuthType(updated.authType);
      setApiKey('');
      setClearApiKey(false);
      setLocalRequest(Boolean(updated.localRequest));
      setHeadersText(savedHeaders);
      setInitialHeadersText(savedHeaders);
      toast('供应商已保存');
    } catch (err) {
      setFormError(errorMessageOf(err, '保存供应商失败'));
    } finally {
      setSaving(false);
    }
  };

  const handleToggleEnabled = async (nextEnabled: boolean) => {
    setToggling(true);
    setFormError(null);
    try {
      const updated = await gateway.updateProvider(provider.id, {
        name: provider.name,
        adapter: provider.adapter,
        baseURL: provider.baseURL,
        authType: provider.authType,
        headers: provider.headers ?? {},
        models: provider.models,
        enabled: nextEnabled,
        localRequest: provider.localRequest,
      });
      upsertLocalProvider(updated);
      toast(nextEnabled ? '供应商已启用' : '供应商已停用');
    } catch (err) {
      setFormError(errorMessageOf(err, '切换状态失败'));
    } finally {
      setToggling(false);
    }
  };

  const persistModels = async (nextModels: ModelConfig[]) => {
    const updated = await gateway.updateProvider(provider.id, {
      name: provider.name,
      adapter: provider.adapter,
      baseURL: provider.baseURL,
      authType: provider.authType,
      headers: provider.headers ?? {},
      models: nextModels,
      enabled: provider.enabled,
      localRequest: provider.localRequest,
    });
    upsertLocalProvider(updated);
    return updated;
  };

  const handleSaveModel = async (nextModel: ModelConfig) => {
    const nextModels = [...provider.models];
    if (editingModel) {
      const idx = nextModels.findIndex((m) => m.id === editingModel.id);
      if (idx >= 0) nextModels[idx] = nextModel;
      else nextModels.push(nextModel);
    } else {
      nextModels.push(nextModel);
    }
    await persistModels(nextModels);
    setPreviewModelId(nextModel.id);
    toast(editingModel ? '模型已更新' : '模型已添加');
  };

  const handleRemoveModel = async (modelId: string) => {
    setFormError(null);
    const nextModels = provider.models.filter((m) => m.id !== modelId);
    try {
      await persistModels(nextModels);
      if (previewModelId === modelId) {
        setPreviewModelId(nextModels[0]?.id ?? null);
      }
      toast('模型已移除');
    } catch (err) {
      setFormError(errorMessageOf(err, '移除模型失败'));
    }
  };

  const handleImportModels = async (additions: ModelConfig[]) => {
    const existingIds = new Set(provider.models.map((m) => m.id));
    const uniqueNew = additions.filter((m) => !existingIds.has(m.id));
    if (uniqueNew.length === 0) return;
    await persistModels([...provider.models, ...uniqueNew]);
    toast(`已导入 ${uniqueNew.length} 个模型`);
  };

  const handleDeleteProvider = async () => {
    setDeleting(true);
    setFormError(null);
    try {
      await gateway.deleteProvider(provider.id);
      removeLocalProvider(provider.id);
      setConfirmDeleteOpen(false);
      onDeleted(provider.id);
      toast('供应商已删除');
    } catch (err) {
      setConfirmDeleteOpen(false);
      setFormError(errorMessageOf(err, '删除供应商失败'));
    } finally {
      setDeleting(false);
    }
  };

  const filteredModels = useMemo(() => {
    const q = modelSearch.trim().toLowerCase();
    if (!q) return provider.models;
    return provider.models.filter(
      (m) =>
        m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q),
    );
  }, [modelSearch, provider.models]);

  const modelGroups = useMemo(() => {
    const map = new Map<string, ModelConfig[]>();
    for (const model of filteredModels) {
      const g = deriveModelGroup(model.id);
      const list = map.get(g);
      if (list) list.push(model);
      else map.set(g, [model]);
    }
    return [...map.entries()];
  }, [filteredModels]);

  const adapterOptions = useMemo(() => {
    const list = [...resources.adapters];
    if (adapter && !list.some((a) => a.id === adapter)) {
      list.push({ id: adapter, displayName: adapter });
    }
    return list;
  }, [adapter, resources.adapters]);

  const host = extractHost(provider.baseURL);

  const openImport = () => {
    if (!buildProbeInput()) return;
    setImportOpen(true);
  };

  const probeSnapshot: ProviderProbeInput = {
    baseURL: baseURL.trim(),
    authType,
    ...(apiKey.trim() && !clearApiKey ? { apiKey: apiKey.trim() } : {}),
    headers: (() => {
      const parsed = parseJsonStringMap(headersText, '请求头');
      return parsed.ok ? parsed.value : {};
    })(),
  };

  return (
    <div className="st-provider-detail-inner">
      <div className="st-section-head">
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <h2 className="st-section-title">{provider.name}</h2>
            {provider.builtIn ? <span className="st-badge">内置</span> : null}
            {provider.localRequest ? (
              <span className="st-badge st-badge--accent">本地</span>
            ) : null}
          </div>
          {host ? <div className="st-subtitle">{host}</div> : null}
        </div>
        <Switch
          checked={provider.enabled}
          disabled={toggling || saving}
          label={`启用 ${provider.name}`}
          onCheckedChange={(checked) => void handleToggleEnabled(checked)}
        />
      </div>

      {formError ? <ErrorBanner message={formError} /> : null}

      <form
        noValidate
        onSubmit={(e) => void handleSave(e)}
        style={{ display: 'flex', flexDirection: 'column', gap: 14 }}
      >
        <div className="st-group">
          <div className="st-row">
            <label className="st-row__label" htmlFor="provider-name">
              名称
            </label>
            <div className="st-row__control">
              <Input
                id="provider-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
              {fieldErrors.name ? (
                <span className="ui-field__error" role="alert">
                  {fieldErrors.name}
                </span>
              ) : null}
            </div>
          </div>

          <div className="st-row">
            <label className="st-row__label" htmlFor="provider-base-url">
              API 地址
            </label>
            <div className="st-row__control">
              <Input
                id="provider-base-url"
                type="url"
                placeholder="https://api.openai.com/v1"
                value={baseURL}
                onChange={(e) => setBaseURL(e.target.value)}
                required
              />
              {fieldErrors.baseURL ? (
                <span className="ui-field__error" role="alert">
                  {fieldErrors.baseURL}
                </span>
              ) : null}
            </div>
          </div>

          <div className="st-endpoint-preview" data-testid="provider-endpoint-preview">
            <span style={{ color: 'var(--text-tertiary)', flex: 'none' }}>
              端点预览
            </span>
            <span>{endpointPreview || '—'}</span>
          </div>

          <div className="st-row">
            <label className="st-row__label" htmlFor="provider-api-key">
              API Key
            </label>
            <div className="st-row__control">
              <ApiKeyField
                id="provider-api-key"
                value={apiKey}
                clearApiKey={clearApiKey}
                apiKeySet={provider.apiKeySet}
                apiKeyMasked={provider.apiKeyMasked}
                placeholder={
                  authType === 'none' ? '当前鉴权无需密钥' : undefined
                }
                disabled={saving}
                onValueChange={setApiKey}
                onClearApiKeyChange={setClearApiKey}
              />
            </div>
          </div>

          <div className="st-row--inline">
            <span className="st-row__label--plain">本地请求</span>
            <Switch
              checked={localRequest}
              disabled={saving}
              label="本地请求"
              onCheckedChange={setLocalRequest}
            />
          </div>
        </div>

        <details
          className="st-details"
          open={advancedOpen}
          onToggle={(e) => setAdvancedOpen(e.currentTarget.open)}
        >
          <summary className="st-details__summary">供应商高级设置</summary>
          <div className="st-details__body">
            <div className="st-grid-2">
              <Field label="适配器" htmlFor="provider-adapter">
                <Select
                  id="provider-adapter"
                  value={adapter}
                  onChange={(e) => setAdapter(e.target.value)}
                >
                  {adapterOptions.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.displayName}
                    </option>
                  ))}
                </Select>
              </Field>

              <Field label="鉴权方式" htmlFor="provider-auth-type">
                <Select
                  id="provider-auth-type"
                  value={authType}
                  onChange={(e) => setAuthType(e.target.value)}
                >
                  {AUTH_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {type}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>

            <Field
              label="请求头 (JSON)"
              htmlFor="provider-headers"
              error={fieldErrors.headers}
            >
              <Textarea
                id="provider-headers"
                rows={3}
                className="st-mono"
                placeholder="{}"
                value={headersText}
                onChange={(e) => setHeadersText(e.target.value)}
              />
            </Field>
          </div>
        </details>

        <div className="st-actions-bar">
          <Button
            variant="secondary"
            disabled={testing || saving}
            onClick={() => void handleTestConnection()}
          >
            {testing ? '测试中...' : '测试连接'}
          </Button>
          {testResult ? (
            <span
              role="status"
              className={`st-status-text ${
                testResult.ok ? 'st-status-text--ok' : 'st-status-text--error'
              }`}
            >
              {testResult.text}
            </span>
          ) : null}
          <span className="st-actions-bar__spacer" />
          {isDirty ? (
            <Button
              variant="ghost"
              disabled={saving}
              onClick={() => syncDraftFromProvider(provider)}
            >
              还原
            </Button>
          ) : null}
          <Button
            variant="danger-ghost"
            disabled={saving || deleting}
            onClick={() => setConfirmDeleteOpen(true)}
          >
            删除供应商
          </Button>
          <Button type="submit" variant="primary" disabled={saving}>
            {saving ? '保存中...' : '保存'}
          </Button>
        </div>
      </form>

      <section
        aria-label="模型列表"
        style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
      >
        <div className="st-section-head">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>模型</h3>
            <span className="st-badge">{provider.models.length}</span>
          </div>

          <div className="st-actions-bar">
            {provider.models.length > 0 ? (
              <div className="st-search-wrap" style={{ width: 170 }}>
                <Icon name="search" size={14} className="st-search-icon" />
                <Input
                  compact
                  className="st-search-input"
                  aria-label="过滤模型"
                  placeholder="过滤模型"
                  value={modelSearch}
                  onChange={(e) => setModelSearch(e.target.value)}
                />
              </div>
            ) : null}
            <Button size="sm" variant="secondary" onClick={openImport}>
              获取模型
            </Button>
            <IconButton
              size="sm"
              icon="plus"
              label="添加模型"
              onClick={() => {
                setEditingModel(null);
                setModelEditorOpen(true);
              }}
            />
          </div>
        </div>

        {provider.models.length === 0 ? (
          <div className="st-group">
            <EmptyState
              icon="cpu"
              title="暂无模型"
              action={
                <div className="st-actions-bar">
                  <Button size="sm" variant="secondary" onClick={openImport}>
                    获取模型
                  </Button>
                  <Button
                    size="sm"
                    variant="primary"
                    onClick={() => {
                      setEditingModel(null);
                      setModelEditorOpen(true);
                    }}
                  >
                    添加模型
                  </Button>
                </div>
              }
            />
          </div>
        ) : modelGroups.length === 0 ? (
          <div className="st-group">
            <EmptyState title="无匹配模型" />
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {modelGroups.map(([groupName, models]) => {
              const collapsed = collapsedGroups.has(groupName);
              return (
                <div key={groupName} className="st-model-group">
                  <button
                    type="button"
                    className={`st-model-group__head ${
                      collapsed ? 'st-model-group__head--collapsed' : ''
                    }`.trim()}
                    aria-expanded={!collapsed}
                    onClick={() =>
                      setCollapsedGroups((prev) => {
                        const next = new Set(prev);
                        if (next.has(groupName)) next.delete(groupName);
                        else next.add(groupName);
                        return next;
                      })
                    }
                  >
                    <Icon
                      name={collapsed ? 'chevronRight' : 'chevronDown'}
                      size={14}
                    />
                    <span>{groupName}</span>
                    <span style={{ color: 'var(--text-tertiary)' }}>
                      ({models.length})
                    </span>
                  </button>

                  {!collapsed
                    ? models.map((model) => {
                        const isPreviewing = activePreviewModel?.id === model.id;
                        return (
                          <div
                            key={model.id}
                            className={`st-model-row ${
                              isPreviewing ? 'st-model-row--selected' : ''
                            }`.trim()}
                          >
                            <button
                              type="button"
                              className="st-model-main"
                              onClick={() => setPreviewModelId(model.id)}
                            >
                              <span className="st-model-name">
                                {model.name || model.id}
                              </span>
                              {model.name !== model.id ? (
                                <span className="st-model-id">{model.id}</span>
                              ) : null}
                            </button>
                            <div className="st-model-meta">
                              {model.inputModalities?.includes('image') ? (
                                <span title="视觉输入" aria-label="视觉输入">
                                  <Icon name="image" size={14} />
                                </span>
                              ) : null}
                              {model.reasoning ? (
                                <span title="推理模型" aria-label="推理模型">
                                  <Icon name="lightbulb" size={14} />
                                </span>
                              ) : null}
                              <span className="st-badge">{model.apiFormat}</span>
                              <IconButton
                                size="sm"
                                icon="sliders"
                                label={`编辑 ${model.name || model.id}`}
                                onClick={() => {
                                  setEditingModel(model);
                                  setModelEditorOpen(true);
                                }}
                              />
                              <IconButton
                                size="sm"
                                icon="trash"
                                tone="danger"
                                label={`移除 ${model.name || model.id}`}
                                onClick={() => void handleRemoveModel(model.id)}
                              />
                            </div>
                          </div>
                        );
                      })
                    : null}
                </div>
              );
            })}
          </div>
        )}
      </section>

      <ModelEditor
        open={modelEditorOpen}
        onOpenChange={setModelEditorOpen}
        existing={editingModel}
        existingModels={provider.models}
        formats={resources.formats}
        onSave={handleSaveModel}
      />

      <ModelImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        providerId={provider.id}
        providerName={provider.name}
        probeInput={probeSnapshot}
        existingModels={provider.models}
        onImport={handleImportModels}
      />

      <ConfirmDialog
        open={confirmDeleteOpen}
        onOpenChange={setConfirmDeleteOpen}
        title="删除供应商？"
        message={`确认删除「${provider.name}」？对应的模型配置也将一并删除。`}
        confirmLabel="删除"
        busy={deleting}
        onConfirm={handleDeleteProvider}
      />
    </div>
  );
}
