// @vitest-environment jsdom
//
// Member tokens live in localStorage, so these tests need a DOM storage.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getMemberToken, setMemberToken, publicHeaders, publicFetch, PublicApiError, quotaSummary } from './public-api'

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
