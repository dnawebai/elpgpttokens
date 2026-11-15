// Live interpreter for /chat: streams microphone or browser-tab audio to
// OpenAI's realtime translation model over WebRTC and plays the translated
// speech, with live source/target transcripts.
//
// The SDP handshake goes through our server (/api/elp/realtime/translate),
// which mints a short-lived OpenAI session, so no key or client secret ever
// reaches the browser and the dashboard CSP (connect-src 'self') holds. Audio
// itself flows directly between the browser and OpenAI.
//
// Two modes:
//   one-way       one session: a source (mic or tab) into one language.
//   conversation  one session per direction, as OpenAI recommends for two
//                 people: each speaker's audio into the other's language.
//                 In a video call the directions are naturally separate (their
//                 voice comes from the call's tab, yours from the mic). In one
//                 room, one microphone hears both people, so they take turns
//                 and the active speaker's microphone is held back while the
//                 other direction's translation plays, so it isn't translated
//                 again.
import { apiFetch } from './api'

export type LiveSource = 'mic' | 'tab'
export type LiveStatus = 'idle' | 'connecting' | 'live' | 'stopping' | 'error'

export interface LiveTranscript {
  /** What the speaker said, as transcribed. */
  source: string
  /** The translation, as spoken back. */
  translated: string
  error?: string
  closed: boolean
}

export const EMPTY_TRANSCRIPT: LiveTranscript = { source: '', translated: '', closed: false }

/** Keep the panels readable in a long session: trim from the front. */
const MAX_TRANSCRIPT_CHARS = 6000

function append(text: string, delta: unknown): string {
  if (typeof delta !== 'string' || !delta) return text
  const next = text + delta
  return next.length > MAX_TRANSCRIPT_CHARS ? `…${next.slice(next.length - MAX_TRANSCRIPT_CHARS)}` : next
}

/** Apply one server event from the `oai-events` data channel. Pure. */
export function applyLiveEvent(state: LiveTranscript, event: unknown): LiveTranscript {
  const e = event as { type?: string; delta?: unknown; error?: { message?: unknown; code?: unknown } }
  switch (e?.type) {
    case 'session.input_transcript.delta':
      return { ...state, source: append(state.source, e.delta) }
    case 'session.output_transcript.delta':
      return { ...state, translated: append(state.translated, e.delta) }
    case 'error': {
      const message = typeof e.error?.message === 'string' ? e.error.message
        : typeof e.error?.code === 'string' ? e.error.code : 'Translation error'
      return { ...state, error: message }
    }
    case 'session.closed':
      return { ...state, closed: true }
    default:
      return state
  }
}

export interface HandshakeRequest { sdp: string | undefined; targetLanguage: string; source: LiveSource }
export type Handshake = (req: HandshakeRequest) => Promise<{ sdp: string }>

const dashboardHandshake: Handshake = req =>
  apiFetch<{ sdp: string }>('/api/elp/realtime/translate', { method: 'POST', body: JSON.stringify(req) })

/** Chromium can keep a shared tab's own sound from playing locally. */
type TabAudioConstraints = MediaTrackConstraints & { suppressLocalAudioPlayback?: boolean }

async function captureAudio(source: LiveSource, opts: { hearOriginal?: boolean } = {}): Promise<MediaStream> {
  if (source === 'mic') {
    return navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
  }
  // Browsers only share tab audio alongside video; the video track is dropped.
  const audio: TabAudioConstraints = opts.hearOriginal === false ? { suppressLocalAudioPlayback: true } : {}
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: Object.keys(audio).length ? audio : true })
  stream.getVideoTracks().forEach(t => { t.stop(); stream.removeTrack(t) })
  if (stream.getAudioTracks().length === 0) {
    throw new Error('No audio was shared. Pick a tab and turn on "Share tab audio".')
  }
  return stream
}

// ── One direction ──────────────────────────────────────────────────────────

interface LaneOptions {
  /** The audio to translate. The lane owns it and stops it on hang-up. */
  track: MediaStreamTrack
  targetLanguage: string
  source: LiveSource
  handshake: Handshake
  onTranscript: (t: LiveTranscript) => void
  onStatus: (s: LiveStatus, detail?: string) => void
}

