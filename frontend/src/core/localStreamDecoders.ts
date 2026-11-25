import type { StreamEvent } from './types';
import { decodeAnthropicMessages } from './decoders/anthropicMessages';
import { decodeGoogleGenAI } from './decoders/googleGenAI';
import { decodeOpenAICompletions } from './decoders/openaiCompletions';
import { decodeOpenAIResponses } from './decoders/openaiResponses';
import type { LocalStreamMeta } from './decoders/shared';

export type { LocalStreamMeta } from './decoders/shared';

export async function decodeUpstreamSseStream(
  apiFormat: string,
  body: ReadableStream<Uint8Array>,
  meta: LocalStreamMeta,
  emit: (event: StreamEvent) => void,
): Promise<void> {
  switch (apiFormat) {
    case 'openai-completions':
      await decodeOpenAICompletions(body, meta, emit);
      return;
    case 'openai-responses':
      await decodeOpenAIResponses(body, meta, emit);
      return;
    case 'anthropic-messages':
      await decodeAnthropicMessages(body, meta, emit);
      return;
    case 'google-generative-ai':
      await decodeGoogleGenAI(body, meta, emit);
      return;
    default:
      throw new Error(`unsupported apiFormat: ${apiFormat}`);
  }
}
