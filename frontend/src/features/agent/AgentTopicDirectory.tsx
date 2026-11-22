import { useEffect, useState } from 'react';
import { IconButton } from '../../components/ui';
import type { GatewayClient } from '../../core/gateway';
import type { AgentDirectory, TopicScope } from '../../core/types';
import { AgentDirectoryControl } from './AgentDirectoryControl';

export function AgentTopicDirectory({ gateway, scope, topicId, draftPath, disabled, onDraftPath }: {
  gateway: GatewayClient;
  scope?: TopicScope;
  topicId?: string;
  draftPath: string;
  disabled: boolean;
  onDraftPath: (path: string) => void;
}) {
  const [directory, setDirectory] = useState<AgentDirectory | null>(null);
  const [retry, setRetry] = useState(0);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const ctrl = new AbortController();
    const pending = topicId
      ? gateway.getAgentTopicDirectory(topicId, scope, ctrl.signal)
      : gateway.getAgentSettings(scope, ctrl.signal).then((settings) => settings.directory);
    void pending.then(
      (value) => { if (!ctrl.signal.aborted) setDirectory(value); },
      () => { if (!ctrl.signal.aborted) setFailed(true); },
    );
    return () => ctrl.abort();
  }, [gateway, retry, scope, topicId]);

  const current: AgentDirectory | null = !topicId && draftPath
    ? { path: draftPath, status: 'ready', override: true }
    : directory;

  return (
    <div className="wb-agent-context" aria-label="Agent 工作目录">
      <span className="wb-agent-context__scope">{scope === 'local' ? '本机执行' : '网关执行'}</span>
      {current ? (
        <AgentDirectoryControl gateway={gateway} scope={scope} directory={current} disabled={disabled}
          resetLabel={current.override ? '清除话题目录覆写' : undefined}
          onChoose={async (path, signal) => {
            if (!topicId) { onDraftPath(path); return; }
            const next = await gateway.setAgentTopicDirectory(topicId, path, scope, signal);
            if (!signal.aborted) setDirectory(next);
          }} />
      ) : failed ? (
        <><span role="status">无法读取目录</span><IconButton icon="refresh" size="sm" label="重试读取工作目录" onClick={() => { setFailed(false); setRetry((n) => n + 1); }} /></>
      ) : <span role="status">正在读取目录…</span>}
    </div>
  );
}
