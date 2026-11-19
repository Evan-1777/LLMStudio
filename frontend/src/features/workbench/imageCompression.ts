const OPTIMIZED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

export interface CompressImageOptions {
  signal?: AbortSignal;
  mimeType?: string;
}

export interface CompressedImageResult {
  blob: Blob;
  mimeType: string;
  originalSize: number;
  compressedSize: number;
  compressed: boolean;
}

function canvasEncoder(width: number, height: number) {
  if (typeof OffscreenCanvas !== 'undefined' && typeof OffscreenCanvas.prototype.convertToBlob === 'function') {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (ctx) return { ctx, encode: (type: string, quality: number) => canvas.convertToBlob({ type, quality }) };
  }
  if (typeof document === 'undefined' || typeof HTMLCanvasElement.prototype.toBlob !== 'function') return;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    return {
      ctx,
      encode: (type: string, quality: number) => new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality)),
    };
  }
}

async function encodeBitmap(bitmap: ImageBitmap, maxDimension: number, quality: number, signal?: AbortSignal) {
  const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = canvasEncoder(width, height);
  if (!canvas) return null;
  const { ctx, encode } = canvas;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, width, height);
  const webp = await encode('image/webp', quality).catch(() => null);
  signal?.throwIfAborted();
  if (webp?.type === 'image/webp' && webp.size > 0) return webp;

  // Composite a white backdrop behind the existing drawing before dropping alpha.
  ctx.globalCompositeOperation = 'destination-over';
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, width, height);
  const jpeg = await encode('image/jpeg', quality).catch(() => null);
  signal?.throwIfAborted();
  return jpeg?.type === 'image/jpeg' && jpeg.size > 0 ? jpeg : null;
}

export async function compressImageFile(file: File, options: CompressImageOptions = {}): Promise<CompressedImageResult> {
  const { signal, mimeType = file.type } = options;
  const originalMime = mimeType.toLowerCase();
  const canKeepOriginal = OPTIMIZED_IMAGE_TYPES.has(originalMime);
  const result = (blob: Blob, compressed: boolean) => ({
    blob,
    mimeType: compressed ? blob.type : originalMime,
    originalSize: file.size,
    compressedSize: blob.size,
    compressed,
  });
  signal?.throwIfAborted();
  if ((canKeepOriginal && file.size <= 32 * 1024) ||
      (originalMime === 'image/gif' && file.size <= 1024 * 1024) ||
      typeof createImageBitmap !== 'function') {
    return result(file, false);
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch (error) {
    signal?.throwIfAborted();
    throw new Error('无法解码该图片格式', { cause: error });
  }
  try {
    signal?.throwIfAborted();
    let encoded = await encodeBitmap(bitmap, 1600, 0.8, signal);
    if (encoded && encoded.size > 1.5 * 1024 * 1024) {
      const smaller = await encodeBitmap(bitmap, 1280, 0.65, signal);
      if (smaller && smaller.size < encoded.size) encoded = smaller;
    }
    return !encoded || (canKeepOriginal && encoded.size >= file.size)
      ? result(file, false)
      : result(encoded, true);
  } catch (error) {
    signal?.throwIfAborted();
    if (canKeepOriginal || originalMime === 'image/gif') return result(file, false);
    throw error;
  } finally {
    bitmap.close();
  }
}
