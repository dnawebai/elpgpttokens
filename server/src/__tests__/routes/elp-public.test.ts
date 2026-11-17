import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { setRoutingStrategy } from '../../services/router.js';
import { clearAllCooldowns } from '../../services/ratelimit.js';
import { ensureElpCatalog } from '../../services/elp-router.js';
import { resetPublicThrottle } from '../../routes/public.js';
import { mintDashboardToken } from '../helpers/auth.js';

let app: Express;
let dashToken = '';
const realFetch = globalThis.fetch;

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
  try { json = JSON.parse(text); } catch { /* SSE */ }
  return { status: res.status, body: json, text, headers: res.headers };
}

const routeOf = (h: Headers) => JSON.parse(decodeURIComponent(h.get('x-elp-route') ?? 'null'));
const member = (token: string) => ({ 'x-member-token': token });
const admin = () => ({ Authorization: `Bearer ${dashToken}` });

function addKey(platform: string): void {
  const s = encrypt(`${platform}-public-test-key`);
  getDb().prepare(`INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, 'pub', ?, ?, ?, 'healthy', 1)`).run(platform, s.encrypted, s.iv, s.authTag);
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

interface Upstream { host: string; body: any }

function mockUpstreams(): Upstream[] {
  const calls: Upstream[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith('http://127.0.0.1')) return realFetch(input as any, init);
    let body: any;
    try { body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined; } catch { body = undefined; }
    const host = new URL(url).host;
    calls.push({ host, body });
    if (host === 'api.groq.com') {
      return new Response(JSON.stringify({
        id: 'c', object: 'chat.completion', created: 1, model: 'free-model',
        choices: [{ index: 0, message: { role: 'assistant', content: 'free answer' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (host === 'api.anthropic.com') {
      return new Response(JSON.stringify({
        id: 'msg', type: 'message', role: 'assistant', model: 'claude-opus-5-5',
        content: [{ type: 'text', text: 'premium answer' }], stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ error: { message: `unexpected ${host}` } }), { status: 599 });
  });
  return calls;
}

const CODE_PROMPT = { messages: [{ role: 'user', content: 'fix this bug: TypeError in my React component' }], stream: false };

async function signup(email = 'ana@example.com', password = 'correct-horse-1') {
  const res = await call('POST', '/api/public/signup', { email, password });
  return res.body.token as string;
}

function memberId(email: string): number {
  return (getDb().prepare('SELECT id FROM elp_members WHERE email = ?').get(email) as { id: number }).id;
}

beforeEach(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  for (const k of ['ELPGPT_PUBLIC_CHAT', 'ELPGPT_PUBLIC_SIGNUP', 'ELPGPT_VISITOR_DAILY_LIMIT', 'ELPGPT_FREE_DAILY_LIMIT', 'ELPGPT_SUBSCRIBER_DAILY_LIMIT', 'ELPGPT_ROUTES']) delete process.env[k];
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

afterEach(() => vi.restoreAllMocks());

describe('public chat is off by default', () => {
  it('reports disabled and refuses everything else', async () => {
    expect((await call('GET', '/api/public/status')).body).toEqual({ enabled: false });
    const chat = await call('POST', '/api/public/chat', CODE_PROMPT);
    expect(chat.status).toBe(404);
    expect(chat.body.error.code).toBe('public_chat_disabled');
    expect((await call('POST', '/api/public/signup', { email: 'a@b.co', password: 'longenough' })).status).toBe(404);
  });
});

describe('public chat (enabled)', () => {
  beforeEach(() => { process.env.ELPGPT_PUBLIC_CHAT = '1'; });

  it('serves visitors from the free pool even when premium keys exist', async () => {
    const calls = mockUpstreams();
    const res = await call('POST', '/api/public/chat', CODE_PROMPT);
    expect(res.status).toBe(200);
    expect(res.body.choices[0].message.content).toBe('free answer');
    expect(calls.map(c => c.host)).toEqual(['api.groq.com']);
    expect(routeOf(res.headers)).toMatchObject({ intent: 'code', fallback: true });
    expect(res.headers.get('x-elp-quota-remaining')).toBe('9');
    expect(res.text).not.toContain(getUnifiedApiKey());
  });

  it('strips client-chosen model and tools: the gateway only sees elpgpt-auto', async () => {
    const calls = mockUpstreams();
    const res = await call('POST', '/api/public/chat', {
      ...CODE_PROMPT,
      model: 'claude-opus-5-5',
      tools: [{ type: 'function', function: { name: 'x' } }],
      max_tokens: 999999,
    }, { 'x-goog-api-key': 'garbage', Authorization: 'Bearer garbage' });
    expect(res.status).toBe(200);
    expect(calls.map(c => c.host)).toEqual(['api.groq.com']);
    expect(calls[0].body).not.toHaveProperty('tools');
    expect(calls[0].body.max_tokens).not.toBe(999999);
  });

  it('enforces the visitor daily limit', async () => {
    process.env.ELPGPT_VISITOR_DAILY_LIMIT = '2';
    mockUpstreams();
    expect((await call('POST', '/api/public/chat', CODE_PROMPT)).status).toBe(200);
    expect((await call('POST', '/api/public/chat', CODE_PROMPT)).status).toBe(200);
    const third = await call('POST', '/api/public/chat', CODE_PROMPT);
    expect(third.status).toBe(429);
    expect(third.body.error).toMatchObject({ code: 'daily_limit_reached', limit: 2, tier: 'visitor' });
  });

  it('can require sign-in for visitors', async () => {
    process.env.ELPGPT_VISITOR_DAILY_LIMIT = '0';
    const res = await call('POST', '/api/public/chat', CODE_PROMPT);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('sign_in_required');
  });

  it('rejects malformed or oversized chats before spending quota', async () => {
    const res = await call('POST', '/api/public/chat', { messages: [{ role: 'tool', content: 'x' }] });
    expect(res.status).toBe(400);
    const status = await call('GET', '/api/public/status');
    expect(status.body.quota).toMatchObject({ used: 0 });
  });

  it('signs members up and in, and keeps free members on free models', async () => {
    const calls = mockUpstreams();
    const token = await signup();
    expect(token).toMatch(/^elpm_/);
    const status = await call('GET', '/api/public/status', undefined, member(token));
    expect(status.body).toMatchObject({ enabled: true, tier: 'free', member: { email: 'ana@example.com', plan: 'free' }, quota: { limit: 30 }, features: { premium: false, liveTranslate: false } });

    expect((await call('POST', '/api/public/login', { email: 'ana@example.com', password: 'wrong-password' })).status).toBe(401);
    const login = await call('POST', '/api/public/login', { email: ' ANA@example.com ', password: 'correct-horse-1' });
    expect(login.status).toBe(200);

    const chat = await call('POST', '/api/public/chat', CODE_PROMPT, member(login.body.token));
    expect(chat.status).toBe(200);
    expect(calls.map(c => c.host)).toEqual(['api.groq.com']);
    expect((await call('POST', '/api/public/signup', { email: 'ana@example.com', password: 'another-pass' })).body.error.code).toBe('email_taken');
  });

  it('routes subscribers to premium models once the operator grants the plan', async () => {
    const calls = mockUpstreams();
    const token = await signup();
    const grant = await call('PATCH', `/api/elp/members/${memberId('ana@example.com')}`, { plan: 'subscriber' }, admin());
    expect(grant.status).toBe(200);
    const res = await call('POST', '/api/public/chat', CODE_PROMPT, member(token));
    expect(res.status).toBe(200);
    expect(res.body.choices[0].message.content).toBe('premium answer');
    expect(calls.map(c => c.host)).toEqual(['api.anthropic.com']);
    expect(routeOf(res.headers)).toMatchObject({ platform: 'anthropic', fallback: false });

    const preview = await call('POST', '/api/public/route', { text: 'fix this bug in my code' }, member(token));
    expect(preview.body).toMatchObject({ platform: 'anthropic', fallback: false });
    const visitorPreview = await call('POST', '/api/public/route', { text: 'fix this bug in my code' });
    expect(visitorPreview.body).toMatchObject({ fallback: true });
  });

  it('keeps voice and the live interpreter for subscribers', async () => {
    const token = await signup();
    for (const path of ['/api/public/speech', '/api/public/realtime/translate']) {
      expect((await call('POST', path, { input: 'hi', sdp: 'v=0', targetLanguage: 'es' })).body.error.code).toBe('subscription_required');
      expect((await call('POST', path, { input: 'hi', sdp: 'v=0', targetLanguage: 'es' }, member(token))).body.error.code).toBe('subscription_required');
    }
  });

  it('locks out disabled members', async () => {
    const token = await signup();
    await call('PATCH', `/api/elp/members/${memberId('ana@example.com')}`, { disabled: true }, admin());
    const status = await call('GET', '/api/public/status', undefined, member(token));
    expect(status.body.tier).toBe('visitor');
    const login = await call('POST', '/api/public/login', { email: 'ana@example.com', password: 'correct-horse-1' });
    expect(login.status).toBe(403);
    expect(login.body.error.code).toBe('account_disabled');
  });

  it('throttles repeated sign-in attempts per IP', async () => {
    let last = 0;
    for (let i = 0; i < 11; i++) last = (await call('POST', '/api/public/login', { email: 'x@example.com', password: 'nope-nope' })).status;
    expect(last).toBe(429);
  });

  it('honours a closed signup switch', async () => {
    process.env.ELPGPT_PUBLIC_SIGNUP = '0';
    const res = await call('POST', '/api/public/signup', { email: 'z@example.com', password: 'longenough1' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('signup_disabled');
  });

  it('lists members with today\'s usage for the operator only', async () => {
    mockUpstreams();
    const token = await signup();
    await call('POST', '/api/public/chat', CODE_PROMPT, member(token));
    expect((await call('GET', '/api/elp/members')).status).toBe(401);
    const res = await call('GET', '/api/elp/members', undefined, admin());
    expect(res.body).toMatchObject({ publicChatEnabled: true, limits: { visitor: 10, free: 30, subscriber: 300 } });
    expect(res.body.members).toEqual([expect.objectContaining({ email: 'ana@example.com', plan: 'free', disabled: false, today: { limit: 30, used: 1, remaining: 29 } })]);
    expect(JSON.stringify(res.body)).not.toContain('password');
  });

  it('never lets a member token open the dashboard API', async () => {
    const token = await signup();
    expect((await call('GET', '/api/keys', undefined, { Authorization: `Bearer ${token}` })).status).toBe(401);
    expect((await call('GET', '/api/keys', undefined, member(token))).status).toBe(401);
  });
});
