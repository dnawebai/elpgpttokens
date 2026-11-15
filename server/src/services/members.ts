/**
 * Public elpgpt.com/chat access: members, plans and daily quotas.
 *
 * Three tiers, all served by the same `elpgpt-auto` router:
 *
 *   visitor     no account; free models only; ELPGPT_VISITOR_DAILY_LIMIT/day
 *   free        signed-in member; free models; ELPGPT_FREE_DAILY_LIMIT/day
 *   subscriber  premium models (Claude, GPT, Perplexity, GPT Image) and the
 *               live interpreter; ELPGPT_SUBSCRIBER_DAILY_LIMIT/day
 *
 * The whole surface is OFF unless ELPGPT_PUBLIC_CHAT is set: exposing an
 * install to anonymous visitors spends the operator's quota, so it must be a
 * deliberate choice. Members are not dashboard users and have their own tables
 * and sessions; a member token can never open /api/*. Billing is not wired
 * yet: the operator marks a member as a subscriber from the dashboard.
 */
import crypto from 'node:crypto';
import { getDb, getUnifiedApiKey } from '../db/index.js';
import { hashPassword, verifyPassword } from '../lib/password.js';
import { normalizeEmail } from './auth.js';

export type MemberPlan = 'free' | 'subscriber';
export type AccessTier = 'visitor' | MemberPlan;

export interface Member {
  id: number;
  email: string;
  plan: MemberPlan;
  disabled: boolean;
  createdAt: string;
}

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function envFlag(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  return ['1', 'true', 'on', 'yes'].includes(raw);
}

function envInt(name: string, fallback: number): number {
  const raw = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

export function publicChatEnabled(): boolean {
  return envFlag('ELPGPT_PUBLIC_CHAT', false);
}

export function publicSignupEnabled(): boolean {
  return publicChatEnabled() && envFlag('ELPGPT_PUBLIC_SIGNUP', true);
}

export function dailyLimit(tier: AccessTier): number {
  switch (tier) {
    case 'visitor': return envInt('ELPGPT_VISITOR_DAILY_LIMIT', 10);
    case 'free': return envInt('ELPGPT_FREE_DAILY_LIMIT', 30);
    case 'subscriber': return envInt('ELPGPT_SUBSCRIBER_DAILY_LIMIT', 300);
  }
}

/** Premium models and the live interpreter are subscriber-only. */
export function tierAllowsPremium(tier: AccessTier): boolean {
  return tier === 'subscriber';
}

export class MemberError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message);
  }
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function toMember(row: { id: number; email: string; plan: string; disabled: number; created_at: string }): Member {
  return { id: row.id, email: row.email, plan: row.plan === 'subscriber' ? 'subscriber' : 'free', disabled: row.disabled === 1, createdAt: row.created_at };
}

const MEMBER_COLUMNS = 'id, email, plan, disabled, created_at';

export function createMember(email: string, password: string): Member {
  const normalized = normalizeEmail(email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) throw new MemberError('A valid email is required', 400, 'invalid_email');
  if (password.length < 8) throw new MemberError('Password must be at least 8 characters', 400, 'weak_password');
  const db = getDb();
  if (db.prepare('SELECT 1 FROM elp_members WHERE email = ?').get(normalized)) {
    throw new MemberError('An account with this email already exists', 409, 'email_taken');
  }
  const id = Number(db.prepare('INSERT INTO elp_members (email, password_hash) VALUES (?, ?)').run(normalized, hashPassword(password)).lastInsertRowid);
  return getMember(id)!;
}

export function verifyMember(email: string, password: string): Member | null {
  const row = getDb().prepare(`SELECT ${MEMBER_COLUMNS}, password_hash FROM elp_members WHERE email = ?`)
    .get(normalizeEmail(email)) as (Parameters<typeof toMember>[0] & { password_hash: string }) | undefined;
  if (!row || !verifyPassword(password, row.password_hash)) return null;
  return toMember(row);
}

