import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDb } from '../../db/index.js';
import {
  premiumCostMicros, premiumAllowance, recordPremiumSpend, canAfford, publicAllowance,
  liveBlockCostMicros, mediaCostMicros,
} from '../../services/premium-usage.js';

const ENV = ['ELPGPT_PREMIUM_DAILY_USD', 'ELPGPT_PREMIUM_MONTHLY_USD'];
const NOV_15 = new Date('2026-11-15T13:00:00Z');

beforeEach(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  for (const k of ENV) delete process.env[k];
  initDb(':memory:');
});
afterEach(() => { for (const k of ENV) delete process.env[k]; });

describe('premiumCostMicros', () => {
  it('prices tokens per model, with a 20% margin', () => {
    // Sonnet 5.5: 1K in at $2/M + 1K out at $10/M = $0.012, x1.2 = $0.0144
    expect(premiumCostMicros('anthropic', 'claude-sonnet-5-5', 1000, 1000)).toBe(14_400);
    // Haiku 5.5 is a twentieth of that
    expect(premiumCostMicros('anthropic', 'claude-haiku-5-5', 1000, 1000)).toBe(720);
  });

  it('adds per-call fees (web searches) and costs the free pool nothing', () => {
    expect(premiumCostMicros('perplexity', 'fast', 0, 0)).toBe(2_000);
    expect(premiumCostMicros('groq', 'llama-3.3-70b-versatile', 50_000, 5_000)).toBe(0);
  });

  it('charges unknown premium models at the most expensive rate, never free', () => {
    expect(premiumCostMicros('anthropic', 'claude-new-model', 1000, 1000)).toBe(premiumCostMicros('anthropic', 'claude-fable-5-2', 1000, 1000) + 10_000);
  });

  it('prices media and live blocks', () => {
    expect(mediaCostMicros('image')).toBe(50_000);
    expect(liveBlockCostMicros()).toBe(170_000); // 5 min x $0.034
    expect(liveBlockCostMicros(2)).toBe(340_000);
  });
});

describe('premiumAllowance', () => {
  it('starts full with the default $1/day and $4/month', () => {
    const a = premiumAllowance('m:1', NOV_15);
    expect(a).toMatchObject({ dayUsedMicros: 0, monthUsedMicros: 0, dailyLimitMicros: 1_000_000, monthlyLimitMicros: 4_000_000, exhausted: null, remaining: 1, period: 'day' });
    expect(a.resetsAt).toBe('2026-11-16T00:00:00.000Z');
  });

  it('runs out for the day, then resets at UTC midnight', () => {
    recordPremiumSpend('m:1', 600_000, NOV_15);
    expect(premiumAllowance('m:1', NOV_15).remaining).toBeCloseTo(0.4);
    expect(canAfford('m:1', 400_000, NOV_15)).toBe(true);
    expect(canAfford('m:1', 400_001, NOV_15)).toBe(false);
    recordPremiumSpend('m:1', 450_000, NOV_15);
    expect(premiumAllowance('m:1', NOV_15)).toMatchObject({ exhausted: 'day', remaining: 0 });
    const tomorrow = new Date('2026-11-16T09:00:00Z');
    expect(premiumAllowance('m:1', tomorrow)).toMatchObject({ exhausted: null, dayUsedMicros: 0, monthUsedMicros: 1_050_000 });
  });

  it('runs out for the month across days, and the month cap wins', () => {
    for (let d = 1; d <= 4; d++) recordPremiumSpend('m:1', 1_000_000, new Date(`2026-11-0${d}T12:00:00Z`));
    const a = premiumAllowance('m:1', NOV_15);
    expect(a).toMatchObject({ exhausted: 'month', period: 'month', remaining: 0, resetsAt: '2026-12-01T00:00:00.000Z' });
    // Last month's spend doesn't count.
    recordPremiumSpend('m:2', 3_900_000, new Date('2026-10-31T12:00:00Z'));
    expect(premiumAllowance('m:2', NOV_15).exhausted).toBeNull();
  });

  it('reports the tighter ceiling as the period', () => {
    process.env.ELPGPT_PREMIUM_MONTHLY_USD = '1.5';
    recordPremiumSpend('m:1', 1_000_000, new Date('2026-11-10T12:00:00Z'));
    recordPremiumSpend('m:1', 200_000, NOV_15);
    const a = premiumAllowance('m:1', NOV_15);
    expect(a.period).toBe('month'); // 20% of the month left vs 80% of the day
    expect(publicAllowance(a)).toEqual({ remaining: 0.2, period: 'month', exhausted: null, resetsAt: '2026-12-01T00:00:00.000Z' });
  });

  it('"unlimited" removes a cap', () => {
    process.env.ELPGPT_PREMIUM_DAILY_USD = 'unlimited';
    process.env.ELPGPT_PREMIUM_MONTHLY_USD = 'unlimited';
    recordPremiumSpend('m:1', 50_000_000, NOV_15);
    expect(premiumAllowance('m:1', NOV_15)).toMatchObject({ exhausted: null, remaining: 1 });
    expect(canAfford('m:1', 10_000_000, NOV_15)).toBe(true);
  });
});
