import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { classifyIntent, ELP_INTENTS } from '../services/intent.js';
import { loadRouteTable, resolveIntentRoute, ELP_AUTO_MODEL } from '../services/elp-router.js';
import { searchAvailable } from '../services/search.js';
import { startLiveTranslation, LiveTranslateError, liveTranslateModel } from '../services/live-translate.js';
import type { SessionUser } from '../services/auth.js';
import { listMembers, updateMember, quotaState, memberSubject, publicChatEnabled, dailyLimit } from '../services/members.js';

/**
 * Dashboard API behind /chat (requireAuth). The chat itself goes through the
 * normal `/v1/chat/completions` with model `elpgpt-auto`; these endpoints only
 * power the UI: which premium providers are connected, and the live "routing
 * to…" badge that updates while the user types.
 */
export const elpRouter = Router();

const PREMIUM_PLATFORMS = ['anthropic', 'openai', 'perplexity'] as const;

elpRouter.get('/status', (_req: Request, res: Response) => {
  const db = getDb();
  const keyRows = db.prepare(
    "SELECT platform, COUNT(*) AS n FROM api_keys WHERE enabled = 1 AND status IN ('healthy', 'unknown') GROUP BY platform",
  ).all() as { platform: string; n: number }[];
  const keys = new Map(keyRows.map(r => [r.platform, r.n]));
  const table = loadRouteTable();
  res.json({
    model: ELP_AUTO_MODEL,
    liveTranslate: { available: (keys.get('openai') ?? 0) > 0, model: liveTranslateModel() },
    providers: PREMIUM_PLATFORMS.map(platform => ({ platform, connected: (keys.get(platform) ?? 0) > 0 })),
    searchFallback: searchAvailable(),
    routes: ELP_INTENTS.map(intent => ({
      intent,
      route: resolveIntentRoute({ intent, confidence: 1, reason: 'status' }, { db, table }).info,
    })),
  });
});

const routeSchema = z.object({
  text: z.string().max(20_000),
  hasImage: z.boolean().optional(),
  previousIntent: z.enum(ELP_INTENTS).optional(),
});

/** Live preview: what elpgpt-auto would do with this text right now. Cheap
 *  (no network, no model call), so the client can call it while typing. */
elpRouter.post('/route', (req: Request, res: Response) => {
  const parsed = routeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'text is required', type: 'invalid_request_error' } });
    return;
  }
  const intent = classifyIntent(parsed.data.text, {
    hasImageAttachment: parsed.data.hasImage,
    previousIntent: parsed.data.previousIntent,
  });
  const decision = resolveIntentRoute(intent);
  res.json({ ...decision.info, targetLanguage: intent.targetLanguage ?? null });
});

/**
 * Live interpreter handshake: the browser sends its WebRTC SDP offer and the
 * target language, the server mints a short-lived OpenAI translation session
 * and returns the SDP answer. No key or client secret reaches the browser;
 * audio then flows directly between the browser and OpenAI.
 */
elpRouter.post('/realtime/translate', async (req: Request, res: Response) => {
  const user = (req as Request & { user?: SessionUser }).user;
  try {
    const answer = await startLiveTranslation({
      sdp: req.body?.sdp,
      targetLanguage: req.body?.targetLanguage,
      source: req.body?.source,
      userKey: user ? String(user.userId) : 'operator',
    });
    res.json(answer);
  } catch (err) {
    const status = err instanceof LiveTranslateError ? err.status : 502;
    res.status(status).json({
      error: {
        message: err instanceof Error ? err.message : 'Live translation failed',
        type: status >= 500 ? 'server_error' : 'invalid_request_error',
        ...(err instanceof LiveTranslateError && err.code ? { code: err.code } : {}),
      },
    });
  }
});

// ── Public chat members (operator view) ────────────────────────────────────
// Stripe keeps paid plans in sync; the operator can also set a plan by hand
// here (a manual grant that billing never revokes).
elpRouter.get('/members', (_req: Request, res: Response) => {
  res.json({
    publicChatEnabled: publicChatEnabled(),
    limits: { visitor: dailyLimit('visitor'), free: dailyLimit('free'), subscriber: dailyLimit('subscriber') },
    members: listMembers().map(m => ({ ...m, today: quotaState(memberSubject(m), m.plan) })),
  });
});

const memberPatchSchema = z.object({
  plan: z.enum(['free', 'subscriber']).optional(),
  disabled: z.boolean().optional(),
});

elpRouter.patch('/members/:id', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const parsed = memberPatchSchema.safeParse(req.body);
  if (!Number.isInteger(id) || !parsed.success) {
    res.status(400).json({ error: { message: 'Invalid member update', type: 'invalid_request_error' } });
    return;
  }
  const member = updateMember(id, parsed.data);
  if (!member) {
    res.status(404).json({ error: { message: 'Member not found', type: 'invalid_request_error' } });
    return;
  }
  res.json({ member });
});
