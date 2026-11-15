/**
 * ELPGPT auto-router: one virtual model (`elpgpt-auto`) that reads the
 * prompt, works out what kind of task it is (services/intent.ts), and sends it
 * to the best model the operator has keys for:
 *
 *   web search        → Perplexity Agent API (cited, live web)
 *   image generation  → OpenAI GPT Image
 *   code / reasoning / writing / vision → Claude Opus 5.5, then GPT-6.1 Sol
 *   chat / translation → GPT-6.1 Sol, then Claude Opus 5.5
 *
 * Each intent maps to an ordered ladder of targets (DEFAULT_ROUTES, overridable
 * with the ELPGPT_ROUTES env var). Targets whose platform has no usable key are
 * skipped; the rest become a STRICT group chain for the normal router, so
 * failover, key rotation, cooldowns, logging and analytics all behave exactly
 * as for any pinned model. When no premium target is usable the request falls
 * back to the free pool (`auto`), and a search intent is still grounded with
 * the gateway's own search engines when any are configured.
 *
 * Premium rows are seeded with their fallback_config row DISABLED, so plain
 * `auto` never spends on paid models; only elpgpt-auto (or an explicit pin)
 * reaches them. The operator can opt them into `auto` from the Models page.
 */
import type { ChatMessage, ElpRouteInfo, Platform } from '@freellmapi/shared/types.js';
import type { Db } from '../db/index.js';
import { getDb } from '../db/index.js';
import { classifyIntent, isElpIntent, ELP_INTENTS, type ElpIntent, type IntentResult } from './intent.js';
import { resolveModelGroupCandidates, type ChainRow } from './router.js';
import { contentToString } from '../lib/content.js';

export const ELP_AUTO_MODEL = 'elpgpt-auto';

export function isElpAutoModel(modelId: string | null | undefined): boolean {
  return typeof modelId === 'string' && modelId.trim().toLowerCase() === ELP_AUTO_MODEL;
}

type ElpPlatform = Extract<Platform, 'anthropic' | 'openai' | 'perplexity'>;
type Effort = 'low' | 'medium' | 'high';

export interface ElpRouteTarget {
  platform: Platform;
  model: string;
  /** Reasoning effort to request when the client set none. */
  effort?: Effort;
}

export type ElpRouteTable = Record<ElpIntent, ElpRouteTarget[]>;

const CLAUDE = 'claude-opus-5-5';
const GPT = 'gpt-6.1-sol';

export const DEFAULT_ROUTES: ElpRouteTable = {
  web_search: [{ platform: 'perplexity', model: 'fast' }],
  image_generation: [{ platform: 'openai', model: 'gpt-image-2.6-flare' }],
  code: [{ platform: 'anthropic', model: CLAUDE, effort: 'high' }, { platform: 'openai', model: GPT, effort: 'high' }],
  reasoning: [{ platform: 'anthropic', model: CLAUDE, effort: 'high' }, { platform: 'openai', model: GPT, effort: 'high' }],
  writing: [{ platform: 'anthropic', model: CLAUDE }, { platform: 'openai', model: GPT }],
  vision: [{ platform: 'anthropic', model: CLAUDE }, { platform: 'openai', model: GPT }],
  translation: [{ platform: 'openai', model: GPT }, { platform: 'anthropic', model: CLAUDE }],
  chat: [{ platform: 'openai', model: GPT }, { platform: 'anthropic', model: CLAUDE }],
};

/** Catalog metadata for the premium chat models the default routes name. A
 *  route that names a model not listed here still works: it is seeded with
 *  conservative defaults (no vision/tools flags, unknown context window). */
interface ChatModelSpec {
  displayName: string;
  contextWindow: number | null;
  vision: boolean;
  tools: boolean;
  intelligenceRank: number;
  speedRank: number;
}

