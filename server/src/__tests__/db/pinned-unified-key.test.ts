import { describe, it, expect, afterEach, vi } from 'vitest';

const PINNED = 'freellmapi-' + 'a'.repeat(48);

afterEach(() => {
  delete process.env.FREEAPI_UNIFIED_API_KEY;
  vi.resetModules();
});

describe('FREEAPI_UNIFIED_API_KEY', () => {
  it('accepts only a value of 32+ characters without whitespace', async () => {
    const { pinnedUnifiedApiKey } = await import('../../db/index.js');
    expect(pinnedUnifiedApiKey({ FREEAPI_UNIFIED_API_KEY: PINNED })).toBe(PINNED);
    expect(pinnedUnifiedApiKey({ FREEAPI_UNIFIED_API_KEY: '  ' + PINNED + '\n' })).toBe(PINNED);
    expect(pinnedUnifiedApiKey({ FREEAPI_UNIFIED_API_KEY: 'short' })).toBeNull();
    expect(pinnedUnifiedApiKey({ FREEAPI_UNIFIED_API_KEY: 'a'.repeat(20) + ' ' + 'b'.repeat(20) })).toBeNull();
    expect(pinnedUnifiedApiKey({})).toBeNull();
  });

  it('wins over the stored key, and the stored key is used when it is unset', async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    const { initDb, getUnifiedApiKey } = await import('../../db/index.js');
    initDb(':memory:');
    const stored = getUnifiedApiKey();
    expect(stored).toMatch(/^freellmapi-/);
    process.env.FREEAPI_UNIFIED_API_KEY = PINNED;
    expect(getUnifiedApiKey()).toBe(PINNED);
    delete process.env.FREEAPI_UNIFIED_API_KEY;
    expect(getUnifiedApiKey()).toBe(stored);
  });
});
