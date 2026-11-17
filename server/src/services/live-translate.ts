/**
 * Live speech-to-speech translation (ELPGPT /chat "Live interpreter").
 *
 * The browser streams microphone or tab audio to OpenAI's realtime
 * translation model over WebRTC and plays the translated speech it gets back,
 * with live transcripts on the `oai-events` data channel. This service does
 * the one step the browser can't: the SDP handshake. The dashboard's CSP
 * allows `connect-src 'self'` only, and the operator's OpenAI key must never
 * reach a browser, so the server
 *
 *   1. reserves an OpenAI key from the pool (same budget accounting as media),
 *   2. mints a short-lived translation client secret with the target language,
 *   3. posts the browser's SDP offer to the translation calls endpoint with
 *      that secret, and
 *   4. returns only the SDP answer.
 *
 * Media then flows directly between the browser and OpenAI; no audio passes
 * through this server. Docs: developers.openai.com/api/docs/guides/realtime-translation
 */
import crypto from 'node:crypto';
import { proxyFetch } from '../lib/proxy.js';
import { reserveProviderCredential } from './provider-credential.js';

const TRANSLATIONS_URL = 'https://api.openai.com/v1/realtime/translations';
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_SDP_BYTES = 64 * 1024;
/** Keys tried per request before giving up (each 401/403 rotates). */
const MAX_KEY_ATTEMPTS = 3;

export function liveTranslateModel(): string {
  return process.env.ELPGPT_LIVE_TRANSLATE_MODEL?.trim() || 'gpt-realtime-translate';
}

export type LiveSource = 'mic' | 'tab';

export class LiveTranslateError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
  }
}

/** ISO 639 code with an optional region or script subtag: es, pt-BR, zh-Hant. */
export function isValidLanguageCode(code: unknown): code is string {
  return typeof code === 'string' && /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/.test(code);
}

/** OpenAI asks for a stable, non-identifying end-user id on realtime sessions. */
export function safetyIdentifier(userKey: string): string {
  return crypto.createHash('sha256').update(`elpgpt:${userKey}`).digest('hex').slice(0, 32);
}

/** The client-secret request body. Exported for tests. */
export function clientSecretBody(targetLanguage: string, source: LiveSource) {
  return {
    session: {
      model: liveTranslateModel(),
      audio: {
        input: {
          transcription: { model: 'gpt-realtime-whisper' },
          // Near-field suppression suits a person at a mic; tab audio is
          // already clean and would only be degraded by it.
          ...(source === 'mic' ? { noise_reduction: { type: 'near_field' } } : {}),
        },
        output: { language: targetLanguage },
      },
    },
  };
}

/** The guide returns `value`; the cookbook shows `client_secret`. Accept both. */
function readSecret(body: any): { secret: string; expiresAt?: number } | null {
  const raw = body?.value ?? body?.client_secret?.value ?? body?.client_secret;
  if (typeof raw !== 'string' || !raw) return null;
  const expires = body?.expires_at ?? body?.client_secret?.expires_at;
  return { secret: raw, ...(typeof expires === 'number' ? { expiresAt: expires } : {}) };
}

async function upstreamMessage(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  try {
    const parsed = JSON.parse(text);
    return parsed?.error?.message ?? parsed?.message ?? text.slice(0, 300);
  } catch {
    return text.slice(0, 300) || res.statusText;
  }
}

export interface LiveTranslateRequest {
  sdp: unknown;
  targetLanguage: unknown;
  source?: unknown;
  userKey: string;
}

export interface LiveTranslateAnswer {
  sdp: string;
  model: string;
  language: string;
  expiresAt?: number;
}

export async function startLiveTranslation(req: LiveTranslateRequest): Promise<LiveTranslateAnswer> {
  const { sdp, targetLanguage } = req;
  if (typeof sdp !== 'string' || !sdp.startsWith('v=0') || Buffer.byteLength(sdp) > MAX_SDP_BYTES) {
    throw new LiveTranslateError('A WebRTC SDP offer is required', 400, 'invalid_sdp');
  }
  if (!isValidLanguageCode(targetLanguage)) {
    throw new LiveTranslateError('targetLanguage must be a language code such as "es" or "pt-BR"', 400, 'invalid_language');
  }
  const source: LiveSource = req.source === 'tab' ? 'tab' : 'mic';
  const model = liveTranslateModel();
  const tried = new Set<number>();

  for (let attempt = 0; attempt < MAX_KEY_ATTEMPTS; attempt++) {
    const { credential } = reserveProviderCredential({ platform: 'openai', key_id: null, model_id: model }, 0, id => tried.has(id));
    if (!credential) {
      throw attempt === 0
        ? new LiveTranslateError('Live translation needs an OpenAI key. Add one on the Keys page.', 503, 'no_openai_key')
        : new LiveTranslateError('Every OpenAI key was rejected for live translation.', 502, 'openai_keys_rejected');
    }
    tried.add(credential.id);
    try {
      const secretRes = await proxyFetch(`${TRANSLATIONS_URL}/client_secrets`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${credential.key}`,
          'Content-Type': 'application/json',
          'OpenAI-Safety-Identifier': safetyIdentifier(req.userKey),
        },
        body: JSON.stringify(clientSecretBody(targetLanguage, source)),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }, 'openai', 'audio', REQUEST_TIMEOUT_MS);
      if (secretRes.status === 401 || secretRes.status === 403) continue; // next key
      if (!secretRes.ok) {
        throw new LiveTranslateError(`OpenAI refused the translation session: ${await upstreamMessage(secretRes)}`, secretRes.status >= 500 ? 502 : secretRes.status, 'upstream_error');
      }
      const minted = readSecret(await secretRes.json().catch(() => null));
      if (!minted) throw new LiveTranslateError('OpenAI returned no client secret', 502, 'upstream_error');

      const callRes = await proxyFetch(`${TRANSLATIONS_URL}/calls`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${minted.secret}`, 'Content-Type': 'application/sdp' },
        body: sdp,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }, 'openai', 'audio', REQUEST_TIMEOUT_MS);
      if (!callRes.ok) {
        throw new LiveTranslateError(`OpenAI rejected the audio connection: ${await upstreamMessage(callRes)}`, callRes.status >= 500 ? 502 : callRes.status, 'upstream_error');
      }
      const answer = await callRes.text();
      if (!answer.startsWith('v=0')) throw new LiveTranslateError('OpenAI returned no SDP answer', 502, 'upstream_error');
      return { sdp: answer, model, language: targetLanguage, ...(minted.expiresAt ? { expiresAt: minted.expiresAt } : {}) };
    } catch (err) {
      if (err instanceof LiveTranslateError) throw err;
      throw new LiveTranslateError(`Could not reach OpenAI: ${err instanceof Error ? err.message : String(err)}`, 502, 'upstream_unreachable');
    } finally {
      credential.release();
    }
  }
  throw new LiveTranslateError('Every OpenAI key was rejected for live translation.', 502, 'openai_keys_rejected');
}
