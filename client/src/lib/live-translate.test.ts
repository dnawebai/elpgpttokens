import { describe, it, expect } from 'vitest'
import { applyLiveEvent, EMPTY_TRANSCRIPT, conversationLanes, laneInputEnabled, combineStatus, rmsLevel } from './live-translate'

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

describe('conversation mode', () => {
  it('runs one session per direction, each into the other person\'s language', () => {
    expect(conversationLanes('room', 'en', 'es')).toEqual([
      { speaker: 'you', source: 'mic', targetLanguage: 'es' },
      { speaker: 'them', source: 'mic', targetLanguage: 'en' },
    ])
    // In a call their voice comes from the call's tab, yours from the mic.
    expect(conversationLanes('call', 'pt', 'fr').map(l => [l.speaker, l.source, l.targetLanguage])).toEqual([
      ['you', 'mic', 'fr'],
      ['them', 'tab', 'pt'],
    ])
  })

  it('in one room, opens the shared microphone only to whoever\'s turn it is', () => {
    expect(laneInputEnabled('room', 'you', 'you', false)).toBe(true)
    expect(laneInputEnabled('room', 'them', 'you', false)).toBe(false)
    expect(laneInputEnabled('room', 'them', 'them', false)).toBe(true)
    expect(laneInputEnabled('room', 'you', null, false)).toBe(false)
  })

  it('holds the microphone back while the other side\'s translation plays aloud', () => {
    expect(laneInputEnabled('room', 'them', 'them', true)).toBe(false)
  })

  it('in a call, both directions always listen: their sources are separate', () => {
    expect(laneInputEnabled('call', 'you', null, true)).toBe(true)
    expect(laneInputEnabled('call', 'them', null, true)).toBe(true)
  })

  it('combines the two sessions\' states', () => {
    expect(combineStatus('live', 'live')).toBe('live')
    expect(combineStatus('live', 'connecting')).toBe('connecting')
    expect(combineStatus('idle', 'idle')).toBe('idle')
    expect(combineStatus('live', 'error')).toBe('error')
    expect(combineStatus('stopping', 'live')).toBe('stopping')
  })

  it('measures audio level as RMS', () => {
    expect(rmsLevel([])).toBe(0)
    expect(rmsLevel(new Float32Array(512))).toBe(0)
    expect(rmsLevel([0.5, -0.5, 0.5, -0.5])).toBeCloseTo(0.5)
  })
})
