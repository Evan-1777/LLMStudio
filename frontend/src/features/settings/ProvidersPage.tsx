import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useApp } from '../../app/AppProvider';
import {
  Button,
  EmptyState,
  ErrorBanner,
  Field,
  Icon,
  IconButton,
  Input,
  LoadingSpinner,
  Modal,
  Select,
  Switch,
} from '../../components/ui';
import type { AuthType } from '../../core/types';
import { ProviderEditor } from './ProviderEditor';
import { errorMessageOf, validateHttpUrl } from './jsonValidation';

const AUTH_TYPES: readonly AuthType[] = [
  'bearer',
  'x-api-key',
  'query-key',
  'header-key',
  'none',
];

function CreateProviderModal({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (providerId: string) => void;
}) {
  const { gateway, resources, upsertLocalProvider, toast } = useApp();

  const [name, setName] = useState('');
  const [adapter, setAdapter] = useState('generic-http');
  const [baseURL, setBaseURL] = useState('');
  const [authType, setAuthType] = useState<string>('bearer');
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [localRequest, setLocalRequest] = useState(false);

  const [nameError, setNameError] = useState<string | null>(null);
  const [urlError, setUrlError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName('');
    setAdapter(resources.adapters[0]?.id ?? 'generic-http');
    setBaseURL('');
    setAuthType('bearer');
    setApiKey('');
    setShowKey(false);
    setLocalRequest(false);
    setNameError(null);
    setUrlError(null);
    setSubmitError(null);
  }, [open, resources.adapters]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmedName = name.trim();
    const nextNameErr = trimmedName ? null : '名称不能为空';
    const nextUrlErr = validateHttpUrl(baseURL, 'API 地址');
    setNameError(nextNameErr);
    setUrlError(nextUrlErr);
    if (nextNameErr || nextUrlErr) return;

    setSaving(true);
    setSubmitError(null);
    try {
      const trimmedKey = apiKey.trim();
      const created = await gateway.createProvider({
        name: trimmedName,
        adapter,
        baseURL: baseURL.trim(),
        authType,
        ...(trimmedKey ? { apiKey: trimmedKey } : {}),
        models: [],
        enabled: true,
        localRequest,
      });
      upsertLocalProvider(created);
      onCreated(created.id);
      onOpenChange(false);
      toast('供应商已添加');
    } catch (err) {
      setSubmitError(errorMessageOf(err, '创建供应商失败'));
    } finally {
      setSaving(false);
    }
  };

  const adapters =
    resources.adapters.length > 0
      ? resources.adapters
      : [{ id: 'generic-http', displayName: 'Generic HTTP' }];

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (!saving) onOpenChange(next);
      }}
      title="添加供应商"
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
            form="create-provider-form"
            variant="primary"
            disabled={saving}
          >
            {saving ? '添加中...' : '添加'}
          </Button>
        </>
      }
    >
      <form
        id="create-provider-form"
        noValidate
        onSubmit={(e) => void handleSubmit(e)}
        style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
      >
        {submitError ? <ErrorBanner message={submitError} /> : null}

        <Field label="名称" htmlFor="new-provider-name" error={nameError}>
          <Input
            id="new-provider-name"
            placeholder="OpenAI"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </Field>

        <Field label="API 地址" htmlFor="new-provider-url" error={urlError}>
          <Input
            id="new-provider-url"
            type="url"
            placeholder="https://api.openai.com/v1"
            value={baseURL}
            onChange={(e) => setBaseURL(e.target.value)}
            required
          />
        </Field>

        <div className="st-grid-2">
          <Field label="适配器" htmlFor="new-provider-adapter">
            <Select
              id="new-provider-adapter"
              value={adapter}
              onChange={(e) => setAdapter(e.target.value)}
            >
              {adapters.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.displayName}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="鉴权方式" htmlFor="new-provider-auth">
            <Select
              id="new-provider-auth"
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

        <Field label="API Key" htmlFor="new-provider-key">
          <div className="ui-input-group">
            <Input
              id="new-provider-key"
              type={showKey ? 'text' : 'password'}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              autoComplete="off"
            />
            <IconButton
              size="sm"
              icon={showKey ? 'eyeOff' : 'eye'}
              label={showKey ? '隐藏密钥' : '显示密钥'}
              onClick={() => setShowKey((v) => !v)}
            />
          </div>
        </Field>

        <div className="st-row--inline" style={{ padding: '4px 0' }}>
          <span className="st-row__label--plain">本地请求</span>
          <Switch
            checked={localRequest}
            label="本地请求"
            onCheckedChange={setLocalRequest}
          />
        </div>
      </form>
    </Modal>
  );
}

