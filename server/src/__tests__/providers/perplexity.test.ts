import { afterEach, describe, expect, it, vi } from 'vitest';
import { PerplexityProvider, buildAgentRequest } from '../../providers/perplexity.js';
import { hasProvider } from '../../providers/index.js';
import type { ChatCompletionChunk } from '@freellmapi/shared/types.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function sse(events: Array<Record<string, unknown>>): Response {
  const body = events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

const searchResults = {
  type: 'search_results',
  results: [
    { id: 1, title: 'Fed holds rates', url: 'https://news.example.com/fed', date: '2026-11-14', snippet: 'The Fed held…' },
    { id: 2, title: 'Markets react', url: 'https://markets.example.com/react' },
    { id: 3, title: 'bad', url: 'javascript:alert(1)' },
  ],
};

const completedResponse = {
  id: 'resp_1',
  model: 'openai/gpt-6-luna',
  object: 'response',
  status: 'completed',
  output: [
    searchResults,
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'The Fed held rates steady[1][2].' }] },
  ],
  usage: { input_tokens: 120, output_tokens: 30, total_tokens: 150 },
};

describe('PerplexityProvider (Agent API)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('is registered and does not poll its billed endpoint for health', () => {
    expect(hasProvider('perplexity')).toBe(true);
    expect(new PerplexityProvider().supportsKeyPolling).toBe(false);
  });

  it('maps chat messages onto the Agent API body', () => {
    const body = buildAgentRequest([
      { role: 'system', content: 'Be concise.' },
      { role: 'user', content: 'What did the Fed do?' },
      { role: 'assistant', content: 'Which meeting?' },
      { role: 'user', content: [{ type: 'text', text: 'Latest one' }, { type: 'image_url', image_url: { url: 'https://x.example/chart.png' } }] },
    ], 'fast', { max_tokens: 800 }, true);
    expect(body).toEqual({
      effort: 'fast',
      instructions: 'Be concise.',
      input: [
        { type: 'message', role: 'user', content: 'What did the Fed do?' },
        { type: 'message', role: 'assistant', content: 'Which meeting?' },
        { type: 'message', role: 'user', content: [
          { type: 'input_text', text: 'Latest one' },
          { type: 'input_image', image_url: 'https://x.example/chart.png' },
        ] },
      ],
      max_output_tokens: 800,
      stream: true,
    });
  });

  it('attaches web_search when an explicit model is routed through the Agent API', () => {
    expect(buildAgentRequest([{ role: 'user', content: 'q' }], 'openai/gpt-6.1-sol', undefined, false))
      .toMatchObject({ model: 'openai/gpt-6.1-sol', tools: [{ type: 'web_search' }] });
  });

  it('returns the answer with citations parsed from search_results', async () => {
    const calls: Array<{ url: string; body: any; auth: string | null }> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)), auth: new Headers(init?.headers).get('authorization') });
      return jsonResponse(completedResponse);
    });
    const res = await new PerplexityProvider().chatCompletion('pplx-key', [{ role: 'user', content: 'Fed?' }], 'fast');
    expect(calls[0]).toMatchObject({ url: 'https://api.perplexity.ai/v1/agent', auth: 'Bearer pplx-key' });
    expect(res.choices[0].message.content).toBe('The Fed held rates steady[1][2].');
    expect(res.model).toBe('openai/gpt-6-luna');
    expect(res.usage).toEqual({ prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 });
    expect(res.citations).toEqual([
      { index: 1, url: 'https://news.example.com/fed', title: 'Fed holds rates', snippet: 'The Fed held…', date: '2026-11-14' },
      { index: 2, url: 'https://markets.example.com/react', title: 'Markets react' },
    ]);
  });

  it('streams typed SSE text deltas and puts citations + usage on the final chunk', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(sse([
      { type: 'response.created', response: { id: 'resp_s', model: 'openai/gpt-6-luna', status: 'in_progress' } },
      { type: 'response.output_item.done', output_index: 0, item: searchResults },
      { type: 'response.output_text.delta', delta: 'The Fed ' },
      { type: 'response.output_text.delta', delta: 'held[1].' },
      { type: 'response.completed', response: completedResponse },
    ]));
    const chunks: ChatCompletionChunk[] = [];
    for await (const c of new PerplexityProvider().streamChatCompletion('k', [{ role: 'user', content: 'Fed?' }], 'fast')) chunks.push(c);

    expect(chunks.map(c => c.choices[0].delta.content ?? '').join('')).toBe('The Fed held[1].');
    expect(chunks[0].choices[0].delta.role).toBe('assistant');
    const last = chunks[chunks.length - 1];
    expect(last.choices[0].finish_reason).toBe('stop');
    expect(last.usage).toMatchObject({ total_tokens: 150 });
    expect(last.citations?.map(c => c.url)).toEqual(['https://news.example.com/fed', 'https://markets.example.com/react']);
    expect(last.id).toBe('resp_s');
  });

  it('raises a retryable 502 when the run fails mid-stream', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(sse([
      { type: 'response.failed', response: { status: 'failed', error: { message: 'search backend down' } } },
    ]));
    const gen = new PerplexityProvider().streamChatCompletion('k', [{ role: 'user', content: 'q' }], 'fast');
    await expect((async () => { for await (const _ of gen) { /* drain */ } })()).rejects.toMatchObject({ status: 502 });
  });

  it('rejects a truncated stream instead of reporting success', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(sse([{ type: 'response.output_text.delta', delta: 'partial' }]));
    const gen = new PerplexityProvider().streamChatCompletion('k', [{ role: 'user', content: 'q' }], 'fast');
    await expect((async () => { for await (const _ of gen) { /* drain */ } })()).rejects.toThrow(/ended unexpectedly/);
  });

  it('carries upstream status on HTTP errors', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ error: { message: 'quota exceeded' } }, 429));
    await expect(new PerplexityProvider().chatCompletion('k', [{ role: 'user', content: 'q' }], 'fast'))
      .rejects.toMatchObject({ status: 429 });
  });

  it('validates a key with an empty body: 400 = valid, 401 = invalid', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    fetch.mockResolvedValueOnce(jsonResponse({ error: { message: 'input is required' } }, 400));
    await expect(new PerplexityProvider().validateKey('good')).resolves.toBe(true);
    fetch.mockResolvedValueOnce(jsonResponse({ error: { message: 'Invalid API key' } }, 401));
    await expect(new PerplexityProvider().validateKey('bad')).resolves.toMatchObject({ valid: false, error: expect.stringContaining('Invalid API key') });
  });
});