const CHAT_MODEL_SPECS: Record<string, ChatModelSpec> = {
  'anthropic:claude-opus-5-5': { displayName: 'Claude Opus 5.5', contextWindow: 1_000_000, vision: true, tools: true, intelligenceRank: 1, speedRank: 3 },
  'anthropic:claude-sonnet-5-5': { displayName: 'Claude Sonnet 5.5', contextWindow: 1_000_000, vision: true, tools: true, intelligenceRank: 2, speedRank: 2 },
  'anthropic:claude-haiku-5-5': { displayName: 'Claude Haiku 5.5', contextWindow: 1_000_000, vision: true, tools: true, intelligenceRank: 4, speedRank: 1 },
  'openai:gpt-6-astra': { displayName: 'GPT-6 Astra', contextWindow: null, vision: true, tools: true, intelligenceRank: 1, speedRank: 3 },
  'openai:gpt-6.1-sol': { displayName: 'GPT-6.1 Sol', contextWindow: null, vision: true, tools: true, intelligenceRank: 2, speedRank: 2 },
  'openai:gpt-6-luna': { displayName: 'GPT-6 Luna', contextWindow: null, vision: true, tools: true, intelligenceRank: 4, speedRank: 1 },
  'perplexity:fast': { displayName: 'Perplexity Search', contextWindow: null, vision: true, tools: false, intelligenceRank: 3, speedRank: 1 },
  'perplexity:low': { displayName: 'Perplexity Pro Search', contextWindow: null, vision: true, tools: false, intelligenceRank: 2, speedRank: 2 },
  'perplexity:high': { displayName: 'Perplexity Deep Research', contextWindow: null, vision: true, tools: false, intelligenceRank: 1, speedRank: 4 },
};

interface MediaModelSpec { platform: 'openai'; modelId: string; displayName: string; modality: 'image' | 'transcription' }

/** Premium media rows. Speech output stays on the free TTS pool. */
export const ELP_MEDIA_MODELS: readonly MediaModelSpec[] = [
  { platform: 'openai', modelId: 'gpt-image-2.6-flare', displayName: 'GPT Image 2.6 Flare', modality: 'image' },
  { platform: 'openai', modelId: 'gpt-image-2.6-sunburst', displayName: 'GPT Image 2.6 Sunburst', modality: 'image' },
  { platform: 'openai', modelId: 'gpt-transcribe', displayName: 'GPT Transcribe', modality: 'transcription' },
];

const ELP_PLATFORMS = new Set<string>(['anthropic', 'openai', 'perplexity'] satisfies ElpPlatform[]);

/**
 * The route table: defaults, with per-intent overrides from ELPGPT_ROUTES, a
 * JSON object such as
 *   {"chat":[{"platform":"anthropic","model":"claude-opus-5-5"}]}
 * Malformed JSON or entries are ignored with a warning, never fatal: a typo in
 * an env var must not take routing down.
 */
export function loadRouteTable(raw: string | undefined = process.env.ELPGPT_ROUTES): ElpRouteTable {
  const table: ElpRouteTable = { ...DEFAULT_ROUTES };
  if (!raw?.trim()) return table;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn('[elpgpt] ELPGPT_ROUTES is not valid JSON; using default routes');
    return table;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return table;
  for (const [intent, targets] of Object.entries(parsed as Record<string, unknown>)) {
    if (!isElpIntent(intent) || !Array.isArray(targets)) {
      console.warn(`[elpgpt] ELPGPT_ROUTES: ignoring unknown intent '${intent}'`);
      continue;
    }
    const clean = targets
      .filter((t): t is { platform: string; model: string; effort?: string } =>
        !!t && typeof t === 'object' && typeof (t as any).platform === 'string' && typeof (t as any).model === 'string')
      .map(t => ({
        platform: t.platform as Platform,
        model: t.model,
        ...(t.effort === 'low' || t.effort === 'medium' || t.effort === 'high' ? { effort: t.effort as Effort } : {}),
      }));
    table[intent] = clean;
  }
  return table;
}

/**
 * Make sure every model the route table names exists in the catalog. Rows are
 * written with source='user' (catalog sync deletes source='catalog' rows it
 * does not publish) and a DISABLED fallback_config row, which keeps them out of
 * plain `auto` and out of every profile backfill (profiles copy that flag).
 * Existing rows are never modified, so an operator's edits stick.
 */
