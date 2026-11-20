import { useCallback, useEffect, useState } from 'react';
import { useApp } from '../../app/AppProvider';
import { ErrorBanner, LoadingSpinner, SegmentedControl } from '../../components/ui';
import {
  getDesktopClientSettings,
  setDesktopCloseToTray,
  type DesktopClientSettings,
} from '../../core/desktop';

type CloseBehavior = 'exit' | 'tray';

function errorMessageOf(err: unknown, fallback: string): string {
  return err instanceof Error && err.message.trim() ? err.message : fallback;
}

export function ClientPage() {
  const { isDesktop } = useApp();
  const [settings, setSettings] = useState<DesktopClientSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!isDesktop) return;
    setLoading(true);
    setError(null);
    try {
      setSettings(await getDesktopClientSettings());
    } catch (err) {
      setError(errorMessageOf(err, '读取客户端设置失败'));
    } finally {
      setLoading(false);
    }
  }, [isDesktop]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!isDesktop) return null;

  const behavior: CloseBehavior = settings?.closeToTray ? 'tray' : 'exit';
  const trayAvailable = settings?.trayAvailable ?? false;

  const handleChange = async (next: CloseBehavior) => {
    if (!settings || saving || loading) return;
    const closeToTray = next === 'tray';
    if (closeToTray === settings.closeToTray) return;
    setSaving(true);
    setError(null);
    try {
      setSettings(await setDesktopCloseToTray(closeToTray));
    } catch (err) {
      setError(errorMessageOf(err, '保存客户端设置失败'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="st-scroll">
      <div className="st-container">
        <h2 className="st-section-title">客户端设置</h2>

        {error ? (
          <ErrorBanner
            message={error}
            onRetry={() => void load()}
          />
        ) : null}

        <section>
          <h3 className="st-subhead">窗口</h3>
          <div className="st-group">
            <div className="st-row--inline">
              <span className="st-row__label--plain">关闭按钮</span>
              <div className="st-client-control">
                {loading ? (
                  <LoadingSpinner label="读取客户端设置" />
                ) : (
                  <SegmentedControl<CloseBehavior>
                    ariaLabel="关闭按钮行为"
                    value={behavior}
                    disabled={saving || !settings}
                    options={[
                      { value: 'exit', label: '退出应用' },
                      {
                        value: 'tray',
                        label: '最小化到托盘',
                        disabled: !trayAvailable,
                      },
                    ]}
                    onChange={(next) => void handleChange(next)}
                  />
                )}
                {!loading && !trayAvailable ? (
                  <span className="st-subtitle">
                    系统托盘不可用，关闭按钮将退出应用。
                  </span>
                ) : null}
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
