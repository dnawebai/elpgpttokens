import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAIProvider, isOpenAIReasoningModel } from '../../providers/openai.js';
import { getProvider } from '../../providers/index.js';

function completion() {
  return new Response(JSON.stringify({
    id: 'chatcmpl-1', object: 'chat.completion', created: 1, model: 'm',
    choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

describe('OpenAIProvider', () => {
  afterEach(() => vi.restoreAllMocks());

  it('is registered for the openai platform', () => {
    expect(getProvider('openai')).toBeInstanceOf(OpenAIProvider);
  });

  it('classifies reasoning-model families', () => {
    for (const id of ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-5', 'o3-mini', 'gpt-10-x']) expect(isOpenAIReasoningModel(id)).toBe(true);
    for (const id of ['gpt-4o', 'gpt-4.1-mini', 'dall-e-3']) expect(isOpenAIReasoningModel(id)).toBe(false);
  });

  it('sends max_completion_tokens, strips replay fields, and drops sampling on reasoning models', async () => {
    const bodies: any[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      expect(String(url)).toBe('https://api.openai.com/v1/chat/completions');
      bodies.push(JSON.parse(String(init?.body)));
      return completion();
    });
    const provider = new OpenAIProvider();
    const messages = [
      { role: 'user' as const, content: 'hi' },
      { role: 'assistant' as const, content: 'hello', reasoning_content: 'internal' },
      { role: 'user' as const, content: 'again' },
    ];
    await provider.chatCompletion('sk-test', messages, 'gpt-6.1-sol', { temperature: 0.2, top_p: 0.5, max_tokens: 100 });
    await provider.chatCompletion('sk-test', messages, 'gpt-4o', { temperature: 0.2, max_tokens: 100 });

    expect(bodies[0]).toMatchObject({ model: 'gpt-6.1-sol', max_completion_tokens: 100 });
    expect(bodies[0]).not.toHaveProperty('max_tokens');
    expect(bodies[0].temperature).toBeUndefined();
    expect(bodies[0].top_p).toBeUndefined();
    expect(bodies[0].messages[1]).not.toHaveProperty('reasoning_content');
    expect(bodies[1]).toMatchObject({ model: 'gpt-4o', temperature: 0.2, max_completion_tokens: 100 });
  });
});
