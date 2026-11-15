/**
 * Premium allowance for public chat subscribers (elpgpt.com/chat).
 *
 * A subscription is a flat fee, but every premium call costs the operator real
 * money, and costs differ by orders of magnitude: an everyday chat on Haiku or
 * Luna is a fraction of a cent, a high-effort Sonnet coding answer a few cents,
 * an image about five, a minute of live interpreting about three. So each
 * subscriber gets an allowance measured in estimated provider cost, with a
 * daily ceiling (no one burns the month in an afternoon) and a monthly one
 * (heavy users stay profitable). When it runs out, chat keeps working on the
 * free models until the allowance resets; voice and the live interpreter, which
 * have no free equivalent here, pause.
 *
 * Token costs come from the usage the gateway logs for every successful call
 * (lib/request-log.ts withUsageMeter), so they track real consumption. Media
 * without token usage (images, transcription, live interpreting) is charged a
 * fixed estimate per request or per block of minutes.
 *
 * Prices: official API price pages, checked 2026-11-15 (USD per 1M tokens).
 * Estimates err high: token costs carry a 20% margin, because streamed input
 * is counted by estimate and Claude's tokenizer runs above that estimate.
 */
import { getDb } from '../db/index.js';

export interface PremiumPrice {
  inputPerM: number;
  outputPerM: number;
  /** Fixed per-call fee (web searches the Agent API runs, for example). */
  perRequest?: number;
}

const PREMIUM_PLATFORMS = new Set(['anthropic', 'openai', 'perplexity']);

export const PREMIUM_PRICES: Record<string, PremiumPrice> = {
  'anthropic:claude-fable-5-2': { inputPerM: 8, outputPerM: 40 },
  'anthropic:claude-opus-5-5': { inputPerM: 4, outputPerM: 20 },
  'anthropic:claude-sonnet-5-5': { inputPerM: 2, outputPerM: 10 },
  // $0.10/$0.50 up to a 100K-token prompt; public chat history is trimmed well below that.
  'anthropic:claude-haiku-5-5': { inputPerM: 0.10, outputPerM: 0.50 },
  'openai:gpt-6.1-sol': { inputPerM: 2, outputPerM: 10 },
  'openai:gpt-6.1-terra': { inputPerM: 1, outputPerM: 5 },
  'openai:gpt-6-luna': { inputPerM: 0.10, outputPerM: 0.50 },
  // Agent API effort levels: model tokens plus about $0.001 per web search.
  'perplexity:fast': { inputPerM: 0.20, outputPerM: 1.00, perRequest: 0.002 },
  'perplexity:low': { inputPerM: 0.10, outputPerM: 0.50, perRequest: 0.003 },
  'perplexity:medium': { inputPerM: 0.10, outputPerM: 0.50, perRequest: 0.005 },
};

/** Unknown premium models (an operator's ELPGPT_SUBSCRIBER_ROUTES entry, say)
 *  are charged at the most expensive known rate rather than for free. */
const UNKNOWN_PREMIUM: PremiumPrice = { inputPerM: 8, outputPerM: 40, perRequest: 0.01 };
const COST_SAFETY_FACTOR = 1.2;

/** Fixed estimates for premium media, in USD. */
export const MEDIA_COSTS = {
  /** GPT Image 2.6 Flare, 1024x1024 at medium quality (~$0.044) plus prompt. */
  image: 0.05,
  /** gpt-transcribe at $0.0045/min; a dictated message is well under a minute. */
  transcription: 0.005,
  /** gpt-realtime-translate is billed per minute. */
  livePerMinute: 0.034,
} as const;

/** The live interpreter is charged ahead, in blocks of this many minutes. */
export const LIVE_BLOCK_MINUTES = 5;

export function liveBlockCostMicros(sessions = 1): number {
  return toMicros(MEDIA_COSTS.livePerMinute * LIVE_BLOCK_MINUTES * sessions);
}

function toMicros(usd: number): number {
  return Math.ceil(usd * 1_000_000);
}

/** Estimated cost of one logged call, in millionths of a dollar. Free-pool
 *  platforms cost the operator nothing and return 0. */
export function premiumCostMicros(platform: string, modelId: string, inputTokens: number, outputTokens: number): number {
  if (!PREMIUM_PLATFORMS.has(platform)) return 0;
  const price = PREMIUM_PRICES[`${platform}:${modelId}`] ?? UNKNOWN_PREMIUM;
  const tokens = (Math.max(0, inputTokens) * price.inputPerM + Math.max(0, outputTokens) * price.outputPerM) / 1_000_000;
  return toMicros(tokens * COST_SAFETY_FACTOR + (price.perRequest ?? 0));
}

