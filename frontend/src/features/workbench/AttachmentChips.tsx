import { Icon, IconButton } from '../../components/ui';
import { formatBytes } from '../../core/formatBytes';
import type { PendingAttachment } from './attachments';

export function AttachmentChips({
  attachments,
  onRemove,
}: {
  attachments: PendingAttachment[];
  onRemove: (id: string) => void;
}) {
  if (attachments.length === 0) return null;

  return (
    <div className="wb-attachments-bar">
      {attachments.map((att) => {
        const isError = att.status === 'error';
        const sizeLabel = att.originalSize !== undefined && att.originalSize !== att.size
          ? `${formatBytes(att.originalSize)} → ${formatBytes(att.size)}`
          : formatBytes(att.size);
        return (
          <div
            key={att.id}
            className={`wb-att-chip ${isError ? 'wb-att-chip--error' : ''}`.trim()}
            title={att.error ? `${att.name}: ${att.error}` : att.status === 'ready' ? `${att.name} (${sizeLabel})` : att.name}
          >
            {att.kind === 'image' && att.previewUrl && !isError ? (
              <img
                src={att.previewUrl}
                alt={att.name}
                className="wb-att-chip__thumb"
              />
            ) : (
              <Icon
                name={
                  isError
                    ? 'warning'
                    : att.kind === 'image'
                      ? 'image'
                      : 'folder'
                }
                size={13}
              />
            )}
            <span className="wb-att-chip__name">
              {att.status === 'reading'
                ? `${att.name}${att.kind === 'image' ? ' · 压缩中' : ''}…`
                : isError
                  ? `${att.name} · ${att.error}`
                  : att.name}
            </span>
            <IconButton
              size="sm"
              icon="close"
              label={`移除 ${att.name}`}
              onClick={() => onRemove(att.id)}
              style={{ width: 20, height: 20, minWidth: 20, minHeight: 20 }}
            />
          </div>
        );
      })}
    </div>
  );
}
