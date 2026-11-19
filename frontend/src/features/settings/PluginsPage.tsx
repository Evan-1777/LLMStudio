import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useLocation } from 'react-router-dom';
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
  Switch,
} from '../../components/ui';
import type { SearchEngineView } from '../../core/types';
import { ApiKeyField } from './ApiKeyField';
import { errorMessageOf, validateHttpUrl } from './jsonValidation';

interface SearchFieldErrors {
  endpoint?: string;
  maxResults?: string;
}

function SearchEngineCard({
  engine,
  onDirtyChange,
}: {
  engine: SearchEngineView;
  onDirtyChange: (engineId: string, dirty: boolean) => void;
}) {
  const { gateway, refreshPlugins, toast } = useApp();

  const [endpoint, setEndpoint] = useState(
    engine.endpoint || engine.defaultEndpoint,
  );
  const [apiKey, setApiKey] = useState('');
  const [clearApiKey, setClearApiKey] = useState(false);
  const [maxResults, setMaxResults] = useState(String(engine.maxResults || 5));

  const [fieldErrors, setFieldErrors] = useState<SearchFieldErrors>({});
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(
    null,
  );

  useEffect(() => {
    setEndpoint(engine.endpoint || engine.defaultEndpoint);
    setMaxResults(String(engine.maxResults || 5));
  }, [engine.defaultEndpoint, engine.endpoint, engine.maxResults]);

  const isDirty =
    endpoint.trim() !== (engine.endpoint || engine.defaultEndpoint) ||
    maxResults.trim() !== String(engine.maxResults || 5) ||
    apiKey.trim() !== '' ||
    clearApiKey;

  useEffect(() => {
    onDirtyChange(engine.engineId, isDirty);
    return () => onDirtyChange(engine.engineId, false);
  }, [engine.engineId, isDirty, onDirtyChange]);

  const validateFields = (): {
    endpoint: string;
    maxResults: number;
  } | null => {
    const errors: SearchFieldErrors = {};
    const trimmedEndpoint = endpoint.trim();
    if (trimmedEndpoint) {
      const urlErr = validateHttpUrl(trimmedEndpoint, '服务地址');
      if (urlErr) errors.endpoint = urlErr;
    }

    const parsedMax = Number(maxResults.trim());
    if (
      maxResults.trim() === '' ||
      !Number.isInteger(parsedMax) ||
      parsedMax < 1 ||
      parsedMax > 20
    ) {
      errors.maxResults = '结果数量须为 1–20 的整数';
    }

    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      return null;
    }
    setFieldErrors({});
    return { endpoint: trimmedEndpoint, maxResults: parsedMax };
  };

  const handleSave = async (e: FormEvent) => {
    e.preventDefault();
    const valid = validateFields();
    if (!valid) return;

    setSaving(true);
    setStatus(null);
    try {
      await gateway.updateSearchEngine(engine.engineId, {
        endpoint: valid.endpoint || engine.defaultEndpoint,
        maxResults: valid.maxResults,
        ...(clearApiKey
          ? { clearApiKey: true }
          : apiKey.trim()
            ? { apiKey: apiKey.trim() }
            : {}),
      });
      await refreshPlugins();
      setApiKey('');
      setClearApiKey(false);
      setStatus({ ok: true, text: '已保存' });
      toast(`${engine.displayName || engine.engineId} 已保存`);
    } catch (err) {
      setStatus({ ok: false, text: errorMessageOf(err, '保存失败') });
    } finally {
      setSaving(false);
    }
  };

  const handleQuickUpdate = async (patch: {
    enabled?: boolean;
    isDefault?: boolean;
  }) => {
    setSaving(true);
    setStatus(null);
    try {
      await gateway.updateSearchEngine(engine.engineId, patch);
      await refreshPlugins();
      toast(`${engine.displayName || engine.engineId} 已更新`);
    } catch (err) {
      setStatus({ ok: false, text: errorMessageOf(err, '更新失败') });
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    const valid = validateFields();
    if (!valid) return;

    setTesting(true);
    setStatus(null);
    try {
      const res = await gateway.testSearchEngine(engine.engineId, {
        endpoint: valid.endpoint || undefined,
        ...(apiKey.trim() && !clearApiKey ? { apiKey: apiKey.trim() } : {}),
        maxResults: valid.maxResults,
      });
      if (!res.ok) {
        setStatus({ ok: false, text: res.message || '搜索测试失败' });
      } else {
        setStatus({
          ok: true,
          text: `${res.message || '搜索正常'} · ${res.resultCount} 条结果 · ${res.latencyMs} ms`,
        });
      }
    } catch (err) {
      setStatus({ ok: false, text: errorMessageOf(err, '搜索测试失败') });
    } finally {
      setTesting(false);
    }
  };

  const title = engine.displayName || engine.engineId;

  return (
    <form
      noValidate
      className={`st-card ${engine.isDefault ? 'st-card--highlight' : ''}`.trim()}
      onSubmit={(e) => void handleSave(e)}
      aria-label={title}
    >
      <div className="st-section-head">
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <strong style={{ fontSize: 14 }}>{title}</strong>
            {engine.isDefault ? (
              <span className="st-badge st-badge--accent">默认</span>
            ) : null}
          </div>
          <div className="st-subtitle st-mono">{engine.engineId}</div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {!engine.isDefault ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={saving}
              onClick={() => void handleQuickUpdate({ isDefault: true })}
            >
              设为默认
            </Button>
          ) : null}
          <Switch
            checked={engine.enabled}
            disabled={saving}
            label={`启用 ${title}`}
            onCheckedChange={(checked) =>
              void handleQuickUpdate({ enabled: checked })
            }
          />
        </div>
      </div>

      <div className="st-grid-2">
        <Field
          label="服务地址"
          htmlFor={`search-endpoint-${engine.engineId}`}
          error={fieldErrors.endpoint}
        >
          <Input
            id={`search-endpoint-${engine.engineId}`}
            type="url"
            placeholder={engine.defaultEndpoint}
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
          />
        </Field>

        <Field
          label="结果数量"
          htmlFor={`search-max-results-${engine.engineId}`}
          error={fieldErrors.maxResults}
        >
          <Input
            id={`search-max-results-${engine.engineId}`}
            type="number"
            min={1}
            max={20}
            value={maxResults}
            onChange={(e) => setMaxResults(e.target.value)}
          />
        </Field>
      </div>

      <Field
        label="API Key"
        htmlFor={`search-apikey-${engine.engineId}`}
      >
        <ApiKeyField
          id={`search-apikey-${engine.engineId}`}
          value={apiKey}
          clearApiKey={clearApiKey}
          apiKeySet={engine.apiKeySet}
          apiKeyMasked={engine.apiKeyMasked}
          placeholder={
            engine.apiKeySet
              ? `已保存 (${engine.apiKeyMasked || '****'})`
              : engine.requiresApiKey
                ? '必填'
                : '可选'
          }
          disabled={saving}
          onValueChange={setApiKey}
          onClearApiKeyChange={setClearApiKey}
        />
      </Field>

      <div className="st-actions-bar">
        <Button
          size="sm"
          variant="secondary"
          disabled={testing || saving}
          onClick={() => void handleTest()}
        >
          {testing ? '测试中...' : '测试搜索'}
        </Button>
        {status ? (
          <span
            role="status"
            className={`st-status-text ${
              status.ok ? 'st-status-text--ok' : 'st-status-text--error'
            }`}
          >
            {status.text}
          </span>
        ) : null}
        <span className="st-actions-bar__spacer" />
        <Button size="sm" type="submit" variant="primary" disabled={saving}>
          {saving ? '保存中...' : '保存'}
        </Button>
      </div>
    </form>
  );
}

