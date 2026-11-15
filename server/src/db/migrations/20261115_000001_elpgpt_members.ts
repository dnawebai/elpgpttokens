// Migration: ELPGPT public chat members, sessions and daily usage
// Created: 2026-11-15
//
// DOWN: reversible (drops the three ELPGPT tables)
//
// The dashboard has exactly one operator account (`users`). The public
// elpgpt.com/chat surface needs end users who are NOT operators: they can
// chat within their plan's daily limit and nothing else. They live in their
// own tables so a member session can never authenticate against /api/*.
//
// - elp_members: email + password hash, plan ('free' | 'subscriber'), and a
//   disabled flag the operator can set.
// - elp_member_sessions: hashed session tokens, like `sessions`.
// - elp_usage: messages per subject per UTC day. A subject is 'm:<member id>'
//   for members or 'v:<hashed ip>' for anonymous visitors (raw IPs are never
//   stored).

import type { Db } from '../types.js';

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS elp_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      plan TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'subscriber')),
      disabled INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS elp_member_sessions (
      token_hash TEXT PRIMARY KEY,
      member_id INTEGER NOT NULL REFERENCES elp_members(id) ON DELETE CASCADE,
      expires_at_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_elp_member_sessions_member ON elp_member_sessions(member_id);

    CREATE TABLE IF NOT EXISTS elp_usage (
      subject TEXT NOT NULL,
      day TEXT NOT NULL,
      messages INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (subject, day)
    );
  `);
}

export function down(db: Db): void {
  db.exec(`
    DROP TABLE IF EXISTS elp_usage;
    DROP INDEX IF EXISTS idx_elp_member_sessions_member;
    DROP TABLE IF EXISTS elp_member_sessions;
    DROP TABLE IF EXISTS elp_members;
  `);
}
