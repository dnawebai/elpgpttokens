// Migration: Stripe billing state on ELPGPT members
// Created: 2026-11-15
//
// DOWN: reversible (drops the added columns and index)
//
// Members subscribe through Stripe Checkout; Stripe webhooks keep the plan in
// sync. The Stripe customer is created before Checkout so every webhook can be
// mapped back to a member, whatever order Stripe delivers events in.
//
// plan_source records who granted the current plan: 'manual' (the operator,
// from Chat -> Members) or 'stripe' (an active subscription). A lapsed Stripe
// subscription only downgrades a plan that Stripe granted, so an operator's
// manual grant is never revoked by billing.

import type { Db } from '../types.js';

// Re-runnable, like the repo's other ADD COLUMN migrations: boot may replay
// migrations over an existing database.
const COLUMNS: [name: string, definition: string][] = [
  ['plan_source', "TEXT NOT NULL DEFAULT 'manual'"],
  ['stripe_customer_id', 'TEXT'],
  ['stripe_subscription_id', 'TEXT'],
  ['subscription_status', 'TEXT'],
  ['subscription_period_end', 'INTEGER'],
];

function hasColumn(db: Db, table: string, column: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return columns.some((candidate) => candidate.name === column);
}

export function up(db: Db): void {
  for (const [name, definition] of COLUMNS) {
    if (!hasColumn(db, 'elp_members', name)) db.prepare(`ALTER TABLE elp_members ADD COLUMN ${name} ${definition}`).run();
  }
  db.prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_elp_members_stripe_customer ON elp_members(stripe_customer_id) WHERE stripe_customer_id IS NOT NULL').run();
}

export function down(db: Db): void {
  db.prepare('DROP INDEX IF EXISTS idx_elp_members_stripe_customer').run();
  for (const [name] of [...COLUMNS].reverse()) {
    if (hasColumn(db, 'elp_members', name)) db.prepare(`ALTER TABLE elp_members DROP COLUMN ${name}`).run();
  }
}
