// Client for the public elpgpt.com/chat API (/api/public/*): visitors and
// members, never the dashboard session. The member token lives in its own
// storage key and travels in `x-member-token`, so it can never be mistaken for
// (or clear) an operator's dashboard token.

const BASE = import.meta.env.BASE_URL.replace(/\/$/, '')
export const MEMBER_TOKEN_KEY = 'elpgpt_member_token'

export type AccessTier = 'visitor' | 'free' | 'subscriber'

export interface PublicSubscription {
  /** Stripe's subscription status: active, trialing, past_due, canceled… */
  status: string
  /** Unix seconds when the current billing period ends. */
  periodEnd: number | null
  /** Who granted the current plan: a Stripe subscription or the operator. */
  source: 'stripe' | 'manual'
}

export interface PublicStatus {
  enabled: boolean
  signupEnabled?: boolean
  tier?: AccessTier
  member?: {
    email: string
    plan: 'free' | 'subscriber'
    subscription?: PublicSubscription | null
    canManageBilling?: boolean
  } | null
  quota?: { limit: number; used: number; remaining: number }
  limits?: Record<AccessTier, number>
  features?: { premium: boolean; voice: boolean; liveTranslate: boolean }
  billing?: { enabled: boolean }
  /** Subscribers: what is left of the premium allowance (shares, never dollars). */
  allowance?: PublicAllowance | null
}

export interface PublicAllowance {
  /** Share left of the tighter ceiling, 0..1. */
  remaining: number
  period: 'day' | 'month'
  exhausted: 'day' | 'month' | null
  /** ISO time the tighter (or used-up) ceiling resets. */
  resetsAt: string
}

/** The server charges the live interpreter ahead in 5-minute blocks
 *  (LIVE_BLOCK_MINUTES); the next block is asked for a little early. */
export const LIVE_KEEPALIVE_MS = 5 * 60_000 - 20_000

/** "Premium 72% left today" data, clamped and safe on missing fields. */
export function allowanceSummary(a: PublicAllowance | null | undefined): { pct: number; period: 'day' | 'month'; exhausted: 'day' | 'month' | null; resetsAt: Date } | null {
  if (!a) return null
  const resetsAt = new Date(a.resetsAt)
  return {
    pct: Math.max(0, Math.min(100, Math.round(a.remaining * 100))),
    period: a.period === 'month' ? 'month' : 'day',
    exhausted: a.exhausted === 'day' || a.exhausted === 'month' ? a.exhausted : null,
    resetsAt: Number.isNaN(resetsAt.getTime()) ? new Date() : resetsAt,
  }
}

export type BillingInterval = 'month' | 'year'

export interface BillingPrice {
  interval: BillingInterval
  /** In the currency's smallest unit, as Stripe stores it; null if unknown. */
  amount: number | null
  currency: string | null
}

export class PublicApiError extends Error {
  readonly status: number
  readonly code?: string
  constructor(message: string, status: number, code?: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

export function getMemberToken(): string | null {
  try { return localStorage.getItem(MEMBER_TOKEN_KEY) } catch { return null }
}

export function setMemberToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(MEMBER_TOKEN_KEY, token)
    else localStorage.removeItem(MEMBER_TOKEN_KEY)
  } catch { /* storage blocked */ }
}

export function publicHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const token = getMemberToken()
  return { ...extra, ...(token ? { 'x-member-token': token } : {}) }
}

export function publicUrl(path: string): string {
  return `${BASE}${path}`
}

/** JSON request to /api/public; throws PublicApiError with the server's code. */
export async function publicFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(publicUrl(path), {
    ...init,
    headers: publicHeaders({ ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...(init.headers as Record<string, string> | undefined) }),
  })
  const body = await res.json().catch(() => null)
  if (!res.ok) {
    throw new PublicApiError(body?.error?.message ?? `HTTP ${res.status}`, res.status, body?.error?.code)
  }
  return body as T
}

/** "7 of 10 left today" data, clamped and safe on missing fields. */
export function quotaSummary(status: PublicStatus | undefined): { remaining: number; limit: number; low: boolean } | null {
  if (!status?.quota) return null
  const { remaining, limit } = status.quota
  return { remaining: Math.max(0, remaining), limit, low: limit > 0 && remaining / limit <= 0.2 }
}

// ── Billing ────────────────────────────────────────────────────────────────

/**
 * "$15.00" from Stripe's smallest-unit amount. The divisor comes from the
 * currency itself, so zero-decimal currencies (JPY, KRW…) are not divided.
 */
export function formatPrice(price: BillingPrice, locale: string): string | null {
  if (price.amount === null || !price.currency) return null
  try {
    const format = new Intl.NumberFormat(locale, { style: 'currency', currency: price.currency.toUpperCase() })
    const digits = format.resolvedOptions().maximumFractionDigits ?? 2
    return format.format(price.amount / 10 ** digits)
  } catch {
    return null
  }
}

/** The outcome Stripe Checkout sent the browser back with, if any. */
export function readBillingReturn(search: string): 'success' | 'cancel' | null {
  const value = new URLSearchParams(search).get('billing')
  return value === 'success' || value === 'cancel' ? value : null
}

/** A Stripe-hosted page URL from the server; anything but https is refused. */
function hostedPage(url: unknown): string {
  if (typeof url !== 'string' || !url.startsWith('https://')) throw new PublicApiError('Invalid payment page', 502, 'stripe_error')
  return url
}

export async function startCheckout(interval: BillingInterval): Promise<string> {
  const res = await publicFetch<{ url: string }>('/api/public/billing/checkout', { method: 'POST', body: JSON.stringify({ interval }) })
  return hostedPage(res.url)
}

export async function openBillingPortal(): Promise<string> {
  const res = await publicFetch<{ url: string }>('/api/public/billing/portal', { method: 'POST' })
  return hostedPage(res.url)
}
