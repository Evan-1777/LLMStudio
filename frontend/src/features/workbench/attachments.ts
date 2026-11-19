import {
  MAX_ATTACHMENT_BYTES,
  MAX_GATEWAY_BODY_BYTES,
  type ContentBlock,
} from '../../core/types';
import { measureUtf8Bytes } from '../../core/gateway';
import { compressImageFile } from './imageCompression';

export const ALLOWED_TEXT_EXTENSIONS = new Set([
  'txt',
  'md',
  'markdown',
  'json',
  'csv',
  'yaml',
  'yml',
  'xml',
  'svg',
  'html',
  'htm',
  'css',
  'js',
  'jsx',
  'ts',
  'tsx',
  'go',
  'py',
  'sh',
  'sql',
  'log',
  'rs',
  'java',
  'c',
  'cpp',
  'h',
]);

const IMAGE_EXTENSION_MIME: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  jfif: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  avif: 'image/avif',
  ico: 'image/x-icon',
};
const ALLOWED_IMAGE_EXTENSIONS = new Set(Object.keys(IMAGE_EXTENSION_MIME));
export const MAX_RAW_IMAGE_BYTES = 25 * 1024 * 1024;

export const FILE_INPUT_ACCEPT = [
  'image/*',
  ...Array.from(ALLOWED_IMAGE_EXTENSIONS, (ext) => `.${ext}`),
  ...Array.from(ALLOWED_TEXT_EXTENSIONS, (ext) => `.${ext}`),
].join(',');

export interface PendingAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  originalSize?: number;
  kind: 'image' | 'text';
  status: 'reading' | 'ready' | 'error';
  error?: string;
  base64Data?: string;
  previewUrl?: string;
  textContent?: string;
  abortRead?: () => void;
}

function getExtension(filename: string): string {
  const idx = filename.lastIndexOf('.');
  return idx >= 0 ? filename.slice(idx + 1).toLowerCase() : '';
}

const IMAGE_MIME_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/avif': 'avif',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
  'image/svg+xml': 'svg',
};

// defaultAttachmentName gives clipboard images without a filename a stable name.
export function defaultAttachmentName(file: Pick<File, 'name' | 'type'>): string {
  const name = file.name?.trim();
  if (name) return name;
  const ext = IMAGE_MIME_EXTENSIONS[file.type.toLowerCase()];
  return ext ? `pasted-image.${ext}` : 'pasted-file';
}

function clipboardFileKey(file: File): string {
  return `${file.name}\u0000${file.size}\u0000${file.lastModified}\u0000${file.type}`;
}

// collectClipboardImageFiles reads image files from one paste event, preferring
// clipboardData.items and falling back to clipboardData.files without appending
// the same file twice.
export function collectClipboardImageFiles(data: DataTransfer | null): File[] {
  if (!data) return [];
  const images: File[] = [];
  const seen = new Set<string>();
  const push = (file: File | null | undefined) => {
    if (!file || (!file.type.toLowerCase().startsWith('image/') && classifyFile(file) !== 'image')) return;
    const key = clipboardFileKey(file);
    if (seen.has(key)) return;
    seen.add(key);
    images.push(file);
  };
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== 'file') continue;
    push(item.getAsFile());
  }
  for (const file of Array.from(data.files ?? [])) {
    push(file);
  }
  return images;
}

// clipboardHasPlainText reports whether the clipboard also carries plain text,
// in which case the browser's native insertion, caret and undo stay untouched.
export function clipboardHasPlainText(data: DataTransfer | null): boolean {
  if (!data) return false;
  return (
    Array.from(data.types ?? []).includes('text/plain') &&
    data.getData('text/plain').length > 0
  );
}

export function classifyFile(
  file: Pick<File, 'name' | 'type'>,
): 'image' | 'text' | 'unsupported' {
  const ext = getExtension(file.name);
  const mime = file.type.toLowerCase();
  if (ext === 'svg' || mime === 'image/svg+xml') return 'text';
  if (ext === 'tif' || ext === 'tiff') return 'unsupported';
  if (mime.startsWith('image/') || ALLOWED_IMAGE_EXTENSIONS.has(ext)) {
    return 'image';
  }
  if (mime.startsWith('text/') || ALLOWED_TEXT_EXTENSIONS.has(ext)) {
    return 'text';
  }
  return 'unsupported';
}

