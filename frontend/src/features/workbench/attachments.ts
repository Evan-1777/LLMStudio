import {
  MAX_ATTACHMENT_BYTES,
  MAX_GATEWAY_BODY_BYTES,
  type ContentBlock,
} from '../../core/types';
import { measureUtf8Bytes } from '../../core/gateway';

export const ALLOWED_TEXT_EXTENSIONS = new Set([
  'txt',
  'md',
  'markdown',
  'json',
  'csv',
  'yaml',
  'yml',
  'xml',
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

export const ALLOWED_IMAGE_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'webp',
  'gif',
]);

export const FILE_INPUT_ACCEPT = [
  'image/*',
  ...Array.from(ALLOWED_TEXT_EXTENSIONS, (ext) => `.${ext}`),
].join(',');

export interface PendingAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
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

export function classifyFile(
  file: Pick<File, 'name' | 'type'>,
): 'image' | 'text' | 'unsupported' {
  const ext = getExtension(file.name);
  if (file.type.startsWith('image/') || ALLOWED_IMAGE_EXTENSIONS.has(ext)) {
    return 'image';
  }
  if (file.type.startsWith('text/') || ALLOWED_TEXT_EXTENSIONS.has(ext)) {
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
    supportsImageInput: boolean;
    onUpdate: (att: PendingAttachment) => void;
  },
): PendingAttachment {
  const id = `att-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const classified = classifyFile(file);

  if (classified === 'unsupported') {
    return {
      id,
      name: file.name,
      mimeType: file.type || 'application/octet-stream',
      size: file.size,
      kind: 'text',
      status: 'error',
      error: '不支持此文件类型',
    };
  }

  if (classified === 'image' && !opts.supportsImageInput) {
    return {
      id,
      name: file.name,
      mimeType: file.type || 'image/png',
      size: file.size,
      kind: 'image',
      status: 'error',
      error: '当前模型不支持图片输入',
    };
  }

  if (file.size > MAX_ATTACHMENT_BYTES) {
    return {
      id,
      name: file.name,
      mimeType: file.type || 'application/octet-stream',
      size: file.size,
      kind: classified,
      status: 'error',
      error: '单文件超过 8 MiB 上限',
    };
  }

  const reader = new FileReader();
  let canceled = false;
  const previewUrl =
    classified === 'image' && typeof URL.createObjectURL === 'function'
      ? URL.createObjectURL(file)
      : undefined;

  const initial: PendingAttachment = {
    id,
    name: file.name,
    mimeType:
      file.type || (classified === 'image' ? 'image/png' : 'text/plain'),
    size: file.size,
    kind: classified,
    status: 'reading',
    previewUrl,
    abortRead: () => {
      canceled = true;
      if (reader.readyState === FileReader.LOADING) {
        reader.abort();
      }
      if (previewUrl && typeof URL.revokeObjectURL === 'function') {
        URL.revokeObjectURL(previewUrl);
      }
    },
  };

  reader.onload = () => {
    if (canceled) return;
    const raw = typeof reader.result === 'string' ? reader.result : '';
    if (classified === 'image') {
      let mime = initial.mimeType;
      let base64Data = raw;
      const commaIdx = raw.indexOf(',');
      if (raw.startsWith('data:') && commaIdx > 0) {
        const header = raw.slice(5, commaIdx);
        const semiIdx = header.indexOf(';');
        if (semiIdx > 0) {
          mime = header.slice(0, semiIdx);
        }
        base64Data = raw.slice(commaIdx + 1);
      }
      opts.onUpdate({
        ...initial,
        mimeType: mime,
        base64Data,
        status: 'ready',
      });
    } else {
      if (raw.includes('\u0000')) {
        opts.onUpdate({
          ...initial,
          status: 'error',
          error: '检测到二进制内容，无法作为文本附加',
        });
        return;
      }
      opts.onUpdate({
        ...initial,
        textContent: raw,
        status: 'ready',
      });
    }
  };

  reader.onerror = () => {
    if (canceled) return;
    if (previewUrl && typeof URL.revokeObjectURL === 'function') {
      URL.revokeObjectURL(previewUrl);
    }
    opts.onUpdate({
      ...initial,
      previewUrl: undefined,
      status: 'error',
      error: '读取文件失败',
    });
  };

  reader.onabort = () => {
    if (previewUrl && typeof URL.revokeObjectURL === 'function') {
      URL.revokeObjectURL(previewUrl);
    }
  };

  if (classified === 'image') {
    reader.readAsDataURL(file);
  } else {
    reader.readAsText(file);
  }

  return initial;
}

export function revokeAttachmentResources(att: PendingAttachment) {
  att.abortRead?.();
  if (att.previewUrl && typeof URL.revokeObjectURL === 'function') {
    URL.revokeObjectURL(att.previewUrl);
  }
}

export function estimateStreamRequestBytes(payload: unknown): number {
  return measureUtf8Bytes(JSON.stringify(payload));
}

export function isWithinRequestLimit(payload: unknown): boolean {
  return estimateStreamRequestBytes(payload) < MAX_GATEWAY_BODY_BYTES;
}
