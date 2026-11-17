import type { CompletionOptions } from './base.js';
import { OpenAICompatProvider } from './openai-compat.js';

export const OPENAI_BASE_URL = 'https://api.openai.com/v1';

/**
 * Reasoning-model families (GPT-5 onward, the o-series) accept only the
 * default sampling: a non-default `temperature` or `top_p` is a 400
 * ("Only the default (1) value is supported"). Older chat models still take
 * both, so the rule is per model family, not per platform.
 */
export function isOpenAIReasoningModel(modelId: string): boolean {
  return /^(?:gpt-(?:[5-9]|\d{2,})|o\d)/i.test(modelId);
}

/**
 * OpenAI (api.openai.com). Chat Completions is still served for the GPT-6
 * family, so this is the compat adapter plus OpenAI's two wire rules:
 * `max_completion_tokens` instead of `max_tokens`, and no custom sampling on
 * reasoning models. Image generation and transcription for this platform are
 * native branches in services/media.ts.
 */
export class OpenAIProvider extends OpenAICompatProvider {
  constructor() {
    super({
      platform: 'openai',
      name: 'OpenAI',
      baseUrl: OPENAI_BASE_URL,
      maxTokensField: 'max_completion_tokens',
      // Reasoning turns can think for a while before the first byte.
      timeoutMs: 180_000,
    });
  }

  protected override samplingForModel(modelId: string, options?: CompletionOptions) {
    if (isOpenAIReasoningModel(modelId)) return { temperature: undefined, topP: undefined };
    return super.samplingForModel(modelId, options);
  }
}
