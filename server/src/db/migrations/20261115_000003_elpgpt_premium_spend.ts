// Migration: premium spend per public chat subject per day
// Created: 2026-11-15
//
// DOWN: reversible (drops the column)
//
// Subscribers get a premium allowance measured in estimated provider cost
// (services/premium-usage.ts). Spend is stored next to the daily message
// count, in millionths of a US dollar, so a day's and a month's spend are a
// row lookup and a SUM over the month's rows. Re-runnable, like the other
// ADD COLUMN migrations: boot may replay migrations over an existing database.

import type { Db } from '../types.js';

function hasColumn(db: Db, table: string, column: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return columns.some((candidate) => candidate.name === column);
}

export function up(db: Db): void {
  if (!hasColumn(db, 'elp_usage', 'premium_micros')) {
    db.prepare('ALTER TABLE elp_usage ADD COLUMN premium_micros INTEGER NOT NULL DEFAULT 0').run();
  }
}

export function down(db: Db): void {
  if (hasColumn(db, 'elp_usage', 'premium_micros')) {
    db.prepare('ALTER TABLE elp_usage DROP COLUMN premium_micros').run();
  }
}