interface Lane {
  stop: () => Promise<void>
  setMuted: (muted: boolean) => void
  /** Whether the source audio reaches the session (a disabled track sends silence). */
  setInputEnabled: (enabled: boolean) => void
  setSinkId: (deviceId: string) => Promise<void>
  /** The translated speech, once it arrives. */
  output: () => MediaStream | null
}

async function connectLane(opts: LaneOptions): Promise<Lane> {
  let transcript: LiveTranscript = { ...EMPTY_TRANSCRIPT }
  const media = new MediaStream([opts.track])
  const pc = new RTCPeerConnection()
  const audio = new Audio()
  audio.autoplay = true
  let output: MediaStream | null = null

  const cleanup = () => {
    opts.track.stop()
    try { pc.close() } catch { /* already closed */ }
    audio.srcObject = null
  }

  try {
    pc.addTrack(opts.track, media)
    pc.ontrack = ({ streams }) => {
      output = streams[0] ?? null
      audio.srcObject = output
      void audio.play().catch(() => { /* autoplay blocked until the next gesture */ })
    }

    const events = pc.createDataChannel('oai-events')
    let resolveClosed: () => void = () => {}
    const closed = new Promise<void>(resolve => { resolveClosed = resolve })
    events.onmessage = ({ data }) => {
      let event: unknown
      try { event = JSON.parse(String(data)) } catch { return }
      transcript = applyLiveEvent(transcript, event)
      opts.onTranscript(transcript)
      if (transcript.error) opts.onStatus('error', transcript.error)
      if (transcript.closed) resolveClosed()
    }
    events.onopen = () => opts.onStatus('live')

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') opts.onStatus('error', 'The audio connection failed.')
    }

    // The tab or mic ending (e.g. "Stop sharing") ends the session.
    opts.track.addEventListener('ended', () => opts.onStatus('stopping'))

    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    const { sdp } = await opts.handshake({ sdp: offer.sdp, targetLanguage: opts.targetLanguage, source: opts.source })
    await pc.setRemoteDescription({ type: 'answer', sdp })

    return {
      setMuted: muted => { audio.muted = muted },
      setInputEnabled: enabled => { opts.track.enabled = enabled },
      setSinkId: async deviceId => {
        if (typeof audio.setSinkId === 'function') await audio.setSinkId(deviceId)
      },
      output: () => output,
      stop: async () => {
        // Ask the service to flush what it has, then hang up either way.
        if (events.readyState === 'open') {
          try { events.send(JSON.stringify({ type: 'session.close' })) } catch { /* channel gone */ }
          await Promise.race([closed, new Promise(resolve => setTimeout(resolve, 3000))])
        }
        cleanup()
      },
    }
  } catch (err) {
    cleanup()
    throw err
  }
}

// ── One-way ────────────────────────────────────────────────────────────────

export interface LiveSession {
  /** Flush pending translation, then hang up. */
  stop: () => Promise<void>
  setMuted: (muted: boolean) => void
}

export interface StartLiveOptions {
  targetLanguage: string
  source: LiveSource
  onTranscript: (t: LiveTranscript) => void
  onStatus: (s: LiveStatus, detail?: string) => void
  /** SDP exchange; defaults to the dashboard endpoint. Public chat passes its own. */
  handshake?: Handshake
}

export async function startLiveTranslation(opts: StartLiveOptions): Promise<LiveSession> {
  opts.onStatus('connecting')
  const media = await captureAudio(opts.source)
  const lane = await connectLane({
    track: media.getAudioTracks()[0],
    targetLanguage: opts.targetLanguage,
    source: opts.source,
    handshake: opts.handshake ?? dashboardHandshake,
    onTranscript: opts.onTranscript,
    onStatus: opts.onStatus,
  }).catch(err => {
    media.getTracks().forEach(t => t.stop())
    throw err
  })
  return {
    setMuted: lane.setMuted,
    stop: async () => {
      opts.onStatus('stopping')
      await lane.stop()
      opts.onStatus('idle')
    },
  }
}

// ── Conversation (two-way) ─────────────────────────────────────────────────

export type ConversationSetup = 'room' | 'call'
export type Speaker = 'you' | 'them'
export type ConversationTranscripts = Record<Speaker, LiveTranscript>

export interface LanePlan { speaker: Speaker; source: LiveSource; targetLanguage: string }

