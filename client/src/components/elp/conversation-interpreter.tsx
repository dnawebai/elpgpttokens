import { useEffect, useRef, useState } from 'react'
import { FlipVertical2, Mic, MonitorSpeaker, Square, Users, Volume2, VolumeX } from 'lucide-react'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { TRANSLATE_LANGUAGES } from '@/lib/elp-chat'
import {
  EMPTY_TRANSCRIPT, VOICE_OUTPUT_DEFAULT, VOICE_OUTPUT_NONE, liveTranslateSupported, startConversation, voiceOutputSupported,
  type ConversationSession, type ConversationSetup, type ConversationTranscripts, type Handshake, type LiveStatus, type Speaker,
} from '@/lib/live-translate'

// Two-way interpreter: one translation session per direction. "Same room"
// shares one microphone, so people take turns by tapping their side; "Video
// call" takes their voice from the call's browser tab and yours from the mic.
// Each side of the screen reads in its own language: the other person's words
// translated, and its own words as heard.

export interface ConversationPanelProps {
  open: boolean
  defaultLanguage: string
  handshake?: Handshake
  /** Public chat: renew the session time while live (both directions). */
  keepAlive?: { everyMs: number; run: (sessions: 1 | 2) => Promise<unknown> }
}

const EMPTY_TRANSCRIPTS: ConversationTranscripts = { you: EMPTY_TRANSCRIPT, them: EMPTY_TRANSCRIPT }

function baseLanguage(locale: string): string {
  const code = locale.split('-')[0]
  return TRANSLATE_LANGUAGES.some(l => l.code === code) ? code : 'en'
}

const languageName = (code: string) => TRANSLATE_LANGUAGES.find(l => l.code === code)?.native ?? code