export function ProvidersPage() {
  const { resources, refreshProviders, confirmLeaveIfDirty } = useApp();
  const { providers } = resources;

  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(
    providers[0]?.id ?? null,
  );
  const [createOpen, setCreateOpen] = useState(false);

  useEffect(() => {
    if (providers.length === 0) {
      if (selectedId !== null) setSelectedId(null);
      return;
    }
    if (!selectedId || !providers.some((p) => p.id === selectedId)) {
      setSelectedId(providers[0].id);
    }
  }, [providers, selectedId]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return providers;
    return providers.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.id.toLowerCase().includes(q) ||
        p.baseURL.toLowerCase().includes(q),
    );
  }, [providers, search]);

  const selectedProvider =
    providers.find((p) => p.id === selectedId) ?? providers[0] ?? null;

  const handleSelectProvider = async (nextId: string) => {
    if (nextId === selectedProvider?.id) return;
    if (!(await confirmLeaveIfDirty())) return;
    setSelectedId(nextId);
  };

  const handleOpenCreate = async () => {
    if (selectedProvider && !(await confirmLeaveIfDirty())) return;
    setCreateOpen(true);
  };

  if (resources.loading.providers && providers.length === 0) {
    return (
      <div className="st-scroll">
        <LoadingSpinner label="正在加载模型服务" />
      </div>
    );
  }

  if (resources.error.providers && providers.length === 0) {
    return (
      <div className="st-scroll">
        <div className="st-container">
          <ErrorBanner
            message={resources.error.providers}
            onRetry={() => void refreshProviders()}
          />
        </div>
      </div>
    );
  }

  if (providers.length === 0) {
    return (
      <div className="st-scroll">
        <div className="st-container">
          <EmptyState
            icon="cpu"
            title="暂无模型服务"
            action={
              <Button variant="primary" onClick={() => setCreateOpen(true)}>
                添加供应商
              </Button>
            }
          />
        </div>
        <CreateProviderModal
          open={createOpen}
          onOpenChange={setCreateOpen}
          onCreated={(id) => setSelectedId(id)}
        />
      </div>
    );
  }

  return (
    <div className="st-provider-layout">
      <aside className="st-provider-list" aria-label="供应商列表">
        <div className="st-search-wrap">
          <Icon name="search" size={14} className="st-search-icon" />
          <Input
            compact
            className="st-search-input"
            aria-label="搜索供应商"
            placeholder="搜索供应商"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <div className="st-provider-scroll">
          {filtered.map((p) => {
            const active = p.id === selectedProvider?.id;
            const initial = p.name.trim().charAt(0).toUpperCase() || '?';
            return (
              <button
                key={p.id}
                type="button"
                className={`st-provider-item ${
                  active ? 'st-provider-item--active' : ''
                }`.trim()}
                aria-current={active ? 'true' : undefined}
                onClick={() => void handleSelectProvider(p.id)}
              >
                <span className="st-provider-badge" aria-hidden="true">
                  {initial}
                </span>
                <span className="st-provider-meta">
                  <span className="st-provider-name">{p.name}</span>
                  <span className="st-provider-sub">
                    {p.models.length} 个模型
                  </span>
                </span>
                {p.localRequest ? (
                  <span className="st-badge st-badge--accent">本地</span>
                ) : null}
                {!p.enabled ? (
                  <span className="st-badge st-badge--muted">停用</span>
                ) : null}
              </button>
            );
          })}
        </div>

        <Button
          variant="secondary"
          onClick={() => void handleOpenCreate()}
          style={{ width: '100%' }}
        >
          <Icon name="plus" size={15} />
          <span>添加供应商</span>
        </Button>
      </aside>

      <section className="st-provider-detail" aria-label="供应商详情">
        {selectedProvider ? (
          <ProviderEditor
            provider={selectedProvider}
            onDeleted={(deletedId) => {
              const remaining = providers.filter((p) => p.id !== deletedId);
              setSelectedId(remaining[0]?.id ?? null);
            }}
          />
        ) : null}
      </section>

      <CreateProviderModal
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(id) => setSelectedId(id)}
      />
    </div>
  );
}
