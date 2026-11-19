import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useApp } from '../../app/AppProvider';
import {
  Button,
  Dropdown,
  DropdownItem,
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
import { useRowDrag } from '../../components/ui/useRowDrag';
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
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </Field>

        <Field label="API 地址" htmlFor="new-provider-url" error={urlError}>
          <Input
            id="new-provider-url"
            type="url"
            placeholder="https://api.example.com/v1"
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
  const { resources, refreshProviders, reorderProviders, confirmLeaveIfDirty } = useApp();
  const { providers } = resources;

  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(
    providers[0]?.id ?? null,
  );
  const [createOpen, setCreateOpen] = useState(false);
  const [reordering, setReordering] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

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

  const canReorder = !search.trim() && !createOpen && !reordering && providers.length > 1;
  const moveProvider = async (id: string, beforeId: string | null) => {
    if (!canReorder) return;
    const index = providers.findIndex((p) => p.id === id);
    if (index === -1 || (providers[index + 1]?.id ?? null) === beforeId) return;
    setReordering(true);
    try {
      await reorderProviders(id, beforeId);
    } finally {
      setReordering(false);
    }
  };

  const { drag, bind } = useRowDrag(canReorder, (id, { clientX, clientY }) => {
    const list = listRef.current;
    if (!list) return null;
    const bounds = list.getBoundingClientRect();
    if (clientX < bounds.left || clientX >= bounds.right || clientY < bounds.top || clientY >= bounds.bottom) return null;
    const horizontal = getComputedStyle(list).flexDirection === 'row';
    const rows = Array.from(list.querySelectorAll<HTMLElement>('[data-provider-id]'))
      .filter((row) => row.dataset.providerId !== id);
    const next = rows.find((row) => {
      const rect = row.getBoundingClientRect();
      return horizontal ? clientX < rect.left + rect.width / 2 : clientY < rect.top + rect.height / 2;
    });
    const beforeId = next?.dataset.providerId ?? null;
    const from = providers.findIndex((p) => p.id === id);
    if (from === -1 || (providers[from + 1]?.id ?? null) === beforeId) return null;
    return { beforeId, markerId: (next ?? rows.at(-1))?.dataset.providerId };
  }, (id, target) => void moveProvider(id, target.beforeId));

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
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <div className="st-search-wrap" style={{ flex: 1 }}>
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
          <IconButton
            size="sm"
            icon="plus"
            label="添加供应商"
            onClick={() => void handleOpenCreate()}
          />
        </div>

        <div ref={listRef} className="st-provider-scroll">
          {filtered.map((p, index) => {
            const active = p.id === selectedProvider?.id;
            const initial = p.name.trim().charAt(0).toUpperCase() || '?';
            const marker = drag?.target?.markerId === p.id
              ? (drag.target.beforeId ? 'before' : 'after')
              : undefined;
            return (
              <div
                key={p.id}
                className={`st-provider-row${active ? ' st-provider-row--active' : ''}`}
                data-provider-id={p.id}
                data-provider-drop={marker}
              >
                <button
                  {...bind(p.id)}
                  type="button"
                  className={`st-provider-item${active ? ' st-provider-item--active' : ''}`}
                  aria-current={active ? 'true' : undefined}
                  draggable={false}
                  onClick={() => void handleSelectProvider(p.id)}
                >
                  <span className="st-provider-badge" aria-hidden="true">
                    {initial}
                  </span>
                  <span className="st-provider-meta">
                    <span className="st-provider-name">{p.name}</span>
                    <span className="st-provider-sub">{p.models.length} 个模型</span>
                  </span>
                  {p.localRequest ? <span className="st-badge st-badge--accent">本地</span> : null}
                  {!p.enabled ? <span className="st-badge st-badge--muted">停用</span> : null}
                </button>
                <Dropdown
                  align="end"
                  trigger={<IconButton icon="ellipsis" label={`调整 ${p.name} 的顺序`} disabled={!canReorder} />}
                >
                  <DropdownItem
                    disabled={index === 0}
                    onSelect={() => void moveProvider(p.id, providers[index - 1]?.id ?? null)}
                  >
                    上移
                  </DropdownItem>
                  <DropdownItem
                    disabled={index === providers.length - 1}
                    onSelect={() => void moveProvider(p.id, providers[index + 2]?.id ?? null)}
                  >
                    下移
                  </DropdownItem>
                </Dropdown>
              </div>
            );
          })}
        </div>
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
