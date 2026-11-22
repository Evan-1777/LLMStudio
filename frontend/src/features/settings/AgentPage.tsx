import { useEffect, useRef, useState } from 'react';
import { useApp } from '../../app/AppProvider';
import { ErrorBanner, LoadingSpinner, SegmentedControl, Switch } from '../../components/ui';
import type { GatewayClient } from '../../core/gateway';
import { getAgentModeVisible, setAgentModeVisible } from '../../core/settings';
import type { AgentSettings, AgentSettingsPatch, TopicScope } from '../../core/types';
import { AgentDirectoryControl } from '../agent/AgentDirectoryControl';

const TOOL_LABELS = {
  read: '读取文件', ls: '列出目录', find: '查找文件', grep: '搜索文本',
  write: '写入文件', edit: '编辑文件', bash: '执行命令', skill: '调用技能',
} as const;

export function AgentPage() {
  const { gateway, isDesktop, connectionEpoch, cloudConnectionState } = useApp();
  const [scope, setScope] = useState<TopicScope>('local');
  const [visible, setVisible] = useState(getAgentModeVisible);
  const selectedScope = isDesktop ? scope : undefined;
  return (
    <div className="st-scroll">
      <div className="st-container">
        <h2 className="st-section-title">Agent</h2>
        <section>
          <h3 className="st-subhead">工作台</h3>
          <div className="st-group">
            <div className="st-row--inline">
              <span className="st-row__label--plain">显示模式切换</span>
              <Switch label="显示模式切换" checked={visible} onCheckedChange={(next) => { setAgentModeVisible(next); setVisible(next); }} />
            </div>
            {isDesktop && <div className="st-row--inline">
              <span className="st-row__label--plain">执行端</span>
              <SegmentedControl<TopicScope> value={scope} ariaLabel="执行端" onChange={setScope}
                options={[{ value: 'local', label: '本机' }, { value: 'cloud', label: '网关' }]} />
            </div>}
          </div>
        </section>
        {isDesktop && scope === 'cloud' && cloudConnectionState === 'disconnected'
          ? <p role="status" className="st-subtitle">网关未连接</p>
          : <AgentEndpointSettings key={connectionEpoch + ':' + (selectedScope ?? 'gateway')} gateway={gateway} scope={selectedScope} />}
      </div>
    </div>
  );
}

function AgentEndpointSettings({ gateway, scope }: { gateway: GatewayClient; scope?: TopicScope }) {
  const [settings, setSettings] = useState<AgentSettings | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const mutation = useRef<AbortController | null>(null);
  useEffect(() => {
    const ctrl = new AbortController();
    void gateway.getAgentSettings(scope, ctrl.signal).then(
      (next) => { if (!ctrl.signal.aborted) setSettings(next); },
      () => { if (!ctrl.signal.aborted) setError('无法读取 Agent 设置'); },
    );
    return () => ctrl.abort();
  }, [attempt, gateway, scope]);
  useEffect(() => () => mutation.current?.abort(), []);

  const save = async (patch: AgentSettingsPatch, signal?: AbortSignal) => {
    if (mutation.current) return;
    const ctrl = new AbortController();
    const abort = () => ctrl.abort();
    signal?.addEventListener('abort', abort, { once: true });
    mutation.current = ctrl;
    setBusy(true);
    setError('');
    try {
      const next = await gateway.updateAgentSettings(patch, scope, ctrl.signal);
      if (!ctrl.signal.aborted) setSettings(next);
    } catch (err) {
      if (signal) throw err;
      if (!ctrl.signal.aborted) setError('无法保存 Agent 设置');
    } finally {
      signal?.removeEventListener('abort', abort);
      mutation.current = null;
      if (!ctrl.signal.aborted) setBusy(false);
    }
  };

  if (!settings) {
    return error
      ? <ErrorBanner message={error} onRetry={() => { setError(''); setAttempt((n) => n + 1); }} />
      : <LoadingSpinner label="读取 Agent 设置" />;
  }

  const skills = settings.skills ?? [];

  return (
    <>
      {error && <ErrorBanner message={error} />}
      <section>
        <h3 className="st-subhead">工作目录</h3>
        <div className="st-group">
          <div className="st-row--inline st-agent-directory-row">
            <span className="st-row__label--plain">默认目录</span>
            <AgentDirectoryControl gateway={gateway} scope={scope} directory={settings.directory} disabled={busy}
              resetLabel={scope !== 'local' && settings.directory.path !== '.' ? '重置到工作区根目录' : undefined}
              onChoose={(path, signal) => save({ defaultDirectory: path }, signal)} />
          </div>
        </div>
      </section>
      <section>
        <h3 className="st-subhead">工作区与上下文</h3>
        <div className="st-group" aria-busy={busy || undefined}>
          <div className="st-row--inline">
            <span className="st-row__label--plain">注入目录 AGENT.md</span>
            <Switch label="注入目录 AGENT.md" checked={settings.injectAgentMd} disabled={busy}
              onCheckedChange={(next) => void save({ injectAgentMd: next })} />
          </div>
          {scope !== 'local' && (
            <div className="st-row--inline">
              <span className="st-row__label--plain">工作区 Markdown 可视化渲染</span>
              <Switch label="工作区 Markdown 可视化渲染" checked={settings.markdownVisualRender} disabled={busy}
                onCheckedChange={(next) => void save({ markdownVisualRender: next })} />
            </div>
          )}
        </div>
      </section>
      <section>
        <h3 className="st-subhead">工具授权</h3>
        <div className="st-group" aria-busy={busy || undefined}>
          {Object.entries(TOOL_LABELS).map(([tool, label]) => {
            const allowed = settings.allowedTools.includes(tool);
            const available = settings.availableTools.includes(tool);
            return (
              <div className="st-row--inline" key={tool}>
                <span className="st-row__label--plain">{label}</span>
                <div className="st-agent-tool-control">
                  {!available && <span className="st-subtitle">不可用</span>}
                  <Switch label={label} checked={allowed} disabled={busy || (!available && !allowed)}
                    onCheckedChange={(next) => void save({ allowedTools: next ? [...settings.allowedTools, tool] : settings.allowedTools.filter((name) => name !== tool) })} />
                </div>
              </div>
            );
          })}
        </div>
      </section>
      {skills.length > 0 && (
        <section>
          <h3 className="st-subhead">目录技能</h3>
          <div className="st-group">
            {skills.map((skill) => (
              <div className="st-row--inline st-agent-skill" key={skill.path}>
                <span className="st-agent-skill__name" title={skill.path}>{skill.name}</span>
                {skill.description && (
                  <span className="st-agent-skill__desc" title={skill.description}>{skill.description}</span>
                )}
              </div>
            ))}
          </div>
        </section>
      )}
    </>
  );
}
