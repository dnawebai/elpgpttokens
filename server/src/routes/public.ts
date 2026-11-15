import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { getDb, getUnifiedApiKey } from '../db/index.js';
import { proxyRouter } from './proxy.js';
import { classifyIntent, ELP_INTENTS } from '../services/intent.js';
import { resolveIntentRoute, ELP_AUTO_MODEL } from '../services/elp-router.js';
import { startLiveTranslation, LiveTranslateError } from '../services/live-translate.js';
import {
  publicChatEnabled, publicSignupEnabled, dailyLimit, tierAllowsPremium,
  createMember, verifyMember, createMemberSession, memberForToken, deleteMemberSession,
  visitorSubject, memberSubject, quotaState, consumeMessage, MemberError,
  type AccessTier, type Member,
} from '../services/members.js';

/**
 * Public elpgpt.com/chat API (no dashboard session). Off unless
 * ELPGPT_PUBLIC_CHAT is set. Visitors and members chat through the same
 * `elpgpt-auto` pipeline as the dashboard: the request is checked against the
 * caller's plan and daily quota, reduced to a safe shape, and handed to
 * proxyRouter in-process with the unified key injected server-side (the
 * pattern routes/url-tokens.ts uses). The unified key never leaves the
 * server, and the premium restriction is a request property, not a header, so
 * a client cannot lift it.
 */
export const publicRouter = Router();

const MEMBER_HEADER = 'x-member-token';
const MAX_MESSAGES = 60;
const MAX_TEXT_CHARS = 32_000;
const MAX_BODY_CHARS = 6_000_000;

interface Caller {
  member: Member | null;
  tier: AccessTier;
  subject: string;
}

function callerOf(req: Request): Caller {
  const member = memberForToken(req.headers[MEMBER_HEADER] as string | undefined);
  return member
    ? { member, tier: member.plan, subject: memberSubject(member) }
    : { member: null, tier: 'visitor', subject: visitorSubject(req.ip ?? '') };
}

function fail(res: Response, status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
  res.status(status).json({ error: { message, code, type: status >= 500 ? 'server_error' : 'invalid_request_error', ...extra } });
}

function openaiConnected(): boolean {
  return !!getDb().prepare("SELECT 1 FROM api_keys WHERE platform = 'openai' AND enabled = 1 AND status IN ('healthy', 'unknown') LIMIT 1").get();
}

function features(tier: AccessTier) {
  const premium = tierAllowsPremium(tier);
  return { premium, voice: premium, liveTranslate: premium && openaiConnected() };
}

/** Everything except /status needs the surface switched on. */
publicRouter.use((req: Request, res: Response, next: NextFunction) => {
  if (req.path === '/status' || publicChatEnabled()) return next();
  fail(res, 404, 'public_chat_disabled', 'Public chat is not enabled on this server.');
});

publicRouter.get('/status', (req: Request, res: Response) => {
  if (!publicChatEnabled()) {
    res.json({ enabled: false });
    return;
  }
  const caller = callerOf(req);
  res.json({
    enabled: true,
    signupEnabled: publicSignupEnabled(),
    tier: caller.tier,
    member: caller.member ? { email: caller.member.email, plan: caller.member.plan } : null,
    quota: quotaState(caller.subject, caller.tier),
    limits: { visitor: dailyLimit('visitor'), free: dailyLimit('free'), subscriber: dailyLimit('subscriber') },
    features: features(caller.tier),
  });
});

// ── Accounts ───────────────────────────────────────────────────────────────
// Per-IP attempt budget for signup and login; blunts account farming and
// password guessing on a surface open to the internet.
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;
const attempts = new Map<string, { count: number; resetAt: number }>();

function throttled(req: Request): boolean {
  const key = req.ip ?? 'unknown';
  const now = Date.now();
  const entry = attempts.get(key);
  if (!entry || entry.resetAt <= now) {
    attempts.set(key, { count: 1, resetAt: now + ATTEMPT_WINDOW_MS });
    if (attempts.size > 50_000) for (const [k, v] of attempts) if (v.resetAt <= now) attempts.delete(k);
    return false;
  }
  entry.count++;
  return entry.count > MAX_ATTEMPTS;
}

/** Test hook: clear the per-IP attempt budget. */
export function resetPublicThrottle(): void {
  attempts.clear();
}

const credentialsSchema = z.object({ email: z.string().max(320), password: z.string().max(200) });

function sessionResponse(member: Member, token: string) {
  return { token, member: { email: member.email, plan: member.plan } };
}

publicRouter.post('/signup', (req: Request, res: Response) => {
  if (!publicSignupEnabled()) return fail(res, 403, 'signup_disabled', 'Sign-ups are closed on this server.');
  if (throttled(req)) return fail(res, 429, 'too_many_attempts', 'Too many attempts. Try again in a few minutes.');
  const parsed = credentialsSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, 'invalid_request', 'Email and password are required.');
  try {
    const member = createMember(parsed.data.email, parsed.data.password);
    res.status(201).json(sessionResponse(member, createMemberSession(member.id)));
  } catch (err) {
    if (err instanceof MemberError) return fail(res, err.status, err.code, err.message);
    throw err;
  }
});

