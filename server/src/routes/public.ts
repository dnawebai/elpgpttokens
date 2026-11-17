import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { getDb, getUnifiedApiKey } from '../db/index.js';
import { proxyRouter } from './proxy.js';
import { classifyIntent, ELP_INTENTS } from '../services/intent.js';
import { resolveIntentRoute, loadSubscriberRouteTable, ELP_AUTO_MODEL, type ElpRouteTable } from '../services/elp-router.js';
import { withUsageMeter } from '../lib/request-log.js';
import {
  premiumAllowance, publicAllowance, premiumCostMicros, mediaCostMicros, recordPremiumSpend, canAfford,
  liveBlockCostMicros, LIVE_BLOCK_MINUTES, type PremiumAllowance,
} from '../services/premium-usage.js';
import { startLiveTranslation, LiveTranslateError } from '../services/live-translate.js';
import {
  publicChatEnabled, publicSignupEnabled, dailyLimit, tierAllowsPremium,
  createMember, verifyMember, createMemberSession, memberForToken, deleteMemberSession,
  visitorSubject, memberSubject, quotaState, consumeMessage, MemberError,
  type AccessTier, type Member,
} from '../services/members.js';
import {
  billingEnabled, billingPrices, createCheckout, createPortal, handleStripeWebhook, BillingError,
} from '../services/billing.js';

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
  /** Subscribers only: their premium allowance (services/premium-usage.ts). */
  allowance: PremiumAllowance | null;
  /** Premium models and voice right now: a subscriber with allowance left. */
  premium: boolean;
}

function callerOf(req: Request): Caller {
  const member = memberForToken(req.headers[MEMBER_HEADER] as string | undefined);
  if (!member) return { member: null, tier: 'visitor', subject: visitorSubject(req.ip ?? ''), allowance: null, premium: false };
  const subject = memberSubject(member);
  const allowance = tierAllowsPremium(member.plan) ? premiumAllowance(subject) : null;
  return { member, tier: member.plan, subject, allowance, premium: !!allowance && !allowance.exhausted };
}

function fail(res: Response, status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
  res.status(status).json({ error: { message, code, type: status >= 500 ? 'server_error' : 'invalid_request_error', ...extra } });
}

function openaiConnected(): boolean {
  return !!getDb().prepare("SELECT 1 FROM api_keys WHERE platform = 'openai' AND enabled = 1 AND status IN ('healthy', 'unknown') LIMIT 1").get();
}