export function mediaCostMicros(kind: 'image' | 'transcription'): number {
  return toMicros(MEDIA_COSTS[kind]);
}

/** USD from env; "unlimited" or "off" removes the cap. */
function envUsd(name: string, fallback: number): number {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === 'unlimited' || raw === 'off') return Number.POSITIVE_INFINITY;
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function allowanceLimits(): { dailyMicros: number; monthlyMicros: number } {
  const daily = envUsd('ELPGPT_PREMIUM_DAILY_USD', 1);
  const monthly = envUsd('ELPGPT_PREMIUM_MONTHLY_USD', 4);
  return {
    dailyMicros: Number.isFinite(daily) ? toMicros(daily) : Number.POSITIVE_INFINITY,
    monthlyMicros: Number.isFinite(monthly) ? toMicros(monthly) : Number.POSITIVE_INFINITY,
  };
}

export interface PremiumAllowance {
  dayUsedMicros: number;
  monthUsedMicros: number;
  dailyLimitMicros: number;
  monthlyLimitMicros: number;
  /** Which ceiling is used up, if any (the month wins: it resets later). */
  exhausted: 'day' | 'month' | null;
  /** Share left of the tighter ceiling, 0..1. */
  remaining: number;
  /** The tighter ceiling right now. */
  period: 'day' | 'month';
  /** When that ceiling resets (UTC). */
  resetsAt: string;
}

function dayKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function nextUtcMidnight(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}

function nextUtcMonth(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

function share(used: number, limit: number): number {
  if (!Number.isFinite(limit)) return 1;
  if (limit <= 0) return 0;
  return Math.max(0, Math.min(1, 1 - used / limit));
}

export function premiumAllowance(subject: string, now = new Date()): PremiumAllowance {
  const db = getDb();
  const day = dayKey(now);
  const monthStart = `${day.slice(0, 7)}-01`;
  const dayRow = db.prepare('SELECT premium_micros FROM elp_usage WHERE subject = ? AND day = ?').get(subject, day) as { premium_micros: number } | undefined;
  const monthRow = db.prepare('SELECT COALESCE(SUM(premium_micros), 0) AS total FROM elp_usage WHERE subject = ? AND day >= ? AND day <= ?')
    .get(subject, monthStart, day) as { total: number };
  const { dailyMicros, monthlyMicros } = allowanceLimits();
  const dayUsed = dayRow?.premium_micros ?? 0;
  const monthUsed = monthRow.total;
  const dayShare = share(dayUsed, dailyMicros);
  const monthShare = share(monthUsed, monthlyMicros);
  const exhausted = monthShare <= 0 ? 'month' : dayShare <= 0 ? 'day' : null;
  const period = exhausted ?? (monthShare < dayShare ? 'month' : 'day');
  return {
    dayUsedMicros: dayUsed,
    monthUsedMicros: monthUsed,
    dailyLimitMicros: dailyMicros,
    monthlyLimitMicros: monthlyMicros,
    exhausted,
    remaining: Math.min(dayShare, monthShare),
    period,
    resetsAt: (period === 'month' ? nextUtcMonth(now) : nextUtcMidnight(now)).toISOString(),
  };
}

/** Whether a known cost fits in what is left of both ceilings. */
export function canAfford(subject: string, micros: number, now = new Date()): boolean {
  const a = premiumAllowance(subject, now);
  return a.dayUsedMicros + micros <= a.dailyLimitMicros && a.monthUsedMicros + micros <= a.monthlyLimitMicros;
}

export function recordPremiumSpend(subject: string, micros: number, now = new Date()): void {
  if (!(micros > 0)) return;
  getDb().prepare(`
    INSERT INTO elp_usage (subject, day, messages, premium_micros) VALUES (?, ?, 0, ?)
    ON CONFLICT(subject, day) DO UPDATE SET premium_micros = premium_micros + excluded.premium_micros
  `).run(subject, dayKey(now), Math.ceil(micros));
}

/** The allowance as the subscriber sees it: shares and reset time, no dollars. */
export function publicAllowance(a: PremiumAllowance) {
  return { remaining: Math.round(a.remaining * 100) / 100, period: a.period, exhausted: a.exhausted, resetsAt: a.resetsAt };
}