export function PluginsPage() {
  const location = useLocation();
  const { resources, refreshPlugins, registerDirtyGuard } = useApp();
  const { searchEngines, formats, adapters } = resources;
  const dirtyEnginesRef = useRef<Set<string>>(new Set());

  const handleEngineDirtyChange = useCallback(
    (engineId: string, dirty: boolean) => {
      if (dirty) dirtyEnginesRef.current.add(engineId);
      else dirtyEnginesRef.current.delete(engineId);
    },
    [],
  );

  useEffect(() => {
    registerDirtyGuard(() => dirtyEnginesRef.current.size > 0);
    return () => registerDirtyGuard(null);
  }, [registerDirtyGuard]);

  if (resources.loading.plugins && searchEngines.length === 0) {
    return (
      <div className="st-scroll">
        <LoadingSpinner label="正在加载插件配置" />
      </div>
    );
  }

  return (
    <div className="st-scroll">
      <div className="st-container">
        <section style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div className="st-section-head">
            <h2 className="st-section-title">搜索引擎</h2>
            <IconButton
              size="sm"
              icon="refresh"
              label="刷新插件状态"
              disabled={resources.loading.plugins}
              onClick={() => void refreshPlugins()}
            />
          </div>

          {resources.error.plugins ? (
            <ErrorBanner
              message={resources.error.plugins}
              onRetry={() => void refreshPlugins()}
            />
          ) : null}

          {searchEngines.length === 0 ? (
            <div className="st-group">
              <EmptyState icon="globe" title="暂无已注册搜索引擎" />
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {searchEngines.map((engine) => (
                <SearchEngineCard
                  key={engine.engineId}
                  engine={engine}
                  onDirtyChange={handleEngineDirtyChange}
                />
              ))}
            </div>
          )}
        </section>

        <section>
          <h3 className="st-subhead">内容渲染</h3>
          <div className="st-group">
            <div className="st-row--inline">
              <span className="st-row__label--plain">
                HTML 默认预览与长内容自动折叠
              </span>
              <Link
                to="/settings/appearance"
                state={location.state}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  fontSize: 13,
                  fontWeight: 500,
                }}
              >
                <span>外观与显示</span>
                <Icon name="chevronRight" size={14} />
              </Link>
            </div>
          </div>
        </section>

        <section>
          <h3 className="st-subhead">协议格式</h3>
          {formats.length === 0 ? (
            <div className="st-group">
              <EmptyState icon="code" title="暂无协议格式元数据" />
            </div>
          ) : (
            <div className="st-group">
              {formats.map((fmt) => (
                <div key={fmt.id} className="st-row--inline">
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 500 }}>
                      {fmt.displayName}
                    </div>
                    <div className="st-subtitle st-mono">{fmt.id}</div>
                  </div>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      flexWrap: 'wrap',
                      justifyContent: 'flex-end',
                    }}
                  >
                    {fmt.defaultCompat?.thinkingFormat ? (
                      <span className="st-badge">
                        {fmt.defaultCompat.thinkingFormat}
                      </span>
                    ) : null}
                    <span className="st-row__value st-mono">
                      {fmt.defaultPath || '—'}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <section>
          <h3 className="st-subhead">适配器</h3>
          {adapters.length === 0 ? (
            <div className="st-group">
              <EmptyState icon="plugin" title="暂无适配器元数据" />
            </div>
          ) : (
            <div className="st-group">
              {adapters.map((adapter) => (
                <div key={adapter.id} className="st-row--inline">
                  <span className="st-row__label--plain">
                    {adapter.displayName}
                  </span>
                  <span className="st-row__value st-mono">{adapter.id}</span>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