export function ensureElpCatalog(db: Db = getDb(), table: ElpRouteTable = loadRouteTable()): void {
  const findModel = db.prepare('SELECT id FROM models WHERE platform = ? AND model_id = ?');
  const insertModel = db.prepare(`
    INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
                        monthly_token_budget, context_window, enabled, supports_vision, supports_tools, source)
    VALUES (?, ?, ?, ?, ?, 'Premium', 'Paid (BYOK)', ?, 1, ?, ?, 'user')
  `);
  const hasFallback = db.prepare('SELECT 1 FROM fallback_config WHERE model_db_id = ?');
  const maxPriority = db.prepare('SELECT COALESCE(MAX(priority), 0) AS mx FROM fallback_config');
  const insertFallback = db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 0)');
  const findMedia = db.prepare('SELECT 1 FROM media_models WHERE platform = ? AND model_id = ?');
  const insertMedia = db.prepare(`
    INSERT INTO media_models (platform, model_id, display_name, modality, priority, enabled, quota_label)
    VALUES (?, ?, ?, ?, ?, 1, 'Paid (BYOK)')
  `);

  db.transaction(() => {
    const seen = new Set<string>();
    for (const intent of ELP_INTENTS) {
      if (intent === 'image_generation') continue;
      for (const target of table[intent]) {
        if (!ELP_PLATFORMS.has(target.platform)) continue; // free-pool targets already exist
        const key = `${target.platform}:${target.model}`;
        if (seen.has(key)) continue;
        seen.add(key);
        let row = findModel.get(target.platform, target.model) as { id: number } | undefined;
        if (!row) {
          const spec = CHAT_MODEL_SPECS[key];
          const info = insertModel.run(
            target.platform, target.model, spec?.displayName ?? target.model,
            spec?.intelligenceRank ?? 3, spec?.speedRank ?? 3, spec?.contextWindow ?? null,
            spec?.vision ? 1 : 0, spec?.tools ? 1 : 0,
          );
          row = { id: Number(info.lastInsertRowid) };
        }
        if (!hasFallback.get(row.id)) {
          insertFallback.run(row.id, (maxPriority.get() as { mx: number }).mx + 1);
        }
      }
    }
    // Premium media goes to the back of each modality's chain: the free image
    // pool still serves plain `auto` image requests first.
    for (const m of ELP_MEDIA_MODELS) {
      if (findMedia.get(m.platform, m.modelId)) continue;
      insertMedia.run(m.platform, m.modelId, m.displayName, m.modality, 10_000);
    }
  })();
}

function usablePlatforms(db: Db): Set<string> {
  const rows = db.prepare(
    "SELECT DISTINCT platform FROM api_keys WHERE enabled = 1 AND status IN ('healthy', 'unknown')",
  ).all() as { platform: string }[];
  return new Set(rows.map(r => r.platform));
}

function lastUserIndex(messages: ChatMessage[], before = messages.length): number {
  for (let i = before - 1; i >= 0; i--) if (messages[i]?.role === 'user') return i;
  return -1;
}

function hasImagePart(message: ChatMessage | undefined): boolean {
  return Array.isArray(message?.content)
    && message.content.some(p => typeof p === 'object' && p !== null && (p.type === 'image_url' || p.type === 'image'));
}

/** The text the classifier reads: the latest user turn. */
export function latestUserText(messages: ChatMessage[]): string {
  const i = lastUserIndex(messages);
  return i >= 0 ? contentToString(messages[i].content) : '';
}

export interface ElpDecision {
  info: ElpRouteInfo;
  intent: IntentResult;
  /** Strict ladder for the router (chat kinds with a premium route). */
  chain: ChainRow[];
  /** First choice of the ladder, so the router's bandit can't reorder it. */
  preferredModelDbId?: number;
  /** Model id for /images/generations (image kind). */
  imageModel?: string;
  effort?: Effort;
}

function label(platform: string | null, model: string | null, db: Db): string {
  if (!platform || !model) return 'Free models (auto)';
  const spec = CHAT_MODEL_SPECS[`${platform}:${model}`];
  if (spec) return spec.displayName;
  const media = ELP_MEDIA_MODELS.find(m => m.platform === platform && m.modelId === model);
  if (media) return media.displayName;
  const row = db.prepare('SELECT display_name FROM models WHERE platform = ? AND model_id = ?').get(platform, model) as { display_name: string } | undefined;
  return row?.display_name ?? model;
}

/**
 * Decide where an elpgpt-auto request goes. Pure with respect to the request:
 * reads the catalog and key table, writes nothing.
 */
export function decideElpRoute(messages: ChatMessage[], opts: { table?: ElpRouteTable; db?: Db } = {}): ElpDecision {
  const db = opts.db ?? getDb();
  const table = opts.table ?? loadRouteTable();
  const lastIdx = lastUserIndex(messages);
  const prevIdx = lastIdx > 0 ? lastUserIndex(messages, lastIdx) : -1;
  const previousIntent = prevIdx >= 0 ? classifyIntent(contentToString(messages[prevIdx].content)).intent : undefined;
  const intent = classifyIntent(latestUserText(messages), {
    hasImageAttachment: hasImagePart(messages[lastIdx]),
    previousIntent,
  });
  return resolveIntentRoute(intent, { db, table });
}

/** The routing half of decideElpRoute, for a known intent (also used by the
 *  live preview endpoint). */