export function getMember(id: number): Member | null {
  const row = getDb().prepare(`SELECT ${MEMBER_COLUMNS} FROM elp_members WHERE id = ?`).get(id) as Parameters<typeof toMember>[0] | undefined;
  return row ? toMember(row) : null;
}

export function listMembers(): Member[] {
  return (getDb().prepare(`SELECT ${MEMBER_COLUMNS} FROM elp_members ORDER BY id DESC`).all() as Parameters<typeof toMember>[0][]).map(toMember);
}

export function updateMember(id: number, patch: { plan?: MemberPlan; disabled?: boolean }): Member | null {
  const db = getDb();
  if (patch.plan) db.prepare('UPDATE elp_members SET plan = ? WHERE id = ?').run(patch.plan, id);
  if (patch.disabled !== undefined) {
    db.prepare('UPDATE elp_members SET disabled = ? WHERE id = ?').run(patch.disabled ? 1 : 0, id);
    // A disabled member is signed out everywhere at once.
    if (patch.disabled) db.prepare('DELETE FROM elp_member_sessions WHERE member_id = ?').run(id);
  }
  return getMember(id);
}

export function createMemberSession(memberId: number): string {
  const token = `elpm_${crypto.randomBytes(32).toString('hex')}`;
  getDb().prepare('INSERT INTO elp_member_sessions (token_hash, member_id, expires_at_ms) VALUES (?, ?, ?)')
    .run(sha256(token), memberId, Date.now() + SESSION_TTL_MS);
  return token;
}

/** The member behind a session token, or null (missing, expired, disabled). */
export function memberForToken(token: string | undefined | null): Member | null {
  if (!token || !token.startsWith('elpm_')) return null;
  const db = getDb();
  const row = db.prepare('SELECT member_id, expires_at_ms FROM elp_member_sessions WHERE token_hash = ?')
    .get(sha256(token)) as { member_id: number; expires_at_ms: number } | undefined;
  if (!row) return null;
  if (row.expires_at_ms < Date.now()) {
    db.prepare('DELETE FROM elp_member_sessions WHERE token_hash = ?').run(sha256(token));
    return null;
  }
  const member = getMember(row.member_id);
  return member && !member.disabled ? member : null;
}

export function deleteMemberSession(token: string): void {
  getDb().prepare('DELETE FROM elp_member_sessions WHERE token_hash = ?').run(sha256(token));
}

/**
 * A visitor's quota subject: a keyed hash of the client IP, so the raw address
 * is never stored and the hash is useless outside this install.
 */
export function visitorSubject(ip: string): string {
  const digest = crypto.createHmac('sha256', getUnifiedApiKey()).update(ip || 'unknown').digest('hex');
  return `v:${digest.slice(0, 32)}`;
}

export function memberSubject(member: Member): string {
  return `m:${member.id}`;
}

function today(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export interface QuotaState {
  limit: number;
  used: number;
  remaining: number;
}

export function quotaState(subject: string, tier: AccessTier): QuotaState {
  const row = getDb().prepare('SELECT messages FROM elp_usage WHERE subject = ? AND day = ?').get(subject, today()) as { messages: number } | undefined;
  const limit = dailyLimit(tier);
  const used = row?.messages ?? 0;
  return { limit, used, remaining: Math.max(0, limit - used) };
}

/** Atomically spend one message from today's quota. */
export function consumeMessage(subject: string, tier: AccessTier): QuotaState & { allowed: boolean } {
  const db = getDb();
  const limit = dailyLimit(tier);
  return db.transaction(() => {
    const day = today();
    const row = db.prepare('SELECT messages FROM elp_usage WHERE subject = ? AND day = ?').get(subject, day) as { messages: number } | undefined;
    const used = row?.messages ?? 0;
    if (used >= limit) return { allowed: false, limit, used, remaining: 0 };
    db.prepare(`
      INSERT INTO elp_usage (subject, day, messages) VALUES (?, ?, 1)
      ON CONFLICT(subject, day) DO UPDATE SET messages = messages + 1
    `).run(subject, day);
    return { allowed: true, limit, used: used + 1, remaining: Math.max(0, limit - used - 1) };
  })();
}
