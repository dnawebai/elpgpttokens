import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnthropicProvider, toAnthropicMessages } from '../../providers/anthropic.js';
import { hasProvider } from '../../providers/index.js';
import { newClientAbortError, isClientAbortError } from '../../lib/error-classify.js';
import type { ChatCompletionChunk } from '@freellmapi/shared/types.js';

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

function sseResponse(events: Array<Record<string, unknown>>): Response {
  const body = events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

const message = (over: Record<string, unknown> = {}) => ({
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-5-5',
  content: [{ type: 'text', text: 'Hola' }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  ...over,
});

interface Captured { url: string; headers: Headers; body: any }

function captureFetch(respond: (call: Captured) => Response): Captured[] {
  const calls: Captured[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const call = { url, headers: new Headers(init?.headers), body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    return respond(call);
  });
  return calls;
}

describe('AnthropicProvider', () => {
  afterEach(() => vi.restoreAllMocks());

  it('is registered as a chat platform', () => {
    expect(hasProvider('anthropic')).toBe(true);
  });

  it('builds a Messages request: system, adaptive thinking, fallbacks, no sampling params', async () => {
    const calls = captureFetch(() => jsonResponse(message()));
    const provider = new AnthropicProvider();
    await provider.chatCompletion('sk-ant-test', [
      { role: 'system', content: 'You are ELPGPT.' },
      { role: 'user', content: 'hola' },
    ], 'claude-opus-5-5', { temperature: 0.2, top_p: 0.9, top_k: 5, reasoning_effort: 'high', max_tokens: 500, stop: 'END' });

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.url).toBe('https://api.anthropic.com/v1/messages');
    expect(call.headers.get('anthropic-beta')).toContain('server-side-fallback-2026-07-01');
    expect(call.body).toMatchObject({
      model: 'claude-opus-5-5',
      max_tokens: 500,
      system: 'You are ELPGPT.',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hola' }] }],
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: 'high' },
      fallbacks: 'default',
      stop_sequences: ['END'],
      cache_control: { type: 'ephemeral' },
    });
    // API version 2026-10-21 400s on these on every model.
    expect(call.body).not.toHaveProperty('temperature');
    expect(call.body).not.toHaveProperty('top_p');
    expect(call.body).not.toHaveProperty('top_k');
    expect(call.body).not.toHaveProperty('betas');
  });

  it('leaves thinking and fallbacks off for models that do not take them', async () => {
    const calls = captureFetch(() => jsonResponse(message({ model: 'claude-haiku-4-5' })));
    await new AnthropicProvider().chatCompletion('k', [{ role: 'user', content: 'hi' }], 'claude-haiku-4-5');
    expect(calls[0].body).not.toHaveProperty('thinking');
    expect(calls[0].body).not.toHaveProperty('fallbacks');
    expect(calls[0].headers.get('anthropic-beta')).toBeNull();
    expect(calls[0].body.max_tokens).toBe(16000);
  });

  it('turns a forced tool_choice into auto plus an instruction (forced choice 400s on current models)', async () => {
    const calls = captureFetch(() => jsonResponse(message()));
    await new AnthropicProvider().chatCompletion('k', [{ role: 'user', content: 'weather?' }], 'claude-opus-5-5', {
      tools: [{ type: 'function', function: { name: 'get_weather', description: 'Weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }],
      tool_choice: { type: 'function', function: { name: 'get_weather' } },
      parallel_tool_calls: false,
    });
    expect(calls[0].body.tools).toEqual([{ name: 'get_weather', description: 'Weather', input_schema: { type: 'object', properties: { city: { type: 'string' } } } }]);
    expect(calls[0].body.tool_choice).toEqual({ type: 'auto', disable_parallel_tool_use: true });
    expect(calls[0].body.system).toContain('`get_weather`');
  });

  it('maps the response: text, summarized thinking, tool calls, cached usage, finish reason', async () => {
    captureFetch(() => jsonResponse(message({
      content: [
        { type: 'thinking', thinking: 'User wants weather.', signature: 'sig' },
        { type: 'text', text: 'Checking.' },
        { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Caracas' } },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 5, output_tokens: 7, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 },
    })));
    const res = await new AnthropicProvider().chatCompletion('k', [{ role: 'user', content: 'weather?' }], 'claude-opus-5-5');
    expect(res.choices[0]).toEqual({
      index: 0,
      message: {
        role: 'assistant',
        content: 'Checking.',
        reasoning_content: 'User wants weather.',
        tool_calls: [{ id: 'toolu_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Caracas"}' } }],
      },
      finish_reason: 'tool_calls',
    });
    expect(res.usage).toEqual({ prompt_tokens: 105, completion_tokens: 7, total_tokens: 112, prompt_tokens_details: { cached_tokens: 100 } });
    expect(res.model).toBe('claude-opus-5-5');
  });

  it('streams text, thinking and a whole tool call, then a final chunk with usage', async () => {
    captureFetch(() => sseResponse([
      { type: 'message_start', message: message({ content: [], stop_reason: null, usage: { input_tokens: 9, output_tokens: 1 } }) },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hel' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'lo' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_9', name: 'lookup', input: {} } },
      { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"q":' } },
      { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '"x"}' } },
      { type: 'content_block_stop', index: 2 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 12 } },
      { type: 'message_stop' },
    ]));

    const chunks: ChatCompletionChunk[] = [];
    for await (const c of new AnthropicProvider().streamChatCompletion('k', [{ role: 'user', content: 'hi' }], 'claude-opus-5-5')) {
      chunks.push(c);
    }
    const deltas = chunks.map(c => c.choices[0].delta);
    expect(deltas[0]).toEqual({ role: 'assistant', content: '' });
    expect(deltas.map(d => d.reasoning_content).filter(Boolean).join('')).toBe('hmm');
    expect(deltas.map(d => d.content).filter(Boolean).join('')).toBe('Hello');
    expect(deltas.find(d => d.tool_calls)?.tool_calls).toEqual([
      { index: 0, id: 'toolu_9', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } },
    ]);
    const last = chunks[chunks.length - 1];
    expect(last.choices[0].finish_reason).toBe('tool_calls');
    expect(last.usage).toMatchObject({ prompt_tokens: 9, completion_tokens: 12, total_tokens: 21 });
    expect(last.id).toBe('msg_1');
  });

  it('surfaces status and Retry-After so the router can bench the key', async () => {
    captureFetch(() => jsonResponse({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }, 429, { 'retry-after': '30' }));
    await expect(new AnthropicProvider().chatCompletion('k', [{ role: 'user', content: 'hi' }], 'claude-opus-5-5'))
      .rejects.toMatchObject({ status: 429, retryAfterMs: 30_000 });
  });

  it('returns the client-abort reason untouched so the fallback loop stops cleanly', async () => {
    const controller = new AbortController();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      controller.abort(newClientAbortError());
      throw controller.signal.reason;
    });
    const err = await new AnthropicProvider()
      .chatCompletion('k', [{ role: 'user', content: 'hi' }], 'claude-opus-5-5', { signal: controller.signal })
      .catch(e => e);
    expect(isClientAbortError(err)).toBe(true);
  });

  it('validates keys against the free models endpoint', async () => {
    const calls = captureFetch(({ headers }) => headers.get('authorization') === 'Bearer good'
      ? jsonResponse({ data: [], has_more: false, first_id: null, last_id: null })
      : jsonResponse({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, 401));
    const provider = new AnthropicProvider();
    await expect(provider.validateKey('good')).resolves.toBe(true);
    await expect(provider.validateKey('bad')).resolves.toMatchObject({ valid: false });
    expect(calls[0].url).toMatch(/^https:\/\/api\.anthropic\.com\/v1\/models\?limit=1/);
  });
});