export function resolveIntentRoute(intent: IntentResult, opts: { table?: ElpRouteTable; db?: Db } = {}): ElpDecision {
  const db = opts.db ?? getDb();
  const table = opts.table ?? loadRouteTable();
  const keys = usablePlatforms(db);
  const targets = table[intent.intent] ?? [];
  const base = { intent: intent.intent, reason: intent.reason, confidence: intent.confidence };

  if (intent.intent === 'image_generation') {
    const findMedia = db.prepare("SELECT 1 FROM media_models WHERE platform = ? AND model_id = ? AND modality = 'image' AND enabled = 1");
    const target = targets.find(t => keys.has(t.platform) && findMedia.get(t.platform, t.model));
    if (target) {
      return {
        intent,
        chain: [],
        imageModel: target.model,
        info: { ...base, platform: target.platform, model: target.model, label: label(target.platform, target.model, db), kind: 'image', fallback: false },
      };
    }
    // No premium image key: any enabled image model in the free pool.
    const anyImage = db.prepare("SELECT 1 FROM media_models WHERE modality = 'image' AND enabled = 1 AND platform NOT IN ('openai') LIMIT 1").get();
    if (anyImage) {
      return {
        intent,
        chain: [],
        imageModel: 'auto',
        info: { ...base, platform: null, model: 'auto', label: 'Free image models (auto)', kind: 'image', fallback: true },
      };
    }
    // Nothing can draw: answer in chat (it can at least describe or explain).
    return resolveIntentRoute({ ...intent, intent: 'chat', reason: `${intent.reason}; no image model configured` }, opts);
  }

  const findModel = db.prepare('SELECT id FROM models WHERE platform = ? AND model_id = ? AND enabled = 1');
  const usable = targets
    .filter(t => keys.has(t.platform))
    .map(t => ({ target: t, row: findModel.get(t.platform, t.model) as { id: number } | undefined }))
    .filter((x): x is { target: ElpRouteTarget; row: { id: number } } => !!x.row);

  if (usable.length === 0) {
    return {
      intent,
      chain: [],
      info: { ...base, platform: null, model: 'auto', label: label(null, null, db), kind: 'chat', fallback: true },
    };
  }

  const chain = resolveModelGroupCandidates(usable.map(u => u.row.id));
  const first = usable[0];
  return {
    intent,
    chain,
    preferredModelDbId: first.row.id,
    effort: first.target.effort,
    info: {
      ...base,
      platform: first.target.platform,
      model: first.target.model,
      label: label(first.target.platform, first.target.model, db),
      kind: 'chat',
      fallback: false,
    },
  };
}

/** HTTP-header-safe encoding of the route info (`X-ELP-Route`). */
export function encodeRouteHeader(info: ElpRouteInfo): string {
  return encodeURIComponent(JSON.stringify(info));
}

/**
 * System prompt that grounds a free-pool answer in the gateway's own search
 * results when no Perplexity key is configured. Numbered so the model can cite
 * them inline, then list the sources it used.
 */
export function searchGroundingPrompt(query: string, hits: Array<{ title: string; url: string; content: string }>): string {
  const today = new Date().toISOString().slice(0, 10);
  const sources = hits
    .map((h, i) => `[${i + 1}] ${h.title}\n${h.url}\n${h.content.replace(/\s+/g, ' ').slice(0, 800)}`)
    .join('\n\n');
  return [
    `Today is ${today}. Answer the user's question using these web search results for "${query}".`,
    'Cite sources inline as [1], [2] right after the claims they support. If the results do not answer the question, say so instead of guessing.',
    'End with a "Sources" list of the URLs you cited, as markdown links.',
    '',
    sources,
  ].join('\n');
}

/**
 * The prompt to send to the image model. A follow-up ("make it darker",
 * "otra versión") only makes sense with the image it refers to, so it is
 * appended to the previous image prompt. A leading /image command is dropped.
 */
export function buildImagePrompt(messages: ChatMessage[], intent: IntentResult): string {
  const strip = (t: string) => t.replace(/^\s*\/(?:image|imagine|img)\b\s*/i, '').trim();
  const lastIdx = lastUserIndex(messages);
  const current = strip(lastIdx >= 0 ? contentToString(messages[lastIdx].content) : '');
  if (intent.reason.includes('follow-up')) {
    for (let i = lastIdx - 1; i >= 0; i--) {
      if (messages[i].role !== 'user') continue;
      const text = contentToString(messages[i].content);
      if (classifyIntent(text).intent === 'image_generation') return `${strip(text)}. Change: ${current}`.slice(0, 4000);
    }
  }
  return (current || 'An image').slice(0, 4000);
}