publicRouter.post('/login', (req: Request, res: Response) => {
  if (throttled(req)) return fail(res, 429, 'too_many_attempts', 'Too many attempts. Try again in a few minutes.');
  const parsed = credentialsSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, 'invalid_request', 'Email and password are required.');
  const member = verifyMember(parsed.data.email, parsed.data.password);
  if (!member) return fail(res, 401, 'invalid_credentials', 'Wrong email or password.');
  if (member.disabled) return fail(res, 403, 'account_disabled', 'This account has been disabled.');
  res.json(sessionResponse(member, createMemberSession(member.id)));
});

publicRouter.post('/logout', (req: Request, res: Response) => {
  const token = req.headers[MEMBER_HEADER];
  if (typeof token === 'string' && token) deleteMemberSession(token);
  res.json({ success: true });
});

// ── Routing preview ───────────────────────────────────────────────────────
const routeSchema = z.object({
  text: z.string().max(20_000),
  hasImage: z.boolean().optional(),
  previousIntent: z.enum(ELP_INTENTS).optional(),
});

publicRouter.post('/route', (req: Request, res: Response) => {
  const parsed = routeSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, 'invalid_request', 'text is required');
  const { tier } = callerOf(req);
  const intent = classifyIntent(parsed.data.text, { hasImageAttachment: parsed.data.hasImage, previousIntent: parsed.data.previousIntent });
  const decision = resolveIntentRoute(intent, { allowPremium: tierAllowsPremium(tier) });
  res.json({ ...decision.info, targetLanguage: intent.targetLanguage ?? null });
});

// ── Chat ──────────────────────────────────────────────────────────────────
const contentPart = z.union([
  z.object({ type: z.literal('text'), text: z.string().max(MAX_TEXT_CHARS) }),
  z.object({ type: z.literal('image_url'), image_url: z.object({ url: z.string().regex(/^(?:data:image\/(?:png|jpeg|webp|gif);base64,|https:\/\/)/) }) }),
]);
const chatSchema = z.object({
  messages: z.array(z.object({
    role: z.enum(['system', 'user', 'assistant']),
    content: z.union([z.string().max(MAX_TEXT_CHARS), z.array(contentPart).max(6)]),
  })).min(1).max(MAX_MESSAGES),
  stream: z.boolean().optional(),
});

/** Hand a vetted request to the gateway's own /v1 handlers, in-process. */
function forwardToGateway(req: Request, res: Response, next: NextFunction, path: string, allowPremium: boolean) {
  req.url = path;
  req.headers.authorization = `Bearer ${getUnifiedApiKey()}`;
  // The gateway also reads keys from these; only the injected key may count.
  delete req.headers['x-api-key'];
  delete req.headers['x-goog-api-key'];
  (req as Request & { elpAllowPremium?: boolean }).elpAllowPremium = allowPremium;
  proxyRouter(req, res, next);
}

publicRouter.post('/chat', (req: Request, res: Response, next: NextFunction) => {
  const parsed = chatSchema.safeParse(req.body);
  if (!parsed.success || JSON.stringify(parsed.data.messages).length > MAX_BODY_CHARS) {
    return fail(res, 400, 'invalid_request', 'The message is too long or malformed.');
  }
  const caller = callerOf(req);
  if (caller.tier === 'visitor' && dailyLimit('visitor') === 0) {
    return fail(res, 403, 'sign_in_required', 'Sign in to start chatting.');
  }
  const quota = consumeMessage(caller.subject, caller.tier);
  res.setHeader('X-ELP-Quota-Remaining', String(quota.remaining));
  if (!quota.allowed) {
    return fail(res, 429, 'daily_limit_reached', 'You have used all of today\'s messages.', { limit: quota.limit, tier: caller.tier });
  }
  // Only the vetted fields reach the gateway: model is always elpgpt-auto.
  req.body = { model: ELP_AUTO_MODEL, messages: parsed.data.messages, stream: parsed.data.stream ?? true };
  forwardToGateway(req, res, next, '/chat/completions', tierAllowsPremium(caller.tier));
});

// ── Voice (subscribers) ───────────────────────────────────────────────────
function requirePremium(req: Request, res: Response): Caller | null {
  const caller = callerOf(req);
  if (!tierAllowsPremium(caller.tier)) {
    fail(res, 403, 'subscription_required', 'Voice features are part of the subscription.');
    return null;
  }
  return caller;
}

publicRouter.post('/speech', (req: Request, res: Response, next: NextFunction) => {
  if (!requirePremium(req, res)) return;
  const input = typeof req.body?.input === 'string' ? req.body.input.slice(0, 4000) : '';
  if (!input) return fail(res, 400, 'invalid_request', 'input is required');
  req.body = { model: 'auto', input, response_format: 'mp3' };
  forwardToGateway(req, res, next, '/audio/speech', true);
});

publicRouter.post('/transcriptions', (req: Request, res: Response, next: NextFunction) => {
  if (!requirePremium(req, res)) return;
  // Multipart: the body stream is untouched (no JSON parser ran), so the
  // gateway's own multer handler reads it.
  forwardToGateway(req, res, next, '/audio/transcriptions', true);
});

publicRouter.post('/realtime/translate', async (req: Request, res: Response) => {
  const caller = requirePremium(req, res);
  if (!caller) return;
  try {
    res.json(await startLiveTranslation({
      sdp: req.body?.sdp,
      targetLanguage: req.body?.targetLanguage,
      source: req.body?.source,
      userKey: caller.subject,
    }));
  } catch (err) {
    const status = err instanceof LiveTranslateError ? err.status : 502;
    fail(res, status, err instanceof LiveTranslateError && err.code ? err.code : 'live_translate_failed',
      err instanceof Error ? err.message : 'Live translation failed');
  }
});
