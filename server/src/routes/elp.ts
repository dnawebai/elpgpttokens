import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { classifyIntent, ELP_INTENTS } from '../services/intent.js';
import { loadRouteTable, resolveIntentRoute, ELP_AUTO_MODEL } from '../services/elp-router.js';
import { searchAvailable } from '../services/search.js';

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