/** One session per direction: each speaker into the other's language. */
export function conversationLanes(setup: ConversationSetup, yourLanguage: string, theirLanguage: string): LanePlan[] {
  return [
    { speaker: 'you', source: 'mic', targetLanguage: theirLanguage },
    { speaker: 'them', source: setup === 'call' ? 'tab' : 'mic', targetLanguage: yourLanguage },
  ]
}

/**
 * Whether a direction's source audio should reach its session right now. In
 * a call each direction has its own source, so both always listen. In one
 * room the shared microphone goes only to the speaker whose turn it is, and
 * not while the other direction's translation is playing aloud.
 */
export function laneInputEnabled(setup: ConversationSetup, lane: Speaker, active: Speaker | null, otherPlaying: boolean): boolean {
  if (setup === 'call') return true
  return lane === active && !otherPlaying
}

/** The conversation's state from its two sessions'. */
export function combineStatus(a: LiveStatus, b: LiveStatus): LiveStatus {
  if (a === 'error' || b === 'error') return 'error'
  if (a === 'stopping' || b === 'stopping') return 'stopping'
  if (a === 'live' && b === 'live') return 'live'
  if (a === 'idle' && b === 'idle') return 'idle'
  return 'connecting'
}

/** Root-mean-square level of an audio frame, 0..1. */
export function rmsLevel(samples: ArrayLike<number>): number {
  if (samples.length === 0) return 0
  let sum = 0
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i]
  return Math.sqrt(sum / samples.length)
}

/** Translated speech louder than this counts as playing. */
const PLAYING_LEVEL = 0.015
/** Keep a speaker's microphone held back this long after playback goes quiet. */
const PLAYING_HOLD_MS = 500
const GATE_TICK_MS = 100

/** Where your translated voice goes in a call: muted, this device, or a device id. */
export const VOICE_OUTPUT_NONE = 'none'
export const VOICE_OUTPUT_DEFAULT = ''

export interface ConversationOptions {
  setup: ConversationSetup
  yourLanguage: string
  theirLanguage: string
  /** Call: keep playing the shared tab's own sound locally. Default off. */
  hearOriginal?: boolean
  /** Call: VOICE_OUTPUT_NONE, VOICE_OUTPUT_DEFAULT or an audio output device id. */
  voiceOutput?: string
  handshake?: Handshake
  onTranscripts: (t: ConversationTranscripts) => void
  onStatus: (s: LiveStatus, detail?: string) => void
  /** Room: whose microphone is open right now (null while it is held back). */
  onListening?: (speaker: Speaker | null) => void
}

export interface ConversationSession {
  stop: () => Promise<void>
  /** Room: whose turn it is. */
  setSpeaker: (speaker: Speaker | null) => void
  /** Mute what you hear. */
  setMuted: (muted: boolean) => void
  setVoiceOutput: (output: string) => Promise<void>
}

