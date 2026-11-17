import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { clientSecretBody, isValidLanguageCode, safetyIdentifier } from '../../services/live-translate.js';
import { mintDashboardToken } from '../helpers/auth.js';

let app: Express;
let dashToken = '';
const realFetch = globalThis.fetch;

const OFFER = 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';
const ANSWER = 'v=0\r\no=- 3 4 IN IP4 0.0.0.0\r\ns=-\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';

async function post(path: string, body: unknown, token = dashToken) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const { port } = server.address() as { port: number };
  const res = await realFetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  server.close();
  return { status: res.status, body: JSON.parse(text), text };
}

function addOpenAIKey(secret: string): void {
  const e = encrypt(secret);
  getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES ('openai', 'live', ?, ?, ?, 'healthy', 1)
  `).run(e.encrypted, e.iv, e.authTag);
}

interface Call { url: string; headers: Headers; body: string }

function mockOpenAI(handle: (call: Call) => Response): Call[] {
  const calls: Call[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith('http://127.0.0.1')) return realFetch(input as any, init);
    const call = { url, headers: new Headers(init?.headers), body: String(init?.body ?? '') };
    calls.push(call);
    return handle(call);
  });
  return calls;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  delete process.env.ELPGPT_LIVE_TRANSLATE_MODEL;
  initDb(':memory:');
  app = createApp();
  dashToken = mintDashboardToken();
  getDb().prepare('DELETE FROM api_keys').run();
});

afterEach(() => vi.restoreAllMocks());

describe('POST /api/elp/realtime/translate', () => {
  it('mints a translation session server-side and returns only the SDP answer', async () => {
    addOpenAIKey('sk-real-openai-key');
    const calls = mockOpenAI(({ url }) => url.endsWith('/client_secrets')
      ? json({ value: 'ek_ephemeral_secret', expires_at: 1_900_000_000 })
      : new Response(ANSWER, { status: 201, headers: { 'Content-Type': 'application/sdp' } }));

    const res = await post('/api/elp/realtime/translate', { sdp: OFFER, targetLanguage: 'es', source: 'mic' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sdp: ANSWER, model: 'gpt-realtime-translate', language: 'es', expiresAt: 1_900_000_000 });
    // Neither the real key nor the ephemeral secret reaches the browser.
    expect(res.text).not.toContain('sk-real-openai-key');
    expect(res.text).not.toContain('ek_ephemeral_secret');

    expect(calls.map(c => c.url)).toEqual([
      'https://api.openai.com/v1/realtime/translations/client_secrets',
      'https://api.openai.com/v1/realtime/translations/calls',
    ]);
    expect(calls[0].headers.get('authorization')).toBe('Bearer sk-real-openai-key');
    expect(calls[0].headers.get('openai-safety-identifier')).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.parse(calls[0].body)).toEqual({
      session: {
        model: 'gpt-realtime-translate',
        audio: {
          input: { transcription: { model: 'gpt-realtime-whisper' }, noise_reduction: { type: 'near_field' } },
          output: { language: 'es' },
        },
      },
    });
    expect(calls[1].headers.get('authorization')).toBe('Bearer ek_ephemeral_secret');
    expect(calls[1].headers.get('content-type')).toBe('application/sdp');
    expect(calls[1].body).toBe(OFFER);
  });

  it('accepts the cookbook client_secret response shape too', async () => {
    addOpenAIKey('sk-a');
    const calls = mockOpenAI(({ url }) => url.endsWith('/client_secrets')
      ? json({ client_secret: 'ek_cookbook_shape' })
      : new Response(ANSWER, { status: 200 }));
    const res = await post('/api/elp/realtime/translate', { sdp: OFFER, targetLanguage: 'pt-BR', source: 'tab' });
    expect(res.status).toBe(200);
    expect(calls[1].headers.get('authorization')).toBe('Bearer ek_cookbook_shape');
    // Tab audio skips near-field noise reduction.
    expect(JSON.parse(calls[0].body).session.audio.input).toEqual({ transcription: { model: 'gpt-realtime-whisper' } });
  });

  it('rotates past a rejected key', async () => {
    addOpenAIKey('sk-revoked');
    addOpenAIKey('sk-good');
    const calls = mockOpenAI(({ url, headers }) => {
      if (url.endsWith('/client_secrets')) {
        return headers.get('authorization') === 'Bearer sk-good'
          ? json({ value: 'ek_ok' })
          : json({ error: { message: 'Incorrect API key' } }, 401);
      }
      return new Response(ANSWER, { status: 200 });
    });
    const res = await post('/api/elp/realtime/translate', { sdp: OFFER, targetLanguage: 'fr' });
    expect(res.status).toBe(200);
    expect(calls.filter(c => c.url.endsWith('/calls'))).toHaveLength(1);
  });

  it('answers 503 with a clear code when no OpenAI key is configured', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const res = await post('/api/elp/realtime/translate', { sdp: OFFER, targetLanguage: 'es' });
    expect(res.status).toBe(503);
    expect(res.body.error).toMatchObject({ code: 'no_openai_key' });
    expect(fetchSpy.mock.calls.filter(([u]) => !String(u).startsWith('http://127.0.0.1'))).toHaveLength(0);
  });

  it('validates the offer and language before calling OpenAI', async () => {
    addOpenAIKey('sk-a');
    const calls = mockOpenAI(() => json({}));
    expect((await post('/api/elp/realtime/translate', { sdp: 'not sdp', targetLanguage: 'es' })).body.error.code).toBe('invalid_sdp');
    expect((await post('/api/elp/realtime/translate', { sdp: OFFER, targetLanguage: 'Spanish!' })).body.error.code).toBe('invalid_language');
    expect(calls).toHaveLength(0);
  });

  it('relays an upstream refusal of the audio connection', async () => {
    addOpenAIKey('sk-a');
    mockOpenAI(({ url }) => url.endsWith('/client_secrets')
      ? json({ value: 'ek' })
      : json({ error: { message: 'invalid offer' } }, 400));
    const res = await post('/api/elp/realtime/translate', { sdp: OFFER, targetLanguage: 'es' });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('invalid offer');
  });

  it('requires a dashboard session', async () => {
    const res = await post('/api/elp/realtime/translate', { sdp: OFFER, targetLanguage: 'es' }, 'nope');
    expect(res.status).toBe(401);
  });
});

describe('live translate helpers', () => {
  it('validates language codes', () => {
    for (const c of ['es', 'en', 'pt-BR', 'zh-Hant', 'fil']) expect(isValidLanguageCode(c)).toBe(true);
    for (const c of ['', 'ES', 'spanish', 'es_ES', 'e', 42]) expect(isValidLanguageCode(c)).toBe(false);
  });

  it('honours a model override and hashes the user id', () => {
    process.env.ELPGPT_LIVE_TRANSLATE_MODEL = 'gpt-realtime-translate-2';
    expect(clientSecretBody('ja', 'mic').session.model).toBe('gpt-realtime-translate-2');
    expect(safetyIdentifier('1')).toBe(safetyIdentifier('1'));
    expect(safetyIdentifier('1')).not.toBe(safetyIdentifier('2'));
  });
});