export function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function attachmentToContentBlock(att: PendingAttachment): ContentBlock {
  if (att.kind === 'image') {
    return {
      type: 'image',
      mimeType: att.mimeType || 'image/png',
      data: att.base64Data ?? '',
    };
  }
  return {
    type: 'text',
    text: `<file name="${escapeXmlAttr(att.name)}">\n${att.textContent ?? ''}\n</file>`,
  };
}

export function readAttachmentFile(
  file: File,
  opts: {
    onUpdate: (att: PendingAttachment) => void;
  },
): PendingAttachment {
  const id = `att-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const name = defaultAttachmentName(file);
  const classified = classifyFile(file);

  if (classified === 'unsupported') {
    return {
      id,
      name,
      mimeType: file.type || 'application/octet-stream',
      size: file.size,
      kind: 'text',
      status: 'error',
      error: '不支持此文件类型',
    };
  }

  const maxSize = classified === 'image' ? MAX_RAW_IMAGE_BYTES : MAX_ATTACHMENT_BYTES;
  if (file.size > maxSize) {
    return {
      id,
      name,
      mimeType: file.type || 'application/octet-stream',
      size: file.size,
      kind: classified,
      status: 'error',
      error: classified === 'image' ? '图片原文件超过 25 MiB 上限' : '单文件超过 8 MiB 上限',
    };
  }

  const reader = new FileReader();
  const controller = new AbortController();
  const { signal } = controller;
  let previewUrl: string | undefined;
  const abortRead = () => {
    controller.abort();
    if (reader.readyState === FileReader.LOADING) reader.abort();
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
      previewUrl = undefined;
    }
  };
  const initial: PendingAttachment = {
    id,
    name,
    mimeType: classified === 'image' && !file.type.toLowerCase().startsWith('image/')
      ? IMAGE_EXTENSION_MIME[getExtension(file.name)]
      : file.type || 'text/plain',
    size: file.size,
    kind: classified,
    status: 'reading',
    abortRead,
  };
  const fail = (error: string) => {
    if (signal.aborted) return;
    abortRead();
    opts.onUpdate({ ...initial, status: 'error', error });
  };
  reader.onerror = () => fail('读取文件失败');

  if (classified === 'image') {
    void compressImageFile(file, { signal, mimeType: initial.mimeType }).then((result) => {
      if (signal.aborted) return;
      if (result.compressedSize > MAX_ATTACHMENT_BYTES) {
        fail('压缩后图片仍超过 8 MiB 上限');
        return;
      }
      reader.onload = () => {
        if (signal.aborted) return;
        const dataUrl = reader.result as string;
        previewUrl = typeof URL.createObjectURL === 'function' ? URL.createObjectURL(result.blob) : undefined;
        opts.onUpdate({
          ...initial,
          status: 'ready',
          mimeType: result.mimeType,
          originalSize: result.originalSize,
          size: result.compressedSize,
          base64Data: dataUrl.slice(dataUrl.indexOf(',') + 1),
          previewUrl,
        });
      };
      reader.readAsDataURL(result.blob);
    }).catch((error: unknown) => fail(error instanceof Error && error.message === '无法解码该图片格式'
      ? error.message
      : '读取图片失败'));
  } else {
    reader.onload = () => {
      if (signal.aborted) return;
      const textContent = reader.result as string;
      if (textContent.includes('\u0000')) {
        fail('检测到二进制内容，无法作为文本附加');
        return;
      }
      opts.onUpdate({ ...initial, textContent, status: 'ready' });
    };
    reader.readAsText(file);
  }

  return initial;
}

export function revokeAttachmentResources(att: PendingAttachment) {
  att.abortRead?.();
}

export function estimateStreamRequestBytes(payload: unknown): number {
  return measureUtf8Bytes(JSON.stringify(payload));
}

export function isWithinRequestLimit(payload: unknown): boolean {
  return estimateStreamRequestBytes(payload) < MAX_GATEWAY_BODY_BYTES;
}
