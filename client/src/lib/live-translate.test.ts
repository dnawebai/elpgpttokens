import { describe, it, expect } from 'vitest'
import { applyLiveEvent, EMPTY_TRANSCRIPT } from './live-translate'

describe('applyLiveEvent', () => {
  it('accumulates source and translated transcript deltas separately', () => {
    let s = EMPTY_TRANSCRIPT
    s = applyLiveEvent(s, { type: 'session.input_transcript.delta', delta: '¿Dónde está ' })
    s = applyLiveEvent(s, { type: 'session.output_transcript.delta', delta: 'Where is ' })
    s = applyLiveEvent(s, { type: 'session.input_transcript.delta', delta: 'la estación?' })
    s = applyLiveEvent(s, { type: 'session.output_transcript.delta', delta: 'the station?' })
    expect(s).toEqual({ source: '¿Dónde está la estación?', translated: 'Where is the station?', closed: false })
  })

  it('ignores unknown events and malformed deltas without copying state', () => {
    const s = { ...EMPTY_TRANSCRIPT, source: 'a' }
    expect(applyLiveEvent(s, { type: 'session.created' })).toBe(s)
    expect(applyLiveEvent(s, { type: 'session.output_transcript.delta', delta: 42 })).toEqual(s)
    expect(applyLiveEvent(s, null)).toBe(s)
  })

  it('records errors by message, falling back to the code', () => {
    expect(applyLiveEvent(EMPTY_TRANSCRIPT, { type: 'error', error: { message: 'quota exceeded' } }).error).toBe('quota exceeded')
    expect(applyLiveEvent(EMPTY_TRANSCRIPT, { type: 'error', error: { code: 'session_expired' } }).error).toBe('session_expired')
    expect(applyLiveEvent(EMPTY_TRANSCRIPT, { type: 'error' }).error).toBe('Translation error')
  })

  it('marks the session closed', () => {
    expect(applyLiveEvent(EMPTY_TRANSCRIPT, { type: 'session.closed' }).closed).toBe(true)
  })

  it('caps long transcripts, keeping the most recent text', () => {
    let s = EMPTY_TRANSCRIPT
    for (let i = 0; i < 100; i++) s = applyLiveEvent(s, { type: 'session.output_transcript.delta', delta: 'x'.repeat(100) })
    s = applyLiveEvent(s, { type: 'session.output_transcript.delta', delta: 'END' })
    expect(s.translated.length).toBeLessThanOrEqual(6001)
    expect(s.translated.startsWith('…')).toBe(true)
    expect(s.translated.endsWith('END')).toBe(true)
  })
})
