// Client for the public elpgpt.com/chat API (/api/public/*): visitors and
// members, never the dashboard session. The member token lives in its own
// storage key and travels in `x-member-token`, so it can never be mistaken for
// (or clear) an operator's dashboard token.

const BASE = import.meta.env.BASE_URL.replace(/\/$/, '')
export const MEMBER_TOKEN_KEY = 'elpgpt_member_token'

export type AccessTier = 'visitor' | 'free' | 'subscriber'

export interface PublicStatus {
  enabled: boolean
  signupEnabled?: boolean
  tier?: AccessTier
  member?: { email: string; plan: 'free' | 'subscriber' } | null
  quota?: { limit: number; used: number; remaining: number }
  limits?: Record<AccessTier, number>
  features?: { premium: boolean; voice: boolean; liveTranslate: boolean }
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
