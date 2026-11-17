import { useEffect, useState } from 'react';
import { useApp } from '../../app/AppProvider';
import {
  Button,
  ErrorBanner,
  Icon,
  Input,
  SegmentedControl,
  Switch,
} from '../../components/ui';
import {
  PRESET_ACCENT_COLORS,
  type ChatDisplayMode,
  type ThemeMode,
} from '../../core/settings';

export function AppearancePage() {
  const {
    settings,
    resolvedTheme,
    settingsNotice,
    dismissSettingsNotice,
    updateSettings,
  } = useApp();

  const [lineInput, setLineInput] = useState(
    String(settings.collapseLineThreshold),
  );
  const [charInput, setCharInput] = useState(
    String(settings.collapseCharThreshold),
  );
  const [lineError, setLineError] = useState<string | null>(null);
  const [charError, setCharError] = useState<string | null>(null);

  useEffect(() => {
    setLineInput(String(settings.collapseLineThreshold));
    setLineError(null);
  }, [settings.collapseLineThreshold]);

  useEffect(() => {
    setCharInput(String(settings.collapseCharThreshold));
    setCharError(null);
  }, [settings.collapseCharThreshold]);

  const handleLineChange = (raw: string) => {
    setLineInput(raw);
    const trimmed = raw.trim();
    const n = Number(trimmed);
    if (!trimmed || !Number.isInteger(n) || n < 4 || n > 200) {
      setLineError('须为 4–200 的整数');
      return;
    }
    setLineError(null);
    updateSettings({ collapseLineThreshold: n });
  };

  const handleCharChange = (raw: string) => {
    setCharInput(raw);
    const trimmed = raw.trim();
    const n = Number(trimmed);
    if (!trimmed || !Number.isInteger(n) || n < 120 || n > 20000) {
      setCharError('须为 120–20000 的整数');
      return;
    }
    setCharError(null);
    updateSettings({ collapseCharThreshold: n });
  };

  return (
    <div className="st-scroll">
      <div className="st-container">
        <h2 className="st-section-title">外观与显示</h2>

        {settingsNotice ? (
          <ErrorBanner
            message={settingsNotice}
            action={
              <Button size="sm" variant="ghost" onClick={dismissSettingsNotice}>
                关闭
              </Button>
            }
          />
        ) : null}

        <section>
          <h3 className="st-subhead">主题</h3>
          <div className="st-group">
            <div className="st-row--inline">
              <span className="st-row__label--plain">外观模式</span>
              <SegmentedControl<ThemeMode>
                ariaLabel="主题模式"
                value={settings.themeMode}
                options={[
                  {
                    value: 'system',
                    label: (
                      <>
                        <Icon name="monitor" size={14} />
                        <span>系统</span>
                      </>
                    ),
                  },
                  {
                    value: 'light',
                    label: (
                      <>
                        <Icon name="sun" size={14} />
                        <span>浅色</span>
                      </>
                    ),
                  },
                  {
                    value: 'dark',
                    label: (
                      <>
                        <Icon name="moon" size={14} />
                        <span>深色</span>
                      </>
                    ),
                  },
                ]}
                onChange={(themeMode) => updateSettings({ themeMode })}
              />
            </div>

            <div className="st-row">
              <span className="st-row__label">强调色</span>
              <div
                className="st-swatch-list"
                role="radiogroup"
                aria-label="强调色"
              >
                {PRESET_ACCENT_COLORS.map((preset) => {
                  const active =
                    (settings.seedColorValue >>> 0) === preset.value;
                  const swatchHex =
                    resolvedTheme === 'dark' ? preset.darkHex : preset.lightHex;
                  return (
                    <button
                      key={preset.value}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      aria-label={preset.label}
                      title={preset.label}
                      className={`st-swatch ${
                        active ? 'st-swatch--active' : ''
                      }`.trim()}
                      style={{ backgroundColor: swatchHex }}
                      onClick={() =>
                        updateSettings({ seedColorValue: preset.value })
                      }
                    >
                      {active ? <Icon name="check" size={14} /> : null}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </section>

        <section>
          <h3 className="st-subhead">输入</h3>
          <div className="st-group">
            <div className="st-row--inline">
              <span className="st-row__label--plain">Enter 发送</span>
              <Switch
                checked={settings.enterToSend}
                label="Enter 发送"
                onCheckedChange={(enterToSend) =>
                  updateSettings({ enterToSend })
                }
              />
            </div>
          </div>
        </section>

        <section>
          <h3 className="st-subhead">内容显示</h3>
          <div className="st-group">
            <div className="st-row--inline">
              <span className="st-row__label--plain">对话布局模式</span>
              <SegmentedControl<ChatDisplayMode>
                ariaLabel="对话布局模式"
                value={settings.chatDisplayMode}
                options={[
                  {
                    value: 'bubble',
                    label: (
                      <>
                        <Icon name="messageSquare" size={14} />
                        <span>气泡模式</span>
                      </>
                    ),
                  },
                  {
                    value: 'feed',
                    label: (
                      <>
                        <Icon name="layoutStream" size={14} />
                        <span>信息流模式</span>
                      </>
                    ),
                  },
                ]}
                onChange={(chatDisplayMode) =>
                  updateSettings({ chatDisplayMode })
                }
              />
            </div>

            <div className="st-row--inline">
              <span className="st-row__label--plain">可视化功能渲染</span>
              <Switch
                checked={settings.visualHtmlRender}
                label="可视化功能渲染"
                onCheckedChange={(visualHtmlRender) =>
                  updateSettings({ visualHtmlRender })
                }
              />
            </div>

            <div className="st-row--inline">
              <span className="st-row__label--plain">HTML 代码块预览</span>
              <Switch
                checked={settings.defaultHtmlPreview}
                label="HTML 代码块预览"
                onCheckedChange={(defaultHtmlPreview) =>
                  updateSettings({ defaultHtmlPreview })
                }
              />
            </div>

            <div className="st-row--inline">
              <span className="st-row__label--plain">思考完成后自动折叠</span>
              <Switch
                checked={settings.autoCollapseThinkingOnComplete}
                label="思考完成后自动折叠"
                onCheckedChange={(autoCollapseThinkingOnComplete) =>
                  updateSettings({ autoCollapseThinkingOnComplete })
                }
              />
            </div>

            <div className="st-row--inline">
              <span className="st-row__label--plain">工具执行完成后自动折叠</span>
              <Switch
                checked={settings.autoCollapseToolsOnComplete}
                label="工具执行完成后自动折叠"
                onCheckedChange={(autoCollapseToolsOnComplete) =>
                  updateSettings({ autoCollapseToolsOnComplete })
                }
              />
            </div>

            <div className="st-row--inline">
              <span className="st-row__label--plain">自动折叠长内容</span>
              <Switch
                checked={settings.autoCollapseEnabled}
                label="自动折叠长内容"
                onCheckedChange={(autoCollapseEnabled) =>
                  updateSettings({ autoCollapseEnabled })
                }
              />
            </div>

            <div className="st-row">
              <label className="st-row__label" htmlFor="appearance-line-limit">
                行数阈值
              </label>
              <div className="st-row__control">
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <Input
                    id="appearance-line-limit"
                    type="number"
                    min={4}
                    max={200}
                    disabled={!settings.autoCollapseEnabled}
                    value={lineInput}
                    onChange={(e) => handleLineChange(e.target.value)}
                    style={{ width: 100 }}
                  />
                  <input
                    type="range"
                    className="st-range"
                    aria-label="行数阈值滑块"
                    min={4}
                    max={200}
                    disabled={!settings.autoCollapseEnabled}
                    value={settings.collapseLineThreshold}
                    onChange={(e) => handleLineChange(e.target.value)}
                  />
                </div>
                {lineError ? (
                  <span className="ui-field__error" role="alert">
                    {lineError}
                  </span>
                ) : null}
              </div>
            </div>

            <div className="st-row">
              <label className="st-row__label" htmlFor="appearance-char-limit">
                字符阈值
              </label>
              <div className="st-row__control">
                <Input
                  id="appearance-char-limit"
                  type="number"
                  min={120}
                  max={20000}
                  disabled={!settings.autoCollapseEnabled}
                  value={charInput}
                  onChange={(e) => handleCharChange(e.target.value)}
                  style={{ width: 140 }}
                />
                {charError ? (
                  <span className="ui-field__error" role="alert">
                    {charError}
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
