import { useEffect, useRef, useState, type ClipboardEvent } from 'react';
import { ErrorBanner, IconButton, Textarea } from '../../components/ui';
import type { ContentBlock, ImageBlock, Message } from '../../core/types';
import { imageBlockSource } from '../../rendering/ContentRenderer';
import { extractMessageCopyText } from '../chat/MessageActions';
import { AttachmentChips } from './AttachmentChips';
import {
  IMAGE_INPUT_ACCEPT,
  attachmentToContentBlock,
  classifyFile,
  clipboardHasPlainText,
  collectClipboardImageFiles,
  isWithinRequestLimit,
  readAttachmentFile,
  revokeAttachmentResources,
  type PendingAttachment,
} from './attachments';

export function replaceMessageTextBlocks(
  blocks: ContentBlock[],
  nextText: string,
): ContentBlock[] {
  const out: ContentBlock[] = [];
  let replaced = false;
  for (const block of blocks) {
    if (block.type === 'text') {
      if (!replaced) {
        replaced = true;
        if (nextText.trim()) out.push({ ...block, text: nextText });
      }
      continue;
    }
    out.push(block);
  }
  if (!replaced && nextText.trim()) out.push({ type: 'text', text: nextText });
  return out;
}

function buildEditedBlocks(
  blocks: ContentBlock[],
  nextText: string,
  textChanged: boolean,
  removedImages: ReadonlySet<number>,
  added: PendingAttachment[],
): ContentBlock[] {
  const out: ContentBlock[] = [];
  let foundText = false;
  blocks.forEach((block, index) => {
    if (block.type === 'image' && removedImages.has(index)) return;
    if (block.type === 'text' && textChanged) {
      if (!foundText && nextText.trim()) out.push({ type: 'text', text: nextText });
      foundText = true;
    } else {
      out.push(block);
    }
  });
  if (!foundText && textChanged && nextText.trim()) out.push({ type: 'text', text: nextText });
  return out.concat(added.map(attachmentToContentBlock));
}

export function MessageEditor({ message, saving, onCancel, onSave }: {
  message: Message;
  saving: boolean;
  onCancel: () => void;
  onSave: (blocks: ContentBlock[]) => Promise<void>;
}) {
  const originalText = extractMessageCopyText(message);
  const [text, setText] = useState(originalText);
  const [removed, setRemoved] = useState<ReadonlySet<number>>(() => new Set());
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [sizeError, setSizeError] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const liveAttachments = useRef(new Map<string, PendingAttachment>());
  const submitLock = useRef(false);

  useEffect(() => {
    const live = liveAttachments.current;
    return () => {
      live.forEach(revokeAttachmentResources);
      live.clear();
    };
  }, []);

  const addImages = (files: File[]) => {
    if (saving) return;
    const added = files.filter((file) => classifyFile(file) === 'image').map((file) => {
      const attachment = readAttachmentFile(file, { onUpdate: (result) => {
        setAttachments((previous) => previous.map((item) => item.id === result.id ? result : item));
      } });
      liveAttachments.current.set(attachment.id, attachment);
      return attachment;
    });
    if (added.length === 0) return;
    setAttachments((previous) => [...previous, ...added]);
    setSizeError(false);
  };

  const paste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = collectClipboardImageFiles(event.clipboardData).filter((file) => classifyFile(file) === 'image');
    if (files.length === 0) return;
    if (!clipboardHasPlainText(event.clipboardData)) event.preventDefault();
    addImages(files);
  };

  let imageNumber = 0;
  const images = message.blocks.flatMap((block, index) => {
    if (block.type !== 'image') return [];
    const name = '图片 ' + ++imageNumber;
    return removed.has(index) ? [] : [{ id: String(index), name, kind: 'image' as const,
      status: 'ready' as const, previewUrl: imageBlockSource(block as ImageBlock) }];
  });
  const hasOtherBlocks = message.blocks.some((block) => block.type !== 'text' && block.type !== 'image');
  const canSave = !saving && attachments.every((image) => image.status === 'ready') &&
    Boolean(text.trim() || images.length || hasOtherBlocks || attachments.length);

  const removeImage = (id: string) => {
    const attachment = liveAttachments.current.get(id);
    if (attachment) {
      revokeAttachmentResources(attachment);
      liveAttachments.current.delete(id);
      setAttachments((previous) => previous.filter((image) => image.id !== id));
    } else {
      setRemoved((previous) => new Set([...previous, Number(id)]));
    }
    setSizeError(false);
  };

  const save = async () => {
    if (!canSave || submitLock.current) return;
    const blocks = buildEditedBlocks(message.blocks, text, text !== originalText, removed, attachments);
    if (!isWithinRequestLimit({ blocks })) {
      setSizeError(true);
      return;
    }
    submitLock.current = true;
    try {
      await onSave(blocks);
    } finally {
      submitLock.current = false;
    }
  };

  return (
    <div className="wb-msg-editor" onKeyDown={(event) => {
      if (event.key === 'Escape' && !saving) {
        event.preventDefault();
        onCancel();
      } else if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !event.nativeEvent.isComposing) {
        event.preventDefault();
        void save();
      }
    }}>
      <AttachmentChips attachments={[...images, ...attachments]} onRemove={removeImage} disabled={saving} />
      <Textarea
        aria-label="编辑消息内容"
        className="wb-msg-editor__textarea"
        value={text}
        autoFocus
        rows={Math.min(10, Math.max(3, text.split('\n').length))}
        disabled={saving}
        onChange={(event) => { setText(event.target.value); setSizeError(false); }}
        onPaste={paste}
      />
      {sizeError ? <ErrorBanner message="请求总大小超过 16 MiB 限制，请缩减文本或图片" /> : null}
      <input ref={input} type="file" accept={IMAGE_INPUT_ACCEPT} multiple hidden onChange={(event) => {
        addImages(Array.from(event.target.files ?? []));
        event.target.value = '';
      }} />
      <div className="wb-msg-editor__actions">
        <IconButton size="sm" icon="image" label="添加图片" disabled={saving} onClick={() => input.current?.click()} />
        <IconButton size="sm" icon="close" label="取消" disabled={saving} onClick={onCancel} />
        <IconButton size="sm" icon="check" label="保存" loading={saving} disabled={!canSave} onClick={() => void save()} />
      </div>
    </div>
  );
}
