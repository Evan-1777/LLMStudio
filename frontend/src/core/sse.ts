import type { StreamEvent } from './types';

export interface SseFrame {
  event: string;
  data: string;
}

/**
 * Decodes a UTF-8 SSE byte stream into frames delimited by blank lines (\n\n or \r\n\r\n).
 * Handles multi-byte UTF-8 sequences split across chunks, CRLF, multi-line data,
 * multiple frames in a single chunk, and EOF flush.
 */
export async function* decodeSseByteStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SseFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: false });

  let lineBuffer = '';
  let currentEvent = '';
  let dataLines: string[] = [];

  const flushFrame = (): SseFrame | null => {
    if (!currentEvent && dataLines.length === 0) {
      return null;
    }
    const frame: SseFrame = {
      event: currentEvent,
      data: dataLines.join('\n'),
    };
    currentEvent = '';
    dataLines = [];
    return frame;
  };

  const handleLine = (rawLine: string): SseFrame | null => {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line === '') {
      return flushFrame();
    }
    if (line.startsWith(':')) {
      return null;
    }
    const colonIdx = line.indexOf(':');
    if (colonIdx < 0) {
      return null;
    }
    const field = line.slice(0, colonIdx);
    let value = line.slice(colonIdx + 1);
    if (value.startsWith(' ')) {
      value = value.slice(1);
    }
    if (field === 'event') {
      currentEvent = value;
    } else if (field === 'data') {
      dataLines.push(value);
    }
    return null;
  };

  const processChunkText = (chunk: string): SseFrame[] => {
    const frames: SseFrame[] = [];
    let start = 0;
    while (true) {
      const nl = chunk.indexOf('\n', start);
      if (nl < 0) {
        lineBuffer += chunk.slice(start);
        break;
      }
      lineBuffer += chunk.slice(start, nl);
      const frame = handleLine(lineBuffer);
      lineBuffer = '';
      if (frame) {
        frames.push(frame);
      }
      start = nl + 1;
    }
    return frames;
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value && value.length > 0) {
        const text = decoder.decode(value, { stream: true });
        for (const frame of processChunkText(text)) {
          yield frame;
        }
      }
    }

    const tail = decoder.decode();
    if (tail) {
      for (const frame of processChunkText(tail)) {
        yield frame;
      }
    }

    if (lineBuffer.length > 0) {
      const frame = handleLine(lineBuffer);
      lineBuffer = '';
      if (frame) {
        yield frame;
      }
    }

    const trailing = flushFrame();
    if (trailing) {
      yield trailing;
    }
  } finally {
    reader.releaseLock();
  }
}

export function parseStreamEventFrame(frame: SseFrame): StreamEvent | null {
  const raw = frame.data.trim();
  if (!raw || raw === '[DONE]') {
    return null;
  }
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const ev = parsed as StreamEvent;
  if (!ev.type && frame.event) {
    return { ...ev, type: frame.event as StreamEvent['type'] };
  }
  return ev;
}
