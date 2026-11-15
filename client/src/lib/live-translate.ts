// Live interpreter for /chat: streams microphone or browser-tab audio to
// OpenAI's realtime translation model over WebRTC and plays the translated
// speech, with live source/target transcripts.
//
// The SDP handshake goes through our server (/api/elp/realtime/translate),
// which mints a short-lived OpenAI session, so no key or client secret ever
// reaches the browser and the dashboard CSP (connect-src 'self') holds. Audio
// itself flows directly between the browser and OpenAI.
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

export interface LiveSession {
  /** Flush pending translation, then hang up. */
  stop: () => Promise<void>
  setMuted: (muted: boolean) => void
}

export interface HandshakeRequest { sdp: string | undefined; targetLanguage: string; source: LiveSource }

export interface StartLiveOptions {
  targetLanguage: string
  source: LiveSource
  onTranscript: (t: LiveTranscript) => void
  onStatus: (s: LiveStatus, detail?: string) => void
  /** SDP exchange; defaults to the dashboard endpoint. Public chat passes its own. */
  handshake?: (req: HandshakeRequest) => Promise<{ sdp: string }>
}

const dashboardHandshake = (req: HandshakeRequest) =>
  apiFetch<{ sdp: string }>('/api/elp/realtime/translate', { method: 'POST', body: JSON.stringify(req) })

async function captureAudio(source: LiveSource): Promise<MediaStream> {
  if (source === 'mic') {
    return navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
  }
  // Browsers only share tab audio alongside video; the video track is dropped.
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
  stream.getVideoTracks().forEach(t => { t.stop(); stream.removeTrack(t) })
  if (stream.getAudioTracks().length === 0) {
    throw new Error('No audio was shared. Pick a tab and turn on "Share tab audio".')
  }
  return stream
}

export async function startLiveTranslation(opts: StartLiveOptions): Promise<LiveSession> {
  opts.onStatus('connecting')
  let transcript: LiveTranscript = { ...EMPTY_TRANSCRIPT }
  const media = await captureAudio(opts.source)
  const pc = new RTCPeerConnection()
  const audio = new Audio()
  audio.autoplay = true

  const cleanup = () => {
    media.getTracks().forEach(t => t.stop())
    try { pc.close() } catch { /* already closed */ }
    audio.srcObject = null
  }

  try {
    for (const track of media.getAudioTracks()) pc.addTrack(track, media)
    pc.ontrack = ({ streams }) => {
      audio.srcObject = streams[0]
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
    media.getAudioTracks()[0]?.addEventListener('ended', () => opts.onStatus('stopping'))

    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    const { sdp } = await (opts.handshake ?? dashboardHandshake)({ sdp: offer.sdp, targetLanguage: opts.targetLanguage, source: opts.source })
    await pc.setRemoteDescription({ type: 'answer', sdp })

    return {
      setMuted: (muted: boolean) => { audio.muted = muted },
      stop: async () => {
        opts.onStatus('stopping')
        // Ask the service to flush what it has, then hang up either way.
        if (events.readyState === 'open') {
          try { events.send(JSON.stringify({ type: 'session.close' })) } catch { /* channel gone */ }
          await Promise.race([closed, new Promise(resolve => setTimeout(resolve, 3000))])
        }
        cleanup()
        opts.onStatus('idle')
      },
    }
  } catch (err) {
    cleanup()
    throw err
  }
}

/** Whether this browser can run the interpreter at all. */
export function liveTranslateSupported(source: LiveSource): boolean {
  if (typeof window === 'undefined' || typeof RTCPeerConnection === 'undefined' || !navigator.mediaDevices) return false
  return source === 'mic' ? typeof navigator.mediaDevices.getUserMedia === 'function'
    : typeof navigator.mediaDevices.getDisplayMedia === 'function'
}
