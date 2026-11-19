import { afterEach, describe, expect, it, vi } from 'vitest';
import { compressImageFile } from './imageCompression';

const MIB = 1024 * 1024;
const blob = (size: number, type = 'image/webp') => new Blob([new Uint8Array(size)], { type });
const file = (size = 3 * MIB, type = 'image/png') => new File([new Uint8Array(size)], 'picture', { type });

function nativeEncoder() {
  const bitmap = { width: 4000, height: 3000, close: vi.fn() };
  const ctx = { drawImage: vi.fn(), fillRect: vi.fn(), fillStyle: '', globalCompositeOperation: 'source-over' };
  const encode = vi.fn<() => Promise<Blob>>().mockResolvedValue(blob(400));
  class Canvas {
    getContext = () => ctx;
    convertToBlob(_options: ImageEncodeOptions) { return encode(); }
  }
  const decode = vi.fn().mockResolvedValue(bitmap);
  vi.stubGlobal('OffscreenCanvas', Canvas);
  vi.stubGlobal('createImageBitmap', decode);
  const encodeSpy = vi.spyOn(Canvas.prototype, 'convertToBlob');
  return { ctx, bitmap, encode, encodeSpy, decode };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('compressImageFile', () => {
  it.each([[32 * 1024, 'image/png'], [MIB, 'image/gif']] as const)('keeps a %d byte %s untouched', async (size, type) => {
    const { decode } = nativeEncoder();
    const original = file(size, type);
    expect(await compressImageFile(original)).toEqual({ blob: original, mimeType: type, originalSize: size, compressedSize: size, compressed: false });
    expect(decode).not.toHaveBeenCalled();
  });

  it('scales a photo without distortion, prefers WebP, and releases the bitmap', async () => {
    const { ctx, bitmap, encodeSpy, decode } = nativeEncoder();
    const original = file();
    expect(await compressImageFile(original)).toMatchObject({ mimeType: 'image/webp', compressed: true, compressedSize: 400 });
    expect(decode).toHaveBeenCalledWith(original, { imageOrientation: 'from-image' });
    expect(ctx.drawImage).toHaveBeenCalledWith(bitmap, 0, 0, 1600, 1200);
    expect(encodeSpy).toHaveBeenCalledWith({ type: 'image/webp', quality: 0.8 });
    expect(bitmap.close).toHaveBeenCalledOnce();
  });

  it('uses a white backdrop when WebP encoding falls back to JPEG', async () => {
    const { ctx, bitmap, encode, encodeSpy } = nativeEncoder();
    encode.mockResolvedValueOnce(blob(800, 'image/png')).mockResolvedValueOnce(blob(600, 'image/jpeg'));
    expect(await compressImageFile(file())).toMatchObject({ mimeType: 'image/jpeg', compressedSize: 600 });
    expect(encodeSpy).toHaveBeenLastCalledWith({ type: 'image/jpeg', quality: 0.8 });
    expect(ctx.fillStyle).toBe('#fff');
    expect(ctx.globalCompositeOperation).toBe('destination-over');
    expect(ctx.fillRect).toHaveBeenCalledWith(0, 0, 1600, 1200);
    expect(bitmap.close).toHaveBeenCalledOnce();
  });

  it('reduces dimensions and quality again when the first encoding exceeds 1.5 MiB', async () => {
    const { ctx, bitmap, encode, encodeSpy } = nativeEncoder();
    encode.mockResolvedValueOnce(blob(2 * MIB));
    expect(await compressImageFile(file())).toMatchObject({ compressedSize: 400 });
    expect(ctx.drawImage).toHaveBeenLastCalledWith(bitmap, 0, 0, 1280, 960);
    expect(encodeSpy).toHaveBeenLastCalledWith({ type: 'image/webp', quality: 0.65 });
  });

  it('keeps an optimized original when the output is no smaller', async () => {
    const { encode } = nativeEncoder();
    encode.mockResolvedValueOnce(blob(64 * 1024));
    const original = file(48 * 1024);
    expect(await compressImageFile(original)).toMatchObject({ blob: original, compressed: false });
  });

  it('uses HTMLCanvasElement when OffscreenCanvas is absent', async () => {
    const { ctx } = nativeEncoder();
    vi.stubGlobal('OffscreenCanvas', undefined);
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) => callback(blob(200)));
    expect(await compressImageFile(file())).toMatchObject({ compressedSize: 200 });
  });

  it('keeps the original when no canvas encoder is present', async () => {
    const { bitmap } = nativeEncoder();
    vi.stubGlobal('OffscreenCanvas', undefined);
    vi.stubGlobal('HTMLCanvasElement', class {});
    const original = file();
    expect(await compressImageFile(original)).toMatchObject({ blob: original, compressed: false });
    expect(bitmap.close).toHaveBeenCalledOnce();
  });

  it('closes a bitmap decoded after cancellation and never encodes it', async () => {
    const { bitmap, encodeSpy } = nativeEncoder();
    const controller = new AbortController();
    const outcome = compressImageFile(file(), { signal: controller.signal });
    controller.abort();
    await expect(outcome).rejects.toHaveProperty('name', 'AbortError');
    expect(encodeSpy).not.toHaveBeenCalled();
    expect(bitmap.close).toHaveBeenCalledOnce();
  });

  it('reports an unsupported image that the real decoder rejects', async () => {
    const { decode } = nativeEncoder();
    decode.mockRejectedValue(new Error('bad format'));
    await expect(compressImageFile(file(200, 'image/heic'))).rejects.toThrow('无法解码该图片格式');
  });
});