export function ConversationPanel({ open, defaultLanguage, handshake, keepAlive }: ConversationPanelProps) {
  const { t, locale } = useI18n()
  const [setup, setSetup] = useState<ConversationSetup>('room')
  const [yourLanguage, setYourLanguage] = useState(() => baseLanguage(locale))
  const [theirLanguage, setTheirLanguage] = useState(() => {
    const yours = baseLanguage(locale)
    return defaultLanguage !== yours ? defaultLanguage : yours === 'en' ? 'es' : 'en'
  })
  const [status, setStatus] = useState<LiveStatus>('idle')
  const [detail, setDetail] = useState<string | undefined>()
  const [transcripts, setTranscripts] = useState<ConversationTranscripts>(EMPTY_TRANSCRIPTS)
  const [speaker, setSpeaker] = useState<Speaker | null>('you')
  const [listening, setListening] = useState<Speaker | null>(null)
  const [muted, setMuted] = useState(false)
  const [faceToFace, setFaceToFace] = useState(false)
  const [hearOriginal, setHearOriginal] = useState(false)
  const [voiceOutput, setVoiceOutput] = useState(VOICE_OUTPUT_NONE)
  const [outputs, setOutputs] = useState<MediaDeviceInfo[]>([])
  const sessionRef = useRef<ConversationSession | null>(null)

  const running = status === 'connecting' || status === 'live' || status === 'stopping'
  const supported = liveTranslateSupported('mic') && (setup === 'room' || liveTranslateSupported('tab'))
  const canRouteVoice = setup === 'call' && voiceOutputSupported()

  const stop = async () => {
    const session = sessionRef.current
    sessionRef.current = null
    if (session) await session.stop()
    else setStatus('idle')
  }

  // Closing the dialog or leaving the page always hangs up.
  useEffect(() => {
    if (!open && sessionRef.current) {
      const session = sessionRef.current
      sessionRef.current = null
      void session.stop()
    }
  }, [open])
  useEffect(() => () => { void sessionRef.current?.stop() }, [])

  // Output devices, for sending your translated voice into a call. Labels
  // appear once the microphone has been allowed, so refresh after starting.
  useEffect(() => {
    if (!canRouteVoice || !navigator.mediaDevices?.enumerateDevices) return
    let cancelled = false
    const load = () => navigator.mediaDevices.enumerateDevices()
      .then(devices => { if (!cancelled) setOutputs(devices.filter(d => d.kind === 'audiooutput' && d.deviceId && d.deviceId !== 'default')) })
      .catch(() => {})
    void load()
    navigator.mediaDevices.addEventListener?.('devicechange', load)
    return () => {
      cancelled = true
      navigator.mediaDevices.removeEventListener?.('devicechange', load)
    }
  }, [canRouteVoice, status])

  useEffect(() => {
    if (status !== 'live' || !keepAlive) return
    const timer = window.setInterval(() => {
      keepAlive.run(2).catch((err: unknown) => {
        window.clearInterval(timer)
        const session = sessionRef.current
        sessionRef.current = null
        const reason = err instanceof Error ? err.message : String(err)
        void (session ? session.stop() : Promise.resolve()).then(() => {
          setStatus('error')
          setDetail(reason)
        })
      })
    }, keepAlive.everyMs)
    return () => window.clearInterval(timer)
  }, [status, keepAlive])

  const start = async () => {
    setTranscripts(EMPTY_TRANSCRIPTS)
    setDetail(undefined)
    try {
      const session = await startConversation({
        setup,
        yourLanguage,
        theirLanguage,
        hearOriginal,
        voiceOutput,
        handshake,
        onTranscripts: setTranscripts,
        onListening: setListening,
        onStatus: (s, d) => {
          setStatus(s)
          setDetail(d)
          if (s === 'stopping' && sessionRef.current) void stop()
        },
      })
      sessionRef.current = session
      session.setSpeaker(setup === 'room' ? speaker : null)
      session.setMuted(muted)
    } catch (err) {
      sessionRef.current = null
      setStatus('error')
      setDetail(err instanceof Error ? err.message : String(err))
    }
  }

  const choose = (who: Speaker) => {
    const next = speaker === who ? null : who
    setSpeaker(next)
    sessionRef.current?.setSpeaker(next)
  }

  const changeVoiceOutput = (value: string) => {
    setVoiceOutput(value)
    void sessionRef.current?.setVoiceOutput(value).catch(() => {})
  }

  const toggleMute = () => {
    const next = !muted
    setMuted(next)
    sessionRef.current?.setMuted(next)
  }

  const area = (who: Speaker) => {
    const other: Speaker = who === 'you' ? 'them' : 'you'
    const language = who === 'you' ? yourLanguage : theirLanguage
    const isTurn = setup === 'room' && speaker === who
    const heard = transcripts[other].translated
    const said = transcripts[who].source
    return (
      <section
        aria-label={t(who === 'you' ? 'chat.live.conv.you' : 'chat.live.conv.them', { language: languageName(language) })}
        className={cn('flex min-h-40 flex-col gap-2 rounded-xl border p-3 transition-colors',
          isTurn ? 'border-primary/60 bg-primary/5' : 'bg-muted/20',
          who === 'them' && setup === 'room' && faceToFace && 'rotate-180')}>
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-xs font-medium text-muted-foreground">
            {t(who === 'you' ? 'chat.live.conv.you' : 'chat.live.conv.them', { language: languageName(language) })}
          </h3>
          {setup === 'room' && (
            <Button size="sm" variant={isTurn ? 'default' : 'outline'} aria-pressed={isTurn} onClick={() => choose(who)}>
              <Mic /> {t(who === 'you' ? 'chat.live.conv.speakYou' : 'chat.live.conv.speakThem')}
            </Button>
          )}
        </div>
        {isTurn && running && (
          <p className="inline-flex items-center gap-1.5 text-xs text-muted-foreground" aria-live="polite">
            <span className={cn('size-1.5 rounded-full', listening === who ? 'animate-pulse bg-red-500' : 'bg-amber-500')} />
            {listening === who ? t('chat.live.conv.listening') : t('chat.live.conv.waiting')}
          </p>
        )}
        <p className="max-h-40 flex-1 overflow-y-auto whitespace-pre-wrap text-base">{heard || (running ? '…' : '')}</p>
        {said && (
          <p className="max-h-20 overflow-y-auto whitespace-pre-wrap text-xs text-muted-foreground">
            <span className="font-medium">{t(who === 'you' ? 'chat.live.conv.youSaid' : 'chat.live.conv.theySaid')}: </span>{said}
          </p>
        )}
      </section>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <div role="radiogroup" aria-label={t('chat.live.conv.setup')} className="inline-flex rounded-md border p-0.5">
          {([['room', Users, 'chat.live.conv.room'], ['call', MonitorSpeaker, 'chat.live.conv.call']] as const).map(([value, Icon, key]) => (
            <button key={value} type="button" role="radio" aria-checked={setup === value} disabled={running}
              onClick={() => setSetup(value)}
              className={cn('inline-flex items-center gap-1 rounded px-2 py-1 text-xs', setup === value && 'bg-muted font-medium')}>
              <Icon className="size-3.5" /> {t(key)}
            </button>
          ))}
        </div>
        <label className="inline-flex items-center gap-1.5">
          <span className="text-muted-foreground">{t('chat.live.conv.yourLanguage')}</span>
          <select value={yourLanguage} disabled={running} onChange={e => setYourLanguage(e.target.value)} className="rounded-md border bg-background px-2 py-1">
            {TRANSLATE_LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.native}</option>)}
          </select>
        </label>
        <label className="inline-flex items-center gap-1.5">
          <span className="text-muted-foreground">{t('chat.live.conv.theirLanguage')}</span>
          <select value={theirLanguage} disabled={running} onChange={e => setTheirLanguage(e.target.value)} className="rounded-md border bg-background px-2 py-1">
            {TRANSLATE_LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.native}</option>)}
          </select>
        </label>
      </div>

      {setup === 'call' && (
        <div className="flex flex-col gap-2 text-sm">
          {canRouteVoice && (
            <label className="flex flex-wrap items-center gap-1.5">
              <span className="text-muted-foreground">{t('chat.live.conv.voiceOut')}</span>
              <select value={voiceOutput} onChange={e => changeVoiceOutput(e.target.value)} className="max-w-full rounded-md border bg-background px-2 py-1">
                <option value={VOICE_OUTPUT_NONE}>{t('chat.live.conv.voiceOutNone')}</option>
                <option value={VOICE_OUTPUT_DEFAULT}>{t('chat.live.conv.voiceOutDevice')}</option>
                {outputs.map((d, i) => <option key={d.deviceId} value={d.deviceId}>{d.label || `${t('chat.live.conv.voiceOutDevice')} ${i + 2}`}</option>)}
              </select>
            </label>
          )}
          {canRouteVoice && <p className="text-xs text-muted-foreground">{t('chat.live.conv.voiceOutHelp')}</p>}
          <label className="inline-flex items-center gap-2 text-xs">
            <input type="checkbox" checked={hearOriginal} disabled={running} onChange={e => setHearOriginal(e.target.checked)} />
            {t('chat.live.conv.hearOriginal')}
          </label>
        </div>
      )}

      <p className="text-xs text-muted-foreground">{t(setup === 'room' ? 'chat.live.conv.roomHint' : 'chat.live.conv.callHint')}</p>

      <div className="grid gap-3 sm:grid-cols-2">
        {area('them')}
        {area('you')}
      </div>

      {detail && status === 'error' && (
        <p role="alert" className="text-sm text-destructive">{t('chat.live.failed', { reason: detail })}</p>
      )}
      {!supported && <p className="text-sm text-muted-foreground">{t('chat.live.unsupported')}</p>}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="inline-flex items-center gap-2 text-xs text-muted-foreground" aria-live="polite">
          <span className={cn('size-2 rounded-full', status === 'live' ? 'animate-pulse bg-red-500' : status === 'connecting' ? 'bg-amber-500' : 'bg-muted-foreground/40')} />
          {t(`chat.live.status.${status}`)}
        </span>
        <div className="flex flex-wrap items-center gap-2">
          {setup === 'room' && (
            <Button size="sm" variant="ghost" aria-pressed={faceToFace} onClick={() => setFaceToFace(f => !f)}>
              <FlipVertical2 /> {t('chat.live.conv.faceToFace')}
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={toggleMute} disabled={!running} aria-pressed={muted}>
            {muted ? <VolumeX /> : <Volume2 />} {muted ? t('chat.live.unmute') : t('chat.live.mute')}
          </Button>
          {running ? (
            <Button size="sm" variant="secondary" onClick={() => void stop()} disabled={status === 'stopping'}>
              <Square /> {t('chat.live.stop')}
            </Button>
          ) : (
            <Button size="sm" onClick={() => void start()} disabled={!supported || yourLanguage === theirLanguage}>
              <Users /> {t('chat.live.start')}
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