function features(caller: Caller) {
  const { premium } = caller;
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
  const member = caller.member;
  res.json({
    enabled: true,
    signupEnabled: publicSignupEnabled(),
    tier: caller.tier,
    member: member ? {
      email: member.email,
      plan: member.plan,
      subscription: member.subscriptionStatus ? {
        status: member.subscriptionStatus,
        periodEnd: member.subscriptionPeriodEnd,
        source: member.planSource,
      } : null,
      canManageBilling: !!member.stripeCustomerId,
    } : null,
    quota: quotaState(caller.subject, caller.tier),
    limits: { visitor: dailyLimit('visitor'), free: dailyLimit('free'), subscriber: dailyLimit('subscriber') },
    features: features(caller),
    // Shares and reset time only: subscribers never see dollar amounts.
    allowance: caller.allowance ? publicAllowance(caller.allowance) : null,
    billing: { enabled: billingEnabled() },
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
  const caller = callerOf(req);
  const intent = classifyIntent(parsed.data.text, { hasImageAttachment: parsed.data.hasImage, previousIntent: parsed.data.previousIntent });
  const decision = resolveIntentRoute(intent, { allowPremium: caller.premium, ...(caller.premium ? { table: loadSubscriberRouteTable() } : {}) });
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

type ChatMessageIn = z.infer<typeof chatSchema>['messages'][number];

/** An attached image costs roughly this many characters' worth of context. */
const IMAGE_PART_CHARS = 4_000;

function contextBudgetChars(): number {
  const raw = Number.parseInt(process.env.ELPGPT_PUBLIC_CONTEXT_CHARS ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 48_000;
}

function messageChars(m: ChatMessageIn): number {
  if (typeof m.content === 'string') return m.content.length;
  return m.content.reduce((n, part) => n + (part.type === 'text' ? part.text.length : IMAGE_PART_CHARS), 0);
}

/**
 * Keep the most recent turns that fit the context budget (about 12K tokens by
 * default). Every message resends the whole history, so long conversations
 * are what make each message expensive; this bounds that cost for every tier.
 * System messages (the Translate tool's instructions) and the latest message
 * always stay, and the kept history starts on a user turn, as Claude requires.
 */
export function trimContext<T extends ChatMessageIn>(messages: T[], maxChars = contextBudgetChars()): T[] {
  const system = messages.filter(m => m.role === 'system');
  const turns = messages.filter(m => m.role !== 'system');
  const kept: T[] = [];
  let used = system.reduce((n, m) => n + messageChars(m), 0);
  for (let i = turns.length - 1; i >= 0; i--) {
    const size = messageChars(turns[i]);
    if (kept.length > 0 && used + size > maxChars) break;
    kept.unshift(turns[i]);
    used += size;
  }
  while (kept.length > 1 && kept[0].role === 'assistant') kept.shift();
  return [...system, ...kept];
}

function routeHeaderOf(res: Response): { kind?: string; platform?: string | null } | null {
  const raw = res.getHeader('x-elp-route');
  if (typeof raw !== 'string') return null;
  try { return JSON.parse(decodeURIComponent(raw)); } catch { return null; }
}

/** Hand a vetted request to the gateway's own /v1 handlers, in-process. */
function forwardToGateway(req: Request, res: Response, next: NextFunction, path: string, allowPremium: boolean, routeTable?: ElpRouteTable) {
  req.url = path;
  req.headers.authorization = `Bearer ${getUnifiedApiKey()}`;
  // The gateway also reads keys from these; only the injected key may count.
  delete req.headers['x-api-key'];
  delete req.headers['x-goog-api-key'];
  const elpReq = req as Request & { elpAllowPremium?: boolean; elpRouteTable?: ElpRouteTable };
  elpReq.elpAllowPremium = allowPremium;
  if (routeTable) elpReq.elpRouteTable = routeTable;
  proxyRouter(req, res, next);
}

/**
 * Forward a subscriber's request with its premium cost metered: token costs of
 * every call the gateway logs (failover attempts included) and, once the
 * response finishes, the fixed cost of a generated image.
 */
function forwardMetered(caller: Caller, req: Request, res: Response, next: NextFunction, path: string, extra?: () => number) {
  const subject = caller.subject;
  res.on('finish', () => {
    if (res.statusCode !== 200) return;
    const route = routeHeaderOf(res);
    if (route?.kind === 'image' && route.platform === 'openai') recordPremiumSpend(subject, mediaCostMicros('image'));
    if (extra) recordPremiumSpend(subject, extra());
  });
  withUsageMeter(
    usage => recordPremiumSpend(subject, premiumCostMicros(usage.platform, usage.modelId, usage.inputTokens, usage.outputTokens)),
    () => forwardToGateway(req, res, next, path, caller.premium, caller.premium ? loadSubscriberRouteTable() : undefined),
  );
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
  req.body = { model: ELP_AUTO_MODEL, messages: trimContext(parsed.data.messages), stream: parsed.data.stream ?? true };
  // Subscribers with allowance left get the premium (cost-efficient) routes;
  // once it is used up they keep chatting on the free pool.
  if (caller.allowance) forwardMetered(caller, req, res, next, '/chat/completions');
  else forwardToGateway(req, res, next, '/chat/completions', false);
});

// ── Voice (subscribers) ───────────────────────────────────────────────────
function allowanceUsed(res: Response, caller: Caller) {
  fail(res, 403, 'premium_allowance_used', 'Your premium allowance is used up for now. Voice comes back when it resets.', {
    resetsAt: caller.allowance?.resetsAt ?? null,
  });
}

function requirePremium(req: Request, res: Response): Caller | null {
  const caller = callerOf(req);
  if (!tierAllowsPremium(caller.tier)) {
    fail(res, 403, 'subscription_required', 'Voice features are part of the subscription.');
    return null;
  }
  if (!caller.premium) {
    allowanceUsed(res, caller);
    return null;
  }
  return caller;
}

publicRouter.post('/speech', (req: Request, res: Response, next: NextFunction) => {
  if (!requirePremium(req, res)) return;
  const input = typeof req.body?.input === 'string' ? req.body.input.slice(0, 4000) : '';
  if (!input) return fail(res, 400, 'invalid_request', 'input is required');
  // Read-aloud runs on the free speech pool: nothing to meter.
  req.body = { model: 'auto', input, response_format: 'mp3' };
  forwardToGateway(req, res, next, '/audio/speech', true);
});

publicRouter.post('/transcriptions', (req: Request, res: Response, next: NextFunction) => {
  const caller = requirePremium(req, res);
  if (!caller) return;
  // Multipart: the body stream is untouched (no JSON parser ran), so the
  // gateway's own multer handler reads it.
  forwardMetered(caller, req, res, next, '/audio/transcriptions', () => mediaCostMicros('transcription'));
});

// Live interpreting is billed by OpenAI per minute, and the audio never passes
// through this server, so minutes are charged ahead in blocks: the first block
// when a session starts, the next ones as the interpreter asks to keep going
// (/realtime/extend). Out of allowance, the interpreter is told to stop.
publicRouter.post('/realtime/translate', async (req: Request, res: Response) => {
  const caller = requirePremium(req, res);
  if (!caller) return;
  if (!canAfford(caller.subject, liveBlockCostMicros())) return allowanceUsed(res, caller);
  try {
    const answer = await startLiveTranslation({
      sdp: req.body?.sdp,
      targetLanguage: req.body?.targetLanguage,
      source: req.body?.source,
      userKey: caller.subject,
    });
    recordPremiumSpend(caller.subject, liveBlockCostMicros());
    res.json({ ...answer, blockMinutes: LIVE_BLOCK_MINUTES });
  } catch (err) {
    const status = err instanceof LiveTranslateError ? err.status : 502;
    fail(res, status, err instanceof LiveTranslateError && err.code ? err.code : 'live_translate_failed',
      err instanceof Error ? err.message : 'Live translation failed');
  }
});

// ── Billing (Stripe) ──────────────────────────────────────────────────────
// Checkout and the customer portal are Stripe-hosted pages: these routes only
// mint a session and return its URL. The plan itself changes when Stripe's
// webhook arrives (stripeWebhookHandler below), never on the browser's word.

function requestOrigin(req: Request): string {
  return `${req.protocol}://${req.get('host') ?? 'localhost'}`;
}

function billingFail(res: Response, err: unknown) {
  if (err instanceof BillingError) return fail(res, err.status, err.code, err.message);
  console.error('[billing] Stripe request failed:', err instanceof Error ? err.message : err);
  fail(res, 502, 'stripe_error', 'The payment provider could not be reached. Please try again.');
}

function requireMember(req: Request, res: Response): Member | null {
  const { member } = callerOf(req);
  if (!member) {
    fail(res, 401, 'sign_in_required', 'Sign in to subscribe.');
    return null;
  }
  return member;
}

publicRouter.get('/billing/prices', async (_req: Request, res: Response) => {
  if (!billingEnabled()) return fail(res, 404, 'billing_disabled', 'Subscriptions are not available on this server.');
  res.json({ prices: await billingPrices() });
});

const checkoutSchema = z.object({ interval: z.enum(['month', 'year']) });

publicRouter.post('/billing/checkout', async (req: Request, res: Response) => {
  const parsed = checkoutSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, 'invalid_request', 'interval must be "month" or "year".');
  const member = requireMember(req, res);
  if (!member) return;
  try {
    res.json({ url: await createCheckout(member, parsed.data.interval, requestOrigin(req)) });
  } catch (err) {
    billingFail(res, err);
  }
});

publicRouter.post('/billing/portal', async (req: Request, res: Response) => {
  const member = requireMember(req, res);
  if (!member) return;
  try {
    res.json({ url: await createPortal(member, requestOrigin(req)) });
  } catch (err) {
    billingFail(res, err);
  }
});

/**
 * POST /api/public/billing/webhook. Mounted in app.ts with a raw body parser
 * ahead of the JSON parsers (the signature covers the exact bytes Stripe
 * sent) and ahead of the admin rate limiter (Stripe delivers from shared
 * addresses; the signature is the authentication). A processing error answers
 * 500 so Stripe redelivers; handling is idempotent.
 */
export async function stripeWebhookHandler(req: Request, res: Response): Promise<void> {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  try {
    const result = await handleStripeWebhook(raw, req.get('stripe-signature'));
    res.json({ received: true, handled: result.handled });
  } catch (err) {
    if (err instanceof BillingError) return fail(res, err.status, err.code, err.message);
    console.error('[billing] webhook processing failed:', err instanceof Error ? err.message : err);
    fail(res, 500, 'webhook_failed', 'Webhook processing failed');
  }
}

const extendSchema = z.object({ sessions: z.union([z.literal(1), z.literal(2)]).optional() });

/** Keep a live interpreter going for another block of minutes. */
publicRouter.post('/realtime/extend', (req: Request, res: Response) => {
  const caller = requirePremium(req, res);
  if (!caller) return;
  const parsed = extendSchema.safeParse(req.body ?? {});
  if (!parsed.success) return fail(res, 400, 'invalid_request', 'sessions must be 1 or 2');
  const cost = liveBlockCostMicros(parsed.data.sessions ?? 1);
  if (!canAfford(caller.subject, cost)) return allowanceUsed(res, caller);
  recordPremiumSpend(caller.subject, cost);
  res.json({ ok: true, blockMinutes: LIVE_BLOCK_MINUTES });
});
