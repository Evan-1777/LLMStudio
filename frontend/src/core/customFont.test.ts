import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CUSTOM_FONT_MAX_BYTES,
  hasTrueTypeSignature,
  importCustomFont,
  validateCustomFontFile,
} from './customFont';

function sfntHeader(tag = 0x00010000): ArrayBuffer {
  const buffer = new ArrayBuffer(16);
  new DataView(buffer).setUint32(0, tag, false);
  return buffer;
}

describe('custom font validation', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('accepts an uppercase .ttf extension and rejects other containers', () => {
    expect(() => validateCustomFontFile('Font.TTF', 1024)).not.toThrow();
    expect(() => validateCustomFontFile('font.otf', 1024)).toThrow('仅支持 .ttf');
    expect(() => validateCustomFontFile('font.woff', 1024)).toThrow('仅支持 .ttf');
  });

  it('rejects empty and oversize files before reading them', () => {
    expect(() => validateCustomFontFile('empty.ttf', 0)).toThrow('字体文件为空');
    expect(() =>
      validateCustomFontFile('huge.ttf', CUSTOM_FONT_MAX_BYTES + 1),
    ).toThrow('不能超过 32 MiB');
  });

  it('accepts TrueType sfnt signatures and rejects collections and OpenType', () => {
    expect(hasTrueTypeSignature(sfntHeader(0x00010000))).toBe(true);
    expect(hasTrueTypeSignature(sfntHeader(0x74727565))).toBe(true);
    expect(hasTrueTypeSignature(sfntHeader(0x4f54544f))).toBe(false);
    expect(hasTrueTypeSignature(sfntHeader(0x74746366))).toBe(false);
    expect(hasTrueTypeSignature(new ArrayBuffer(2))).toBe(false);
  });

  it('reports a decoding failure without saving a replacement', async () => {
    class RejectingFontFace {
      constructor() {}
      load() {
        return Promise.reject(new Error('字体解码失败'));
      }
    }
    vi.stubGlobal('FontFace', RejectingFontFace);
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: { add: vi.fn(), delete: vi.fn() },
    });
    const file = new File([sfntHeader()], 'broken.ttf');
    await expect(importCustomFont(file)).rejects.toThrow('字体解码失败');
  });
});
