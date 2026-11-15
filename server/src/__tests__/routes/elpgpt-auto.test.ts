import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { setRoutingStrategy } from '../../services/router.js';
import { clearAllCooldowns } from '../../services/ratelimit.js';
import { ensureElpCatalog, loadRouteTable, DEFAULT_ROUTES, searchGroundingPrompt, buildImagePrompt } from '../../services/elp-router.js';
import { classifyIntent } from '../../services/intent.js';
import { ensureAllModelsInProfiles } from '../../services/profile-models.js';
import { mintDashboardToken, isGatedApiPath } from '../helpers/auth.js';

let app: Express;
let dashToken = '';

async function request(method: string, path: string, body?: any, headers: Record<string, string> = {}) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as any;
  const res = await realFetch(`http://127.0.0.1:${addr.port}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(isGatedApiPath(path) && !('Authorization' in headers) ? { Authorization: `Bearer ${dashToken}` } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  server.close();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* SSE */ }
  return { status: res.status, body: json, text, headers: res.headers };
}

const realFetch = globalThis.fetch;
const inference = () => ({ Authorization: `Bearer ${getUnifiedApiKey()}` });
const routeHeader = (headers: Headers) => JSON.parse(decodeURIComponent(headers.get('x-elp-route') ?? 'null'));

function addKey(platform: string): void {
  const secret = encrypt(`${platform}-elp-test-key`);
  getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, 'elp', ?, ?, ?, 'healthy', 1)
  `).run(platform, secret.encrypted, secret.iv, secret.authTag);
}

/** One free model in the plain auto chain, so fallbacks have somewhere to go. */
function addFreeModel(): void {
  const db = getDb();
  const id = Number(db.prepare(`
    INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
                        monthly_token_budget, context_window, enabled, supports_vision, supports_tools)
    VALUES ('groq', 'free-model', 'Free Model', 5, 1, 'Small', '~1M', 128000, 1, 0, 1)
  `).run().lastInsertRowid);
  db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 1, 1)').run(id);
  // The active profile (if any) is what plain `auto` actually walks.
  const profile = db.prepare("SELECT value FROM settings WHERE key = 'active_profile_id'").get() as { value: string } | undefined;
  if (profile) {
    db.prepare('INSERT INTO profile_models (profile_id, model_db_id, priority, enabled) VALUES (?, ?, 1, 1)').run(Number(profile.value), id);
  }
}

interface Upstream { url: string; body: any }

/** Route each upstream by host; record every call. */
function mockUpstreams(handlers: Partial<Record<'anthropic' | 'openai' | 'perplexity' | 'groq' | 'openai-image', (call: Upstream) => Response>>) {
  const calls: Upstream[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith('http://127.0.0.1')) return realFetch(input as any, init);
    let body: any;
    try { body = init?.body && typeof init.body === 'string' ? JSON.parse(init.body) : undefined; } catch { body = undefined; }
    const call = { url, body };
    calls.push(call);
    const key = url.includes('api.anthropic.com') ? 'anthropic'
      : url.includes('api.openai.com/v1/images') ? 'openai-image'
        : url.includes('api.openai.com') ? 'openai'
          : url.includes('api.perplexity.ai') ? 'perplexity'
            : url.includes('api.groq.com') ? 'groq' : null;
    const handler = key ? handlers[key] : undefined;
    if (!handler) return new Response(JSON.stringify({ error: { message: `unexpected upstream ${url}` } }), { status: 599 });
    return handler(call);
  });
  return calls;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const claudeMessage = (text: string) => json({
  id: 'msg_elp', type: 'message', role: 'assistant', model: 'claude-opus-5-5',
  content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 5 },
});

const openaiCompletion = (text: string) => json({
  id: 'chatcmpl-oa', object: 'chat.completion', created: 1, model: 'gpt-6.1-sol',
  choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
});

