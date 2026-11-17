import { describe, expect, it } from 'vitest';
import { decodeSseByteStream, parseStreamEventFrame } from './sse';

function streamFromChunks(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) {
        controller.enqueue(c);
      }
      controller.close();
    },
  });
}

describe('decodeSseByteStream', () => {
  it('handles UTF-8 split across chunks, CRLF, multi-line data, and multiple frames per chunk', async () => {
    const encoder = new TextEncoder();
    const chinesePayload =
      'event: block_delta\r\ndata: {"type":"block_delta","index":0,"blockType":"text",\r\ndata: "deltaType":"text_delta","delta":"你好世界"}\r\n\r\n' +
      'event: message_end\ndata: {"type":"message_end"}\n\n';
    const fullBytes = encoder.encode(chinesePayload);

    // Slice inside the multi-byte UTF-8 sequence for '好' and across frames.
    const split1 = chinesePayload.indexOf('世界');
    const byteCut = encoder.encode(chinesePayload.slice(0, split1)).length - 1;
    const chunks = [
      fullBytes.slice(0, 22),
      fullBytes.slice(22, byteCut),
      fullBytes.slice(byteCut, byteCut + 15),
      fullBytes.slice(byteCut + 15),
    ];

    const frames = [];
    for await (const frame of decodeSseByteStream(streamFromChunks(chunks))) {
      frames.push(frame);
    }

    expect(frames).toHaveLength(2);
    expect(frames[0].event).toBe('block_delta');
    const ev0 = parseStreamEventFrame({
      event: frames[0].event,
      data: frames[0].data.replace('\n', ''),
    });
    expect(ev0?.index).toBe(0);
    expect(ev0?.delta).toBe('你好世界');
    expect(parseStreamEventFrame(frames[1])?.type).toBe('message_end');
  });

  it('joins multi-line data with newline and flushes trailing frame without double newline', async () => {
    const encoder = new TextEncoder();
    const raw =
      ': comment ignored\n' +
      'event: custom\n' +
      'data: line1\n' +
      'data: line2\n' +
      '\n' +
      'data: {"type":"message_start","messageId":"m1"}';

    const frames = [];
    for await (const frame of decodeSseByteStream(
      streamFromChunks([encoder.encode(raw)]),
    )) {
      frames.push(frame);
    }

    expect(frames).toEqual([
      { event: 'custom', data: 'line1\nline2' },
      { event: '', data: '{"type":"message_start","messageId":"m1"}' },
    ]);
    expect(parseStreamEventFrame(frames[1])).toEqual({
      type: 'message_start',
      messageId: 'm1',
    });
  });
});
