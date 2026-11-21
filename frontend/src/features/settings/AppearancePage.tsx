import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { useApp } from '../../app/AppProvider';
import {
  AvatarField,
  Button,
  ErrorBanner,
  Icon,
  IconButton,
  Input,
  SegmentedControl,
  Switch,
} from '../../components/ui';
import {
  FONT_SIZE_DEFAULT,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  PRESET_ACCENT_COLORS,
  type ChatDisplayMode,
  type FontFamily,
  type ThemeMode,
} from '../../core/settings';

export function AppearancePage() {
  const {
    settings,
    resolvedTheme,
    settingsNotice,
    dismissSettingsNotice,
    updatePreferences,
    customFont,
    customFontBusy,
    uploadCustomFont,
    toggleCustomFont,
    removeCustomFont,
  } = useApp();
  const fontInputRef = useRef<HTMLInputElement | null>(null);

  const [lineInput, setLineInput] = useState(
    String(settings.collapseLineThreshold),
  );
  const [charInput, setCharInput] = useState(
    String(settings.collapseCharThreshold),
  );
  const [lineError, setLineError] = useState<string | null>(null);
  const [charError, setCharError] = useState<string | null>(null);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const [savingAvatar, setSavingAvatar] = useState(false);
  const [customFontError, setCustomFontError] = useState<string | null>(null);

  useEffect(() => {
    setLineInput(String(settings.collapseLineThreshold));
    setLineError(null);
  }, [settings.collapseLineThreshold]);

  useEffect(() => {
    setCharInput(String(settings.collapseCharThreshold));
    setCharError(null);
  }, [settings.collapseCharThreshold]);

  const handleAvatarChange = async (next: string) => {
    setSavingAvatar(true);
    setAvatarError(null);
    const result = await updatePreferences({ userAvatarDataUrl: next });
    setSavingAvatar(false);
    if (!result.ok) {
      setAvatarError(result.error ?? '保存头像失败');
    }
  };

  const handleFontFileChange = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setCustomFontError(null);
    const result = await uploadCustomFont(file);
    if (!result.ok) {
      setCustomFontError(result.error ?? '上传字体失败');
    }
  };

  const handleCustomFontToggle = async (enabled: boolean) => {
    setCustomFontError(null);
    const result = await toggleCustomFont(enabled);
    if (!result.ok) {
      setCustomFontError(result.error ?? '切换字体失败');
    }
  };

  const handleCustomFontRemove = async () => {
    setCustomFontError(null);
    const result = await removeCustomFont();
    if (!result.ok) {
      setCustomFontError(result.error ?? '移除字体失败');
    }
  };

  const handleLineChange = (raw: string) => {
    setLineInput(raw);
    const trimmed = raw.trim();
    const n = Number(trimmed);
    if (!trimmed || !Number.isInteger(n) || n < 4 || n > 200) {
      setLineError('须为 4–200 的整数');
      return;
    }
    setLineError(null);
    void updatePreferences({ collapseLineThreshold: n });
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
    void updatePreferences({ collapseCharThreshold: n });
  };

  return (
    <div className="st-scroll">
      <div className="st-container">
        <h2 className="st-section-title">外观与显示</h2>

        {settingsNotice ? (
          <ErrorBanner
            message={settingsNotice}
            action={
              <IconButton
                icon="close"
                size="sm"
                label="关闭"
                onClick={dismissSettingsNotice}
              />
            }
          />
        ) : null}

        <section>
          <h3 className="st-subhead">用户</h3>
          <div className="st-group">
            <div className="st-row--inline">
              <span className="st-row__label--plain">头像</span>
              <AvatarField
                value={settings.userAvatarDataUrl}
                kind="user"
                label="用户头像"
                busy={savingAvatar}
                onChange={(next) => void handleAvatarChange(next)}
                onError={setAvatarError}
              />
            </div>
            {avatarError ? (
              <div className="st-row">
                <span className="ui-field__error" role="alert">
                  {avatarError}
                </span>
              </div>
            ) : null}
          </div>
        </section>

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
                    ariaLabel: '系统',
                    title: '系统',
                    label: <Icon name="monitor" size={14} />,
                  },
                  {
                    value: 'light',
                    ariaLabel: '浅色',
                    title: '浅色',
                    label: <Icon name="sun" size={14} />,
                  },
                  {
                    value: 'dark',
                    ariaLabel: '深色',
                    title: '深色',
                    label: <Icon name="moon" size={14} />,
                  },
                ]}
                onChange={(themeMode) => void updatePreferences({ themeMode })}
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
                        void updatePreferences({ seedColorValue: preset.value })
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
          <h3 className="st-subhead">排版</h3>
          <div className="st-group">
            <div className="st-row--inline">
              <span className="st-row__label--plain">字体</span>
              <SegmentedControl<FontFamily>
                ariaLabel="字体"
                value={settings.fontFamily}
                options={[
                  { value: 'system', label: '系统' },
                  { value: 'sans', label: '无衬线' },
                  { value: 'serif', label: '衬线' },
                  { value: 'kai', label: '楷体' },
                  { value: 'mono', label: '等宽' },
                ]}
                onChange={(fontFamily) => void updatePreferences({ fontFamily })}
              />
            </div>

            <div className="st-row--inline">
              <span className="st-row__label--plain">自定义字体</span>
              <div className="st-custom-font">
                {customFont ? (
                  <>
                    <span
                      className="st-custom-font__name"
                      title={customFont.name}
                    >
                      {customFont.name}
                    </span>
                    <Switch
                      checked={customFont.enabled}
                      label="使用自定义字体"
                      disabled={customFontBusy}
                      onCheckedChange={(enabled) =>
                        void handleCustomFontToggle(enabled)
                      }
                    />
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={customFontBusy}
                      onClick={() => fontInputRef.current?.click()}
                    >
                      替换
                    </Button>
                    <Button
                      size="sm"
                      variant="danger-ghost"
                      disabled={customFontBusy}
                      onClick={() => void handleCustomFontRemove()}
                    >
                      移除
                    </Button>
                  </>
                ) : (
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={customFontBusy}
                    onClick={() => fontInputRef.current?.click()}
                  >
                    上传字体
                  </Button>
                )}
                <input
                  ref={fontInputRef}
                  type="file"
                  accept=".ttf"
                  className="st-custom-font__input"
                  aria-label="选择 TTF 字体文件"
                  onChange={(e) => void handleFontFileChange(e)}
                />
              </div>
            </div>
            {customFontError ? (
              <div className="st-row">
                <span className="ui-field__error" role="alert">
                  {customFontError}
                </span>
              </div>
            ) : null}

            <div className="st-row--inline">
              <span className="st-row__label--plain">字体大小</span>
              <div className="st-font-size-controls">
                <input
                  type="range"
                  className="st-range st-font-size-range"
                  aria-label="字体大小"
                  min={FONT_SIZE_MIN}
                  max={FONT_SIZE_MAX}
                  step={1}
                  value={settings.fontSize}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    if (Number.isInteger(n)) {
                      void updatePreferences({ fontSize: n });
                    }
                  }}
                />
                <div className="st-font-size-stepper">
                  <IconButton
                    size="sm"
                    icon="minus"
                    label="减小字号"
                    disabled={settings.fontSize <= FONT_SIZE_MIN}
                    onClick={() =>
                      void updatePreferences({
                        fontSize: Math.max(FONT_SIZE_MIN, settings.fontSize - 1),
                      })
                    }
                  />
                  <span className="st-font-size-value">
                    {settings.fontSize} px
                  </span>
                  <IconButton
                    size="sm"
                    icon="plus"
                    label="增大字号"
                    disabled={settings.fontSize >= FONT_SIZE_MAX}
                    onClick={() =>
                      void updatePreferences({
                        fontSize: Math.min(FONT_SIZE_MAX, settings.fontSize + 1),
                      })
                    }
                  />
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  className="st-font-size-reset"
                  disabled={settings.fontSize === FONT_SIZE_DEFAULT}
                  onClick={() =>
                    void updatePreferences({ fontSize: FONT_SIZE_DEFAULT })
                  }
                >
                  重置
                </Button>
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
                  void updatePreferences({ enterToSend })
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
                    ariaLabel: '气泡模式',
                    title: '气泡模式',
                    label: <Icon name="messageSquare" size={14} />,
                  },
                  {
                    value: 'feed',
                    ariaLabel: '信息流模式',
                    title: '信息流模式',
                    label: <Icon name="layoutStream" size={14} />,
                  },
                ]}
                onChange={(chatDisplayMode) =>
                  void updatePreferences({ chatDisplayMode })
                }
              />
            </div>

            <div className="st-row--inline">
              <span className="st-row__label--plain">手动调整对话宽度</span>
              <Switch
                checked={settings.chatWidthMode === 'manual'}
                label="手动调整对话宽度"
                onCheckedChange={(checked) =>
                  void updatePreferences({
                    chatWidthMode: checked ? 'manual' : 'default',
                  })
                }
              />
            </div>

            <div className="st-row--inline">
              <span className="st-row__label--plain">可视化功能渲染</span>
              <Switch
                checked={settings.visualHtmlRender}
                label="可视化功能渲染"
                onCheckedChange={(visualHtmlRender) =>
                  void updatePreferences({ visualHtmlRender })
                }
              />
            </div>

            <div className="st-row--inline">
              <span className="st-row__label--plain">数学公式渲染</span>
              <Switch
                checked={settings.mathRenderEnabled}
                label="数学公式渲染"
                onCheckedChange={(mathRenderEnabled) =>
                  void updatePreferences({ mathRenderEnabled })
                }
              />
            </div>

            <div className="st-row--inline">
              <span className="st-row__label--plain">HTML 代码块预览</span>
              <Switch
                checked={settings.defaultHtmlPreview}
                label="HTML 代码块预览"
                onCheckedChange={(defaultHtmlPreview) =>
                  void updatePreferences({ defaultHtmlPreview })
                }
              />
            </div>

            <div className="st-row--inline">
              <span className="st-row__label--plain">思考完成后自动折叠</span>
              <Switch
                checked={settings.autoCollapseThinkingOnComplete}
                label="思考完成后自动折叠"
                onCheckedChange={(autoCollapseThinkingOnComplete) =>
                  void updatePreferences({ autoCollapseThinkingOnComplete })
                }
              />
            </div>

            <div className="st-row--inline">
              <span className="st-row__label--plain">工具执行完成后自动折叠</span>
              <Switch
                checked={settings.autoCollapseToolsOnComplete}
                label="工具执行完成后自动折叠"
                onCheckedChange={(autoCollapseToolsOnComplete) =>
                  void updatePreferences({ autoCollapseToolsOnComplete })
                }
              />
            </div>

            <div className="st-row--inline">
              <span className="st-row__label--plain">自动折叠长内容</span>
              <Switch
                checked={settings.autoCollapseEnabled}
                label="自动折叠长内容"
                onCheckedChange={(autoCollapseEnabled) =>
                  void updatePreferences({ autoCollapseEnabled })
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