describe('toAnthropicMessages', () => {
  it('groups parallel tool results into one user turn and converts images', () => {
    const { system, messages } = toAnthropicMessages([
      { role: 'system', content: 'A' },
      { role: 'system', content: 'B' },
      { role: 'user', content: [
        { type: 'text', text: 'what is this?' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        { type: 'image_url', image_url: 'https://example.com/cat.jpg' },
      ] },
      { role: 'assistant', content: null, reasoning_content: 'dropped', tool_calls: [
        { id: 't1', type: 'function', function: { name: 'a', arguments: '{"x":1}' } },
        { id: 't2', type: 'function', function: { name: 'b', arguments: '' } },
      ] },
      { role: 'tool', tool_call_id: 't1', content: 'one' },
      { role: 'tool', tool_call_id: 't2', content: 'two' },
    ]);
    expect(system).toBe('A\n\nB');
    expect(messages).toEqual([
      { role: 'user', content: [
        { type: 'text', text: 'what is this?' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
        { type: 'image', source: { type: 'url', url: 'https://example.com/cat.jpg' } },
      ] },
      { role: 'assistant', content: [
        { type: 'tool_use', id: 't1', name: 'a', input: { x: 1 } },
        { type: 'tool_use', id: 't2', name: 'b', input: {} },
      ] },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 't1', content: 'one' },
        { type: 'tool_result', tool_use_id: 't2', content: 'two' },
      ] },
    ]);
  });
});
