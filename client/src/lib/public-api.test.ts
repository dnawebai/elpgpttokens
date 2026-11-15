// @vitest-environment jsdom
//
// Member tokens live in localStorage, so these tests need a DOM storage.
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getMemberToken, setMemberToken, publicHeaders, publicFetch, PublicApiError, quotaSummary,
  formatPrice, readBillingReturn, startCheckout, openBillingPortal, allowanceSummary,
} from './public-api'

afterEach(() => {
  vi.restoreAllMocks()
  setMemberToken(null)
})

describe('member token', () => {
  it('stores, sends and clears the token in its own header', () => {
    expect(publicHeaders()).toEqual({})
    setMemberToken('elpm_abc')
    expect(getMemberToken()).toBe('elpm_abc')
    expect(publicHeaders({ 'Content-Type': 'application/json' })).toEqual({ 'Content-Type': 'application/json', 'x-member-token': 'elpm_abc' })
    setMemberToken(null)
    expect(getMemberToken()).toBeNull()
  })

  it('never sends the dashboard Authorization header', () => {
    localStorage.setItem('freellmapi_dashboard_token', 'dash')
    setMemberToken('elpm_x')
    expect(publicHeaders()).not.toHaveProperty('Authorization')
    localStorage.removeItem('freellmapi_dashboard_token')
  })
})

describe('publicFetch', () => {
  it('returns JSON and raises the server error code', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ enabled: true }), { status: 200 }))
    await expect(publicFetch('/api/public/status')).resolves.toEqual({ enabled: true })

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'out of messages', code: 'daily_limit_reached' } }), { status: 429 }))
    const err = await publicFetch('/api/public/chat', { method: 'POST', body: '{}' }).catch(e => e)
    expect(err).toBeInstanceOf(PublicApiError)
    expect(err).toMatchObject({ message: 'out of messages', status: 429, code: 'daily_limit_reached' })
  })
})

describe('quotaSummary', () => {
  it('flags a low remaining quota', () => {
    expect(quotaSummary({ enabled: true, quota: { limit: 10, used: 9, remaining: 1 } })).toEqual({ remaining: 1, limit: 10, low: true })
    expect(quotaSummary({ enabled: true, quota: { limit: 10, used: 2, remaining: 8 } })).toEqual({ remaining: 8, limit: 10, low: false })
    expect(quotaSummary({ enabled: true, quota: { limit: 0, used: 0, remaining: 0 } })).toEqual({ remaining: 0, limit: 0, low: false })
    expect(quotaSummary({ enabled: false })).toBeNull()
    expect(quotaSummary(undefined)).toBeNull()
  })
})

describe('billing helpers', () => {
  it('formats Stripe amounts by the currency\'s own decimals', () => {
    expect(formatPrice({ interval: 'month', amount: 1500, currency: 'usd' }, 'en-US')).toBe('$15.00')
    expect(formatPrice({ interval: 'month', amount: 1500, currency: 'jpy' }, 'en-US')).toBe('¥1,500')
    expect(formatPrice({ interval: 'year', amount: null, currency: 'usd' }, 'en-US')).toBeNull()
    expect(formatPrice({ interval: 'year', amount: 100, currency: 'not-a-currency' }, 'en-US')).toBeNull()
  })

  it('reads the Checkout return flag', () => {
    expect(readBillingReturn('?billing=success')).toBe('success')
    expect(readBillingReturn('?x=1&billing=cancel')).toBe('cancel')
    expect(readBillingReturn('?billing=pwned')).toBeNull()
    expect(readBillingReturn('')).toBeNull()
  })

  it('posts the interval and only follows https payment pages', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ url: 'https://checkout.stripe.com/c/pay/cs_1' }), { status: 200 }))
    await expect(startCheckout('year')).resolves.toBe('https://checkout.stripe.com/c/pay/cs_1')
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ interval: 'year' })

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ url: 'javascript:alert(1)' }), { status: 200 }))
    await expect(openBillingPortal()).rejects.toBeInstanceOf(PublicApiError)
  })
})

describe('allowanceSummary', () => {
  it('turns the allowance into a percentage and a reset time', () => {
    const s = allowanceSummary({ remaining: 0.724, period: 'day', exhausted: null, resetsAt: '2026-11-16T00:00:00.000Z' })
    expect(s).toMatchObject({ pct: 72, period: 'day', exhausted: null })
    expect(s?.resetsAt.toISOString()).toBe('2026-11-16T00:00:00.000Z')
    expect(allowanceSummary({ remaining: 0, period: 'month', exhausted: 'month', resetsAt: '2026-12-01T00:00:00.000Z' })).toMatchObject({ pct: 0, exhausted: 'month' })
  })

  it('clamps bad values and tolerates a missing allowance', () => {
    expect(allowanceSummary({ remaining: 1.7, period: 'day', exhausted: null, resetsAt: 'nonsense' })?.pct).toBe(100)
    expect(allowanceSummary(null)).toBeNull()
    expect(allowanceSummary(undefined)).toBeNull()
  })
})
