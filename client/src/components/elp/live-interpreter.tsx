import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Mic, MonitorSpeaker, Square, Volume2, VolumeX, X } from 'lucide-react'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogDescription, DialogPopup, DialogTitle } from '@/components/ui/dialog'
import { TRANSLATE_LANGUAGES } from '@/lib/elp-chat'
import {
  EMPTY_TRANSCRIPT, liveTranslateSupported, startLiveTranslation,
  type LiveSession, type LiveSource, type LiveStatus, type LiveTranscript,
} from '@/lib/live-translate'

// Live interpreter: speak (or play a tab) in any language and hear it in the
// target language a moment later, with both transcripts on screen.

interface LiveInterpreterProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** False when no OpenAI key is connected. */
  available: boolean
  defaultLanguage?: string
}

export function LiveInterpreter({ open, onOpenChange, available, defaultLanguage = 'en' }: LiveInterpreterProps) {
  const { t } = useI18n()
  const [language, setLanguage] = useState(defaultLanguage)
  const [source, setSource] = useState<LiveSource>('mic')
  const [status, setStatus] = useState<LiveStatus>('idle')
  const [detail, setDetail] = useState<string | undefined>()
  const [transcript, setTranscript] = useState<LiveTranscript>(EMPTY_TRANSCRIPT)
  const [muted, setMuted] = useState(false)
  const sessionRef = useRef<LiveSession | null>(null)
  const translatedRef = useRef<HTMLDivElement | null>(null)

  const running = status === 'connecting' || status === 'live' || status === 'stopping'
  const supported = liveTranslateSupported(source)

  const stop = async () => {
    const session = sessionRef.current
    sessionRef.current = null
    if (session) await session.stop()
    else setStatus('idle')
  }

  // Closing the dialog or leaving the page always hangs up.
  useEffect(() => {
    if (!open && sessionRef.current) void stop()
  }, [open])
  useEffect(() => () => { void sessionRef.current?.stop() }, [])

  useEffect(() => {
    translatedRef.current?.scrollTo({ top: translatedRef.current.scrollHeight })
  }, [transcript.translated])

  const start = async () => {
    setTranscript(EMPTY_TRANSCRIPT)
    setDetail(undefined)
    try {
      sessionRef.current = await startLiveTranslation({
        targetLanguage: language,
        source,
        onTranscript: setTranscript,
        onStatus: (s, d) => {
          setStatus(s)
          setDetail(d)
          // The shared tab or mic went away: finish cleanly.
          if (s === 'stopping' && sessionRef.current) void stop()
        },
      })
      sessionRef.current.setMuted(muted)
    } catch (err) {
      sessionRef.current = null
      setStatus('error')
      setDetail(err instanceof Error ? err.message : String(err))
    }
  }

  const toggleMute = () => {
    setMuted(m => {
      sessionRef.current?.setMuted(!m)
      return !m
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup maxWidth="max-w-2xl" className="flex flex-col gap-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <DialogTitle className="text-base font-semibold">{t('chat.live.title')}</DialogTitle>
            <DialogDescription className="text-sm text-muted-foreground">{t('chat.live.description')}</DialogDescription>
          </div>
          <DialogClose aria-label={t('common.dismiss')} className="rounded-lg p-1 text-muted-foreground hover:text-foreground">
            <X className="size-4" />
          </DialogClose>
        </div>

        {!available ? (
          <p className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-200">
            {t('chat.live.needsOpenAI')} <Link to="/keys" className="underline" onClick={() => onOpenChange(false)}>{t('chat.addKey')}</Link>
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <label className="inline-flex items-center gap-1.5">
                <span className="text-muted-foreground">{t('chat.live.translateInto')}</span>
                <select value={language} disabled={running} onChange={e => setLanguage(e.target.value)} className="rounded-md border bg-background px-2 py-1">
                  {TRANSLATE_LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.native}</option>)}
                </select>
              </label>
              <div role="radiogroup" aria-label={t('chat.live.source')} className="inline-flex rounded-md border p-0.5">
                {([['mic', Mic, 'chat.live.sourceMic'], ['tab', MonitorSpeaker, 'chat.live.sourceTab']] as const).map(([value, Icon, key]) => (
                  <button key={value} type="button" role="radio" aria-checked={source === value} disabled={running}
                    onClick={() => setSource(value)}
                    className={cn('inline-flex items-center gap-1 rounded px-2 py-1 text-xs', source === value && 'bg-muted font-medium')}>
                    <Icon className="size-3.5" /> {t(key)}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <section className="flex min-h-40 flex-col rounded-xl border bg-muted/30 p-3">
                <h3 className="mb-1 text-xs font-medium text-muted-foreground">{t('chat.live.original')}</h3>
                <p className="flex-1 whitespace-pre-wrap text-sm text-muted-foreground">{transcript.source || (running ? '…' : '')}</p>
              </section>
              <section className="flex min-h-40 flex-col rounded-xl border p-3">
                <h3 className="mb-1 text-xs font-medium text-muted-foreground">{t('chat.live.translation')}</h3>
                <div ref={translatedRef} className="max-h-60 flex-1 overflow-y-auto whitespace-pre-wrap text-base">{transcript.translated || (running ? '…' : '')}</div>
              </section>
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
              <div className="flex items-center gap-2">
                <Button size="sm" variant="ghost" onClick={toggleMute} disabled={!running} aria-pressed={muted}>
                  {muted ? <VolumeX /> : <Volume2 />} {muted ? t('chat.live.unmute') : t('chat.live.mute')}
                </Button>
                {running ? (
                  <Button size="sm" variant="secondary" onClick={() => void stop()} disabled={status === 'stopping'}>
                    <Square /> {t('chat.live.stop')}
                  </Button>
                ) : (
                  <Button size="sm" onClick={() => void start()} disabled={!supported}>
                    {source === 'mic' ? <Mic /> : <MonitorSpeaker />} {t('chat.live.start')}
                  </Button>
                )}
              </div>
            </div>
          </>
        )}
      </DialogPopup>
    </Dialog>
  )
}