const groqCompletion = () => json({
  id: 'chatcmpl-free', object: 'chat.completion', created: 1, model: 'free-model',
  choices: [{ index: 0, message: { role: 'assistant', content: 'free answer' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
});

const perplexityResponse = {
  id: 'resp_elp', model: 'openai/gpt-6-luna', object: 'response', status: 'completed',
  output: [
    { type: 'search_results', results: [{ id: 1, title: 'Source', url: 'https://news.example.com/a' }] },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Fresh answer[1].' }] },
  ],
  usage: { input_tokens: 50, output_tokens: 10, total_tokens: 60 },
};

beforeEach(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  delete process.env.ELPGPT_ROUTES;
  initDb(':memory:');
  app = createApp();
  dashToken = mintDashboardToken();
  setRoutingStrategy('priority');
  clearAllCooldowns();
  const db = getDb();
  db.prepare('DELETE FROM api_keys').run();
  db.prepare('DELETE FROM profile_models').run();
  db.prepare('DELETE FROM fallback_config').run();
  db.prepare('DELETE FROM models').run();
  db.prepare('DELETE FROM media_models').run();
  addKey('groq');
  addFreeModel();
  ensureElpCatalog(db);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ensureElpCatalog', () => {
  it('seeds premium rows that survive catalog sync and stay out of plain auto', () => {
    const rows = getDb().prepare(`
      SELECT m.platform, m.model_id, m.source, f.enabled AS chain_enabled
      FROM models m JOIN fallback_config f ON f.model_db_id = m.id
      WHERE m.platform IN ('anthropic', 'openai', 'perplexity') ORDER BY m.platform, m.model_id
    `).all();
    // Default routes plus the cost-efficient subscriber routes, all kept out of plain auto.
    expect(rows).toEqual([
      { platform: 'anthropic', model_id: 'claude-haiku-5-5', source: 'user', chain_enabled: 0 },
      { platform: 'anthropic', model_id: 'claude-opus-5-5', source: 'user', chain_enabled: 0 },
      { platform: 'anthropic', model_id: 'claude-sonnet-5-5', source: 'user', chain_enabled: 0 },
      { platform: 'openai', model_id: 'gpt-6-luna', source: 'user', chain_enabled: 0 },
      { platform: 'openai', model_id: 'gpt-6.1-sol', source: 'user', chain_enabled: 0 },
      { platform: 'openai', model_id: 'gpt-6.1-terra', source: 'user', chain_enabled: 0 },
      { platform: 'perplexity', model_id: 'fast', source: 'user', chain_enabled: 0 },
    ]);
    const media = getDb().prepare("SELECT model_id, modality FROM media_models WHERE platform = 'openai' ORDER BY model_id").all();
    expect(media).toEqual([
      { model_id: 'gpt-image-2.6-flare', modality: 'image' },
      { model_id: 'gpt-image-2.6-sunburst', modality: 'image' },
      { model_id: 'gpt-transcribe', modality: 'transcription' },
    ]);
  });

  it('is idempotent and never overwrites operator edits', () => {
    const db = getDb();
    db.prepare("UPDATE fallback_config SET enabled = 1 WHERE model_db_id = (SELECT id FROM models WHERE model_id = 'claude-opus-5-5')").run();
    const before = (db.prepare('SELECT COUNT(*) AS n FROM models').get() as { n: number }).n;
    ensureElpCatalog(db);
    ensureElpCatalog(db);
    expect((db.prepare('SELECT COUNT(*) AS n FROM models').get() as { n: number }).n).toBe(before);
    expect(db.prepare("SELECT f.enabled FROM fallback_config f JOIN models m ON m.id = f.model_db_id WHERE m.model_id = 'claude-opus-5-5'").get()).toEqual({ enabled: 1 });
  });

  it('plain auto never spends on premium models, even after the profile backfill', async () => {
    addKey('anthropic');
    addKey('openai');
    // Catalog sync runs this; it copies the disabled fallback flag into profiles.
    ensureAllModelsInProfiles(getDb());
    const leaked = getDb().prepare(`
      SELECT COUNT(*) AS n FROM profile_models pm JOIN models m ON m.id = pm.model_db_id
      WHERE m.platform IN ('anthropic', 'openai', 'perplexity') AND pm.enabled = 1
    `).get() as { n: number };
    expect(leaked.n).toBe(0);
    const calls = mockUpstreams({ groq: () => groqCompletion() });
    const res = await request('POST', '/v1/chat/completions', { model: 'auto', messages: [{ role: 'user', content: 'fix this bug in my python code' }] }, inference());
    expect(res.status).toBe(200);
    expect(calls.map(c => new URL(c.url).host)).toEqual(['api.groq.com']);
  });
});

describe('elpgpt-auto routing', () => {
  it('sends code to Claude Opus 5.5 at high effort and reports the decision', async () => {
    addKey('anthropic');
    addKey('openai');
    const calls = mockUpstreams({ anthropic: () => claudeMessage('fixed') });
    const res = await request('POST', '/v1/chat/completions', {
      model: 'elpgpt-auto',
      messages: [{ role: 'user', content: 'Fix this bug: TypeError: Cannot read properties of undefined' }],
    }, inference());
    expect(res.status).toBe(200);
    expect(res.body.choices[0].message.content).toBe('fixed');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.anthropic.com/v1/messages');
    expect(calls[0].body.output_config).toEqual({ effort: 'high' });
    expect(routeHeader(res.headers)).toMatchObject({ intent: 'code', platform: 'anthropic', model: 'claude-opus-5-5', label: 'Claude Opus 5.5', kind: 'chat', fallback: false });
    expect(res.headers.get('x-routed-via')).toBe('anthropic/claude-opus-5-5');
  });

  it('fails over strictly to GPT-6.1 Sol when Claude errors, never to the free pool', async () => {
    addKey('anthropic');
    addKey('openai');
    const calls = mockUpstreams({
      anthropic: () => json({ type: 'error', error: { type: 'overloaded_error', message: 'overloaded' } }, 529),
      openai: () => openaiCompletion('from gpt'),
    });
    const res = await request('POST', '/v1/chat/completions', {
      model: 'elpgpt-auto',
      temperature: 0.3,
      max_tokens: 300,
      messages: [{ role: 'user', content: 'write a SQL query that returns the top 10 customers' }],
    }, inference());
    expect(res.status).toBe(200);
    expect(res.body.choices[0].message.content).toBe('from gpt');
    const hosts = calls.map(c => new URL(c.url).host);
    expect(hosts).not.toContain('api.groq.com');
    const oa = calls.find(c => c.url.includes('api.openai.com'))!;
    expect(oa.body).toMatchObject({ model: 'gpt-6.1-sol', max_completion_tokens: 300, reasoning_effort: 'high' });
    expect(oa.body).not.toHaveProperty('max_tokens');
    expect(oa.body.temperature).toBeUndefined();
  });

  it('sends general chat to GPT-6.1 Sol first', async () => {
    addKey('anthropic');
    addKey('openai');
    const calls = mockUpstreams({ openai: () => openaiCompletion('hi!') });
    const res = await request('POST', '/v1/chat/completions', { model: 'elpgpt-auto', messages: [{ role: 'user', content: 'hola, ¿cómo estás?' }] }, inference());
    expect(res.status).toBe(200);
    expect(calls[0].url).toBe('https://api.openai.com/v1/chat/completions');
    expect(routeHeader(res.headers)).toMatchObject({ intent: 'chat', platform: 'openai', model: 'gpt-6.1-sol' });
  });

  it('sends search to Perplexity and returns citations', async () => {
    addKey('perplexity');
    const calls = mockUpstreams({ perplexity: () => json(perplexityResponse) });
    const res = await request('POST', '/v1/chat/completions', { model: 'elpgpt-auto', messages: [{ role: 'user', content: 'search the latest news about the Fed today' }] }, inference());
    expect(res.status).toBe(200);
    expect(calls[0]).toMatchObject({ url: 'https://api.perplexity.ai/v1/agent', body: { effort: 'fast' } });
    expect(res.body.choices[0].message.content).toBe('Fresh answer[1].');
    expect(res.body.citations).toEqual([{ index: 1, url: 'https://news.example.com/a', title: 'Source' }]);
    expect(routeHeader(res.headers)).toMatchObject({ intent: 'web_search', platform: 'perplexity', label: 'Perplexity Search' });
  });

  it('keeps Perplexity citations through the proxy stream framing', async () => {
    addKey('perplexity');
    const events = [
      { type: 'response.created', response: { id: 'resp_s', model: 'openai/gpt-6-luna' } },
      { type: 'response.output_text.delta', delta: 'Fresh ' },
      { type: 'response.output_text.delta', delta: 'answer[1].' },
      { type: 'response.completed', response: perplexityResponse },
    ];
    mockUpstreams({
      perplexity: () => new Response(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
    });
    const res = await request('POST', '/v1/chat/completions', { model: 'elpgpt-auto', stream: true, messages: [{ role: 'user', content: 'busca las noticias de hoy' }] }, inference());
    expect(res.status).toBe(200);
    const frames = res.text.split('\n\n').filter(l => l.startsWith('data: {')).map(l => JSON.parse(l.slice(6)));
    const text = frames.map(f => f.choices?.[0]?.delta?.content ?? '').join('');
    expect(text).toBe('Fresh answer[1].');
    expect(frames.some(f => f.citations?.[0]?.url === 'https://news.example.com/a')).toBe(true);
  });

  it('generates images through the image pipeline and answers with a markdown image', async () => {
    addKey('openai');
    const calls = mockUpstreams({ 'openai-image': () => json({ data: [{ b64_json: 'iVBORw0KGgo=' }] }) });
    const res = await request('POST', '/v1/chat/completions', { model: 'elpgpt-auto', messages: [{ role: 'user', content: 'crea una imagen de un perro con sombrero' }] }, inference());
    expect(res.status).toBe(200);
    expect(calls[0]).toMatchObject({ url: 'https://api.openai.com/v1/images/generations', body: { model: 'gpt-image-2.6-flare', prompt: 'crea una imagen de un perro con sombrero', n: 1 } });
    expect(res.body.choices[0].message.content).toMatch(/^!\[crea una imagen de un perro con sombrero\]\(data:image\/png;base64,iVBORw0KGgo=\)$/);
    expect(res.body.elp_route).toMatchObject({ intent: 'image_generation', kind: 'image', platform: 'openai', model: 'gpt-image-2.6-flare' });
  });

  it('streams an image answer as SSE', async () => {
    addKey('openai');
    mockUpstreams({ 'openai-image': () => json({ data: [{ b64_json: 'AAAA' }] }) });
    const res = await request('POST', '/v1/chat/completions', { model: 'elpgpt-auto', stream: true, messages: [{ role: 'user', content: '/image a red fox' }] }, inference());
    expect(res.status).toBe(200);
    expect(res.text).toContain('![a red fox](data:image/png;base64,AAAA)');
    expect(res.text.trim().endsWith('data: [DONE]')).toBe(true);
  });

  it('falls back to the free pool when no premium key is configured', async () => {
    const calls = mockUpstreams({ groq: () => groqCompletion() });
    const res = await request('POST', '/v1/chat/completions', { model: 'elpgpt-auto', messages: [{ role: 'user', content: 'write a poem about the sea' }] }, inference());
    expect(res.status).toBe(200);
    expect(res.body.choices[0].message.content).toBe('free answer');
    expect(calls.map(c => new URL(c.url).host)).toEqual(['api.groq.com']);
    expect(routeHeader(res.headers)).toMatchObject({ intent: 'writing', fallback: true, model: 'auto' });
  });

  it('is listed on /v1/models', async () => {
    const res = await request('GET', '/v1/models', undefined, inference());
    expect(res.body.data.map((m: any) => m.id)).toContain('elpgpt-auto');
  });
});

describe('/api/elp', () => {
  it('previews the route for typed text without calling any model', async () => {
    addKey('perplexity');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const res = await request('POST', '/api/elp/route', { text: 'what is the latest price of bitcoin' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ intent: 'web_search', platform: 'perplexity', label: 'Perplexity Search', fallback: false });
    expect(fetchSpy.mock.calls.filter(([u]) => !String(u).startsWith('http://127.0.0.1'))).toHaveLength(0);
  });

  it('reports translation target language', async () => {
    const res = await request('POST', '/api/elp/route', { text: 'traduce esto al inglés: buenos días' });
    expect(res.body).toMatchObject({ intent: 'translation', targetLanguage: 'en', fallback: true });
  });

  it('lists premium providers and per-intent routes', async () => {
    addKey('anthropic');
    const res = await request('GET', '/api/elp/status');
    expect(res.status).toBe(200);
    expect(res.body.providers).toEqual([
      { platform: 'anthropic', connected: true },
      { platform: 'openai', connected: false },
      { platform: 'perplexity', connected: false },
    ]);
    const code = res.body.routes.find((r: any) => r.intent === 'code');
    expect(code.route).toMatchObject({ platform: 'anthropic', model: 'claude-opus-5-5' });
  });

  it('requires a dashboard session', async () => {
    const res = await request('POST', '/api/elp/route', { text: 'hi' }, { Authorization: 'Bearer nope' });
    expect(res.status).toBe(401);
  });
});

describe('route table config', () => {
  it('overrides intents from ELPGPT_ROUTES and ignores junk', () => {
    const table = loadRouteTable(JSON.stringify({
      chat: [{ platform: 'anthropic', model: 'claude-opus-5-5', effort: 'low' }],
      bogus: [{ platform: 'x', model: 'y' }],
      code: [{ platform: 'openai' }],
    }));
    expect(table.chat).toEqual([{ platform: 'anthropic', model: 'claude-opus-5-5', effort: 'low' }]);
    expect(table.code).toEqual([]);
    expect(table.web_search).toEqual(DEFAULT_ROUTES.web_search);
    expect(loadRouteTable('{not json')).toEqual(DEFAULT_ROUTES);
  });
});

describe('prompt helpers', () => {
  it('numbers search results for inline citations', () => {
    const prompt = searchGroundingPrompt('fed rates', [{ title: 'A', url: 'https://a.example', content: 'alpha  text' }]);
    expect(prompt).toContain('[1] A\nhttps://a.example\nalpha text');
    expect(prompt).toMatch(/Cite sources inline/);
  });

  it('carries the previous image prompt into a follow-up', () => {
    const messages = [
      { role: 'user' as const, content: 'draw a castle on a hill' },
      { role: 'assistant' as const, content: '![castle](data:...)' },
      { role: 'user' as const, content: 'make it darker' },
    ];
    const intent = classifyIntent('make it darker', { previousIntent: 'image_generation' });
    expect(buildImagePrompt(messages, intent)).toBe('draw a castle on a hill. Change: make it darker');
  });
});
