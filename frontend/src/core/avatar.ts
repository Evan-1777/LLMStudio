// Browser-side avatar preprocessing: crop to a centered square, rasterize at
// 128x128 PNG, and keep the encoded payload inside the gateway's 96 KiB budget.
export const AVATAR_SIZE = 128;
export const AVATAR_MAX_BYTES = 96 * 1024;
const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
const DATA_URL_PREFIX = 'data:image/png;base64,';
// Base64 expands by 4/3; leave room for the prefix in the same length budget.
const MAX_DATA_URL_LENGTH =
  DATA_URL_PREFIX.length + Math.ceil(AVATAR_MAX_BYTES / 3) * 4;

function readFailure(message: string): Error {
  return new Error(message);
}

/** Converts a picked image file into the PNG data URL stored by the gateway. */
export async function fileToAvatarDataUrl(file: File): Promise<string> {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
    throw readFailure('仅支持 PNG、JPEG 或 WebP 图片');
  }
  if (file.size > MAX_SOURCE_BYTES) {
    throw readFailure('图片不能超过 8 MiB');
  }
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw readFailure('无法读取该图片');
  }
  try {
    const side = Math.min(bitmap.width, bitmap.height);
    if (side <= 0) throw readFailure('无法读取该图片');
    const canvas = document.createElement('canvas');
    canvas.width = AVATAR_SIZE;
    canvas.height = AVATAR_SIZE;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw readFailure('当前浏览器无法处理图片');
    ctx.drawImage(
      bitmap,
      (bitmap.width - side) / 2,
      (bitmap.height - side) / 2,
      side,
      side,
      0,
      0,
      AVATAR_SIZE,
      AVATAR_SIZE,
    );
    const dataUrl = canvas.toDataURL('image/png');
    if (!dataUrl.startsWith(DATA_URL_PREFIX) || dataUrl.length > MAX_DATA_URL_LENGTH) {
      throw readFailure('头像过大，请换一张更简单的图片');
    }
    return dataUrl;
  } finally {
    bitmap.close?.();
  }
}
