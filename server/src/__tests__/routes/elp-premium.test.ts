import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { setRoutingStrategy } from '../../services/router.js';
import { clearAllCooldowns } from '../../services/ratelimit.js';
import { ensureElpCatalog } from '../../services/elp-router.js';
import { resetPublicThrottle, trimContext } from '../../routes/public.js';
import { premiumCostMicros, recordPremiumSpend } from '../../services/premium-usage.js';
import { mintDashboardToken } from '../helpers/auth.js';

// Subscribers' premium allowance, end to end through the real gateway with
// the providers mocked at the fetch layer.

let app: Express;
let dashToken = '';
const realFetch = globalThis.fetch;
const ANSWER = 'v=0\r\no=- 3 4 IN IP4 0.0.0.0\r\ns=-\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';
const OFFER = 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const { port } = server.address() as { port: number };
  const res = await realFetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  server.close();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body: json, headers: res.headers };
}

const routeOf = (h: Headers) => JSON.parse(decodeURIComponent(h.get('x-elp-route') ?? 'null'));
const member = (token: string) => ({ 'x-member-token': token });

function addKey(platform: string): void {
  const s = encrypt(`${platform}-premium-test-key`);
  getDb().prepare(`INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, 'k', ?, ?, ?, 'healthy', 1)`).run(platform, s.encrypted, s.iv, s.authTag);
}

function addFreeModel(): void {
  const db = getDb();
  const id = Number(db.prepare(`INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
    monthly_token_budget, context_window, enabled, supports_vision, supports_tools)
    VALUES ('groq', 'free-model', 'Free Model', 5, 1, 'Small', '~1M', 128000, 1, 0, 1)`).run().lastInsertRowid);
  db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 1, 1)').run(id);
  const profile = db.prepare("SELECT value FROM settings WHERE key = 'active_profile_id'").get() as { value: string } | undefined;
  if (profile) db.prepare('INSERT INTO profile_models (profile_id, model_db_id, priority, enabled) VALUES (?, ?, 1, 1)').run(Number(profile.value), id);
}

interface Upstream { host: string; path: string; body: any }