export async function startConversation(opts: ConversationOptions): Promise<ConversationSession> {
  opts.onStatus('connecting')
  const handshake = opts.handshake ?? dashboardHandshake
  const plans = conversationLanes(opts.setup, opts.yourLanguage, opts.theirLanguage)

  // The tab picker must open straight from the click, before any other await.
  const tab = opts.setup === 'call' ? await captureAudio('tab', { hearOriginal: opts.hearOriginal ?? false }) : null
  let mic: MediaStream
  try {
    mic = await captureAudio('mic')
  } catch (err) {
    tab?.getTracks().forEach(t => t.stop())
    throw err
  }
  const stopCaptures = () => {
    mic.getTracks().forEach(t => t.stop())
    tab?.getTracks().forEach(t => t.stop())
  }

  const transcripts: ConversationTranscripts = { you: { ...EMPTY_TRANSCRIPT }, them: { ...EMPTY_TRANSCRIPT } }
  const statuses: Record<Speaker, LiveStatus> = { you: 'connecting', them: 'connecting' }
  let detail: string | undefined
  let stopping = false
  const report = () => { if (!stopping) opts.onStatus(combineStatus(statuses.you, statuses.them), detail) }

  const lanes = {} as Record<Speaker, Lane>
  try {
    const connected = await Promise.allSettled(plans.map(plan => connectLane({
      track: plan.source === 'tab' && tab ? tab.getAudioTracks()[0].clone() : mic.getAudioTracks()[0].clone(),
      targetLanguage: plan.targetLanguage,
      source: plan.source,
      handshake,
      onTranscript: t => {
        transcripts[plan.speaker] = t
        opts.onTranscripts({ ...transcripts })
      },
      onStatus: (s, d) => {
        statuses[plan.speaker] = s
        if (d) detail = d
        report()
      },
    })))
    const failed = connected.find((r): r is PromiseRejectedResult => r.status === 'rejected')
    if (failed) {
      await Promise.all(connected.map(r => (r.status === 'fulfilled' ? r.value.stop() : undefined)))
      throw failed.reason
    }
    plans.forEach((plan, i) => { lanes[plan.speaker] = (connected[i] as PromiseFulfilledResult<Lane>).value })
  } catch (err) {
    stopCaptures()
    throw err
  }

  // In a call, your translated voice goes where you chose (often a virtual
  // cable the call app uses as its microphone); in a room, both play aloud.
  const applyVoiceOutput = async (output: string) => {
    if (opts.setup !== 'call') return
    lanes.you.setMuted(output === VOICE_OUTPUT_NONE)
    if (output !== VOICE_OUTPUT_NONE) await lanes.you.setSinkId(output)
  }
  await applyVoiceOutput(opts.voiceOutput ?? VOICE_OUTPUT_NONE).catch(() => { /* device gone: stays on default */ })

  // Room: turn-taking with a playback gate.
  let active: Speaker | null = opts.setup === 'room' ? 'you' : null
  const playingUntil: Record<Speaker, number> = { you: 0, them: 0 }
  let listening: Speaker | null | undefined
  let ctx: AudioContext | null = null
  const analysers: Partial<Record<Speaker, { node: AnalyserNode; frame: Float32Array<ArrayBuffer> }>> = {}

  const applyInputs = () => {
    const now = Date.now()
    let open: Speaker | null = null
    for (const speaker of ['you', 'them'] as const) {
      const other: Speaker = speaker === 'you' ? 'them' : 'you'
      const enabled = laneInputEnabled(opts.setup, speaker, active, now < playingUntil[other])
      lanes[speaker].setInputEnabled(enabled)
      if (enabled && opts.setup === 'room') open = speaker
    }
    if (opts.setup === 'room' && open !== listening) {
      listening = open
      opts.onListening?.(open)
    }
  }

  let gate: number | undefined
  if (opts.setup === 'room') {
    try { ctx = new AudioContext() } catch { ctx = null }
    gate = window.setInterval(() => {
      for (const speaker of ['you', 'them'] as const) {
        const out = lanes[speaker].output()
        if (ctx && out && !analysers[speaker]) {
          const node = ctx.createAnalyser()
          node.fftSize = 1024
          ctx.createMediaStreamSource(out).connect(node)
          analysers[speaker] = { node, frame: new Float32Array(node.fftSize) }
        }
        const a = analysers[speaker]
        if (!a) continue
        a.node.getFloatTimeDomainData(a.frame)
        if (rmsLevel(a.frame) > PLAYING_LEVEL) playingUntil[speaker] = Date.now() + PLAYING_HOLD_MS
      }
      applyInputs()
    }, GATE_TICK_MS)
  }
  applyInputs()

  let muted = false
  return {
    setSpeaker: speaker => {
      active = speaker
      applyInputs()
    },
    setMuted: m => {
      muted = m
      lanes.them.setMuted(muted)
      if (opts.setup === 'room') lanes.you.setMuted(muted)
    },
    setVoiceOutput: applyVoiceOutput,
    stop: async () => {
      stopping = true
      opts.onStatus('stopping')
      if (gate !== undefined) window.clearInterval(gate)
      await Promise.all([lanes.you.stop(), lanes.them.stop()])
      stopCaptures()
      void ctx?.close().catch(() => {})
      opts.onStatus('idle')
    },
  }
}

/** Whether this browser can run the interpreter at all. */
export function liveTranslateSupported(source: LiveSource): boolean {
  if (typeof window === 'undefined' || typeof RTCPeerConnection === 'undefined' || !navigator.mediaDevices) return false
  return source === 'mic' ? typeof navigator.mediaDevices.getUserMedia === 'function'
    : typeof navigator.mediaDevices.getDisplayMedia === 'function'
}

/** Whether a call's translated voice can be sent to a chosen output device. */
export function voiceOutputSupported(): boolean {
  return typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype
}
