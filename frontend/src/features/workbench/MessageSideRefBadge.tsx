import { useMemo, useState } from 'react';
import { Icon, IconButton, Popover } from '../../components/ui';
import type { Message } from '../../core/types';
import { resolveSideRefMaterials } from './conversationGraph';

export interface MessageSideRefBadgeProps {
  message: Message;
  allMessages: readonly Message[];
  align?: 'start' | 'end';
  disabled?: boolean;
  onOpenGraphNode?: (nodeId: string) => void;
  onRemoveSideRef?: (targetMessageId: string, sourceMessageId: string) => Promise<void>;
}

export function MessageSideRefBadge({
  message,
  allMessages,
  align = 'start',
  disabled = false,
  onOpenGraphNode,
  onRemoveSideRef,
}: MessageSideRefBadgeProps) {
  const [open, setOpen] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const refs = message.graphMeta?.sideRefs;
  const resolved = useMemo(
    () => (refs?.length ? resolveSideRefMaterials(allMessages, message) : null),
    [allMessages, message, refs],
  );

  if (!refs?.length || !resolved) return null;

  const hasAnyContent = resolved.branches.some((b) => b.preview.length > 0);
  const count = resolved.branches.length;
  const label = count > 1 ? `参考分支 ×${count}` : '参考分支';

  return (
    <div
      className={`wb-sideref-row${align === 'end' ? ' wb-sideref-row--end' : ''}`}
      data-sideref-count={count}
    >
      <Popover
        open={open}
        onOpenChange={setOpen}
        side="top"
        align={align}
        contentProps={{
          'aria-label': '侧边参考分支',
        }}
        trigger={
          <button
            type="button"
            className={`wb-sideref-pill${hasAnyContent ? '' : ' wb-sideref-pill--empty'}`}
            aria-label={label}
            aria-expanded={open}
            title={label}
          >
            <Icon name="sideLink" size={13} />
            <span>{count > 1 ? String(count) : '参考分支'}</span>
          </button>
        }
      >
        <div className="wb-sideref-list wb-sideref-popover">
          {resolved.branches.map((branch, index) => {
            const srcId = branch.ref.sourceMessageId;
            const busyThis = removingId === srcId;
            return (
              <div key={srcId} className="wb-sideref-card">
                <div className="wb-sideref-card__head">
                  <span className="wb-sideref-card__meta">
                    <Icon name="sideLink" size={13} />
                    <span>
                      {count > 1 ? `分支 ${index + 1}` : '参考分支'}
                    </span>
                    <span className="wb-sideref-card__count">
                      {branch.assistantMessages.length > 0
                        ? `${branch.assistantMessages.length} 条回复`
                        : '暂无助手回复'}
                    </span>
                  </span>
                  <div className="wb-sideref-card__actions">
                    {onOpenGraphNode && (
                      <IconButton
                        icon="mindMap"
                        label="在缩略图中查看"
                        size="sm"
                        onClick={() => {
                          setOpen(false);
                          onOpenGraphNode(srcId);
                        }}
                      />
                    )}
                    {onRemoveSideRef && (
                      <IconButton
                        icon="unlink"
                        label="断开接入"
                        size="sm"
                        tone="danger"
                        disabled={disabled || busyThis}
                        loading={busyThis}
                        onClick={() => {
                          setRemovingId(srcId);
                          void onRemoveSideRef(message.id, srcId).finally(() => {
                            setRemovingId((cur) => (cur === srcId ? null : cur));
                          });
                        }}
                      />
                    )}
                  </div>
                </div>
                {branch.preview ? (
                  <div className="wb-sideref-card__body">{branch.preview}</div>
                ) : (
                  <div className="wb-sideref-card__empty">暂无助手回复</div>
                )}
              </div>
            );
          })}
        </div>
      </Popover>
    </div>
  );
}