function mockUpstreams(): Upstream[] {
  const calls: Upstream[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith('http://127.0.0.1')) return realFetch(input as any, init);
    let body: any;
    try { body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined; } catch { body = undefined; }
    const u = new URL(url);
    calls.push({ host: u.host, path: u.pathname, body });
    const json = (payload: unknown) => new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (u.host === 'api.groq.com') {
      return json({ id: 'c', object: 'chat.completion', created: 1, model: 'free-model',
        choices: [{ index: 0, message: { role: 'assistant', content: 'free answer' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
    }
    if (u.host === 'api.anthropic.com') {
      return json({ id: 'msg', type: 'message', role: 'assistant', model: body?.model ?? 'claude',
        content: [{ type: 'text', text: 'premium answer' }], stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 2000, output_tokens: 1000 } });
    }
    if (u.host === 'api.openai.com' && u.pathname.endsWith('/client_secrets')) return json({ value: 'ek_test', expires_at: 1_900_000_000 });
    if (u.host === 'api.openai.com' && u.pathname.endsWith('/calls')) return new Response(ANSWER, { status: 201, headers: { 'Content-Type': 'application/sdp' } });
    return new Response(JSON.stringify({ error: { message: `unexpected ${u.host}${u.pathname}` } }), { status: 599 });
  });
  return calls;
}

const CODE_PROMPT = { messages: [{ role: 'user', content: 'fix this bug: TypeError in my React component' }], stream: false };
const CHAT_PROMPT = { messages: [{ role: 'user', content: 'hello, nice to meet you' }], stream: false };

async function subscriber(email = 'sub@example.com') {
  const res = await call('POST', '/api/public/signup', { email, password: 'correct-horse-1' });
  const id = (getDb().prepare('SELECT id FROM elp_members WHERE email = ?').get(email) as { id: number }).id;
  getDb().prepare("UPDATE elp_members SET plan = 'subscriber' WHERE id = ?").run(id);
  return { token: res.body.token as string, subject: `m:${id}` };
}

function spentMicros(subject: string): number {
  return (getDb().prepare('SELECT COALESCE(SUM(premium_micros), 0) AS n FROM elp_usage WHERE subject = ?').get(subject) as { n: number }).n;
}

beforeEach(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  for (const k of ['ELPGPT_ROUTES', 'ELPGPT_SUBSCRIBER_ROUTES', 'ELPGPT_PREMIUM_DAILY_USD', 'ELPGPT_PREMIUM_MONTHLY_USD', 'ELPGPT_PUBLIC_CONTEXT_CHARS']) delete process.env[k];
  process.env.ELPGPT_PUBLIC_CHAT = '1';
  initDb(':memory:');
  app = createApp();
  dashToken = mintDashboardToken();
  setRoutingStrategy('priority');
  clearAllCooldowns();
  resetPublicThrottle();
  const db = getDb();
  for (const t of ['api_keys', 'profile_models', 'fallback_config', 'models', 'media_models']) db.prepare(`DELETE FROM ${t}`).run();
  addKey('groq');
  addKey('anthropic');
  addKey('openai');
  addFreeModel();
  ensureElpCatalog(db);
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.ELPGPT_PUBLIC_CHAT;
});

describe('subscriber routes and metering', () => {
  it('routes subscribers to the cost-efficient models and meters real token use', async () => {
    const calls = mockUpstreams();
    const { token, subject } = await subscriber();

    const code = await call('POST', '/api/public/chat', CODE_PROMPT, member(token));
    expect(code.status).toBe(200);
    expect(routeOf(code.headers)).toMatchObject({ intent: 'code', platform: 'anthropic', model: 'claude-sonnet-5-5', fallback: false });
    expect(calls.find(c => c.host === 'api.anthropic.com')?.body.model).toBe('claude-sonnet-5-5');

    const row = getDb().prepare("SELECT platform, model_id, input_tokens, output_tokens FROM requests WHERE status = 'success' ORDER BY id DESC LIMIT 1")
      .get() as { platform: string; model_id: string; input_tokens: number; output_tokens: number };
    const expected = premiumCostMicros(row.platform, row.model_id, row.input_tokens, row.output_tokens);
    expect(expected).toBeGreaterThan(0);
    expect(spentMicros(subject)).toBe(expected);

    const chat = await call('POST', '/api/public/chat', CHAT_PROMPT, member(token));
    expect(routeOf(chat.headers)).toMatchObject({ intent: 'chat', model: 'claude-haiku-5-5' });

    const status = await call('GET', '/api/public/status', undefined, member(token));
    expect(status.body.features.premium).toBe(true);
    expect(status.body.allowance).toMatchObject({ exhausted: null, period: 'day' });
    expect(status.body.allowance.remaining).toBeLessThan(1);
    expect(JSON.stringify(status.body)).not.toMatch(/usd|micros/i); // no dollar amounts for subscribers
  });

  it('keeps chatting on free models once the allowance is used up, and pauses voice', async () => {
    const calls = mockUpstreams();
    const { token, subject } = await subscriber();
    recordPremiumSpend(subject, 1_000_000); // the default $1/day

    const status = await call('GET', '/api/public/status', undefined, member(token));
    expect(status.body.features).toMatchObject({ premium: false, voice: false, liveTranslate: false });
    expect(status.body.allowance).toMatchObject({ exhausted: 'day', remaining: 0 });

    const res = await call('POST', '/api/public/chat', CODE_PROMPT, member(token));
    expect(res.status).toBe(200);
    expect(res.body.choices[0].message.content).toBe('free answer');
    expect(routeOf(res.headers)).toMatchObject({ fallback: true });
    expect(calls.some(c => c.host === 'api.anthropic.com')).toBe(false);
    expect(spentMicros(subject)).toBe(1_000_000);

    const speech = await call('POST', '/api/public/speech', { input: 'hi' }, member(token));
    expect(speech.status).toBe(403);
    expect(speech.body.error).toMatchObject({ code: 'premium_allowance_used' });
    expect(speech.body.error.resetsAt).toMatch(/T00:00:00\.000Z$/);
  });

  it('never meters free members', async () => {
    mockUpstreams();
    const res = await call('POST', '/api/public/signup', { email: 'free@example.com', password: 'correct-horse-1' });
    await call('POST', '/api/public/chat', CODE_PROMPT, member(res.body.token));
    expect(getDb().prepare('SELECT COALESCE(SUM(premium_micros), 0) AS n FROM elp_usage').get()).toEqual({ n: 0 });
    expect((await call('GET', '/api/public/status', undefined, member(res.body.token))).body.allowance).toBeNull();
  });

  it('charges the live interpreter per 5-minute block and stops it when the allowance runs out', async () => {
    mockUpstreams();
    const { token, subject } = await subscriber();
    const start = await call('POST', '/api/public/realtime/translate', { sdp: OFFER, targetLanguage: 'es' }, member(token));
    expect(start.status).toBe(200);
    expect(start.body).toMatchObject({ sdp: ANSWER, blockMinutes: 5 });
    expect(spentMicros(subject)).toBe(170_000);

    expect((await call('POST', '/api/public/realtime/extend', { sessions: 1 }, member(token))).status).toBe(200);
    expect(spentMicros(subject)).toBe(340_000);

    recordPremiumSpend(subject, 600_000); // 940K of 1M used: another block doesn't fit
    const denied = await call('POST', '/api/public/realtime/extend', { sessions: 1 }, member(token));
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('premium_allowance_used');
    expect(spentMicros(subject)).toBe(940_000);
  });

  it('shows the operator each subscriber\'s spend in dollars', async () => {
    const { subject } = await subscriber();
    recordPremiumSpend(subject, 250_000);
    const res = await call('GET', '/api/elp/members', undefined, { Authorization: `Bearer ${dashToken}` });
    expect(res.body.allowance).toEqual({ dailyUsd: 1, monthlyUsd: 4 });
    expect(res.body.members[0].premiumSpend).toEqual({ todayUsd: 0.25, monthUsd: 0.25, exhausted: null });
  });
});

describe('trimContext', () => {
  const msg = (role: 'user' | 'assistant' | 'system', n: number) => ({ role, content: 'x'.repeat(n) });

  it('keeps the newest turns that fit, plus system messages and the latest message', () => {
    const messages = [msg('system', 100), msg('user', 400), msg('assistant', 400), msg('user', 400), msg('assistant', 400), msg('user', 400)];
    const out = trimContext(messages, 1400);
    expect(out.map(m => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(out[0]).toBe(messages[0]);
    expect(out[out.length - 1]).toBe(messages[5]);
  });

  it('starts the kept history on a user turn and always keeps the latest message', () => {
    const out = trimContext([msg('user', 10), msg('assistant', 900), msg('user', 900)], 1000);
    expect(out.map(m => m.role)).toEqual(['user']);
    expect(trimContext([msg('user', 5000)], 1000)).toHaveLength(1);
  });

  it('counts an attached image as a fixed size, not its base64 length', () => {
    const image = { role: 'user' as const, content: [{ type: 'image_url' as const, image_url: { url: `data:image/png;base64,${'A'.repeat(200_000)}` } }, { type: 'text' as const, text: 'what is this?' }] };
    const out = trimContext([msg('user', 1000), msg('assistant', 1000), image], 7000);
    expect(out).toHaveLength(3);
  });
});
