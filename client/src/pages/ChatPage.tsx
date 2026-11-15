import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type KeyboardEvent } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  Brain, Code, Download, ExternalLink, Eye, Image as ImageIcon, KeyRound, Languages, MessageCircle,
  AudioLines, Paperclip, PenLine, Plus, RotateCcw, Search, Send, Sparkles, Square, Volume2, VolumeX, X,
} from 'lucide-react'
import type { ElpRouteInfo } from '@freellmapi/shared/types'
import { apiFetch } from '@/lib/api'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import { toast } from '@/lib/toast'
import { Markdown } from '@/components/markdown'
import { CopyButton } from '@/components/copy-button'
import { Button } from '@/components/ui/button'
import { DictationButton } from '@/components/playground/dictation-button'
import { LiveInterpreter } from '@/components/elp/live-interpreter'
import { appendDictation, hasTranscription, type TranscriptionModelRow } from '@/lib/transcription'
import { readImageAttachment, IMAGE_MIME_TYPES, MAX_ATTACHMENTS } from '@/lib/attachments'
import {
  ELP_MODEL, ELP_CONVERSATION_STORAGE_KEY, TRANSLATE_LANGUAGES,
  parseRouteHeader, readElpStream, splitImages, linkCitations, citationHost, speakableText,
  translationSystemPrompt, translateCommand, toWireMessages, previousIntent,
  serializeConversation, deserializeConversation,
  type ChatTurn, type ElpIntent, type ElpRoutePreview,
} from '@/lib/elp-chat'

// ELPGPT /chat: one conversation over every connected model. Each message is
// sent as `elpgpt-auto`; the server classifies it and routes to Perplexity for
// search, GPT Image for pictures, Claude for code and writing, GPT for chat.
// While the user types, /api/elp/route previews that decision as a badge.

interface ElpStatus {
  liveTranslate?: { available: boolean; model: string }
  providers: { platform: 'anthropic' | 'openai' | 'perplexity'; connected: boolean }[]
  searchFallback: boolean
  routes: { intent: ElpIntent; route: ElpRouteInfo }[]
}

const PROVIDER_LABELS: Record<ElpStatus['providers'][number]['platform'], string> = {
  anthropic: 'Claude',
  openai: 'ChatGPT',
  perplexity: 'Perplexity',
}

const INTENT_ICONS: Record<ElpIntent, ComponentType<{ className?: string }>> = {
  web_search: Search,
  image_generation: ImageIcon,
  code: Code,
  reasoning: Brain,
  writing: PenLine,
  translation: Languages,
  vision: Eye,
  chat: MessageCircle,
}

const EXAMPLES = ['search', 'image', 'code', 'translate'] as const
const base = import.meta.env.BASE_URL.replace(/\/$/, '')
const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

function RouteChip({ route, routedVia, compact }: { route: ElpRouteInfo | null | undefined; routedVia?: string | null; compact?: boolean }) {
  const { t } = useI18n()
  if (!route) {
    return routedVia ? <span className="text-xs text-muted-foreground">{t('chat.answeredBy')} {routedVia}</span> : null
  }
  const Icon = INTENT_ICONS[route.intent as ElpIntent] ?? Sparkles
  return (
    <span
      className={cn(
        'inline-flex w-fit max-w-full items-center gap-1.5 self-start rounded-full border px-2.5 py-0.5 text-xs',
        route.fallback ? 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300' : 'border-primary/30 bg-primary/5 text-foreground',
      )}
      title={`${route.reason} (${Math.round(route.confidence * 100)}%)`}
    >
      <Icon className="size-3.5 shrink-0" />
      <span className="font-medium">{t(`chat.intent.${route.intent}`)}</span>
      <span aria-hidden className="text-muted-foreground">→</span>
      <span className="truncate">{route.label}</span>
      {!compact && routedVia && routedVia !== 'cache' && (
        <span className="hidden truncate text-muted-foreground sm:inline">· {routedVia}</span>
      )}
    </span>
  )
}

function AssistantTurn({ turn, onRetry, onSpeak }: { turn: ChatTurn; onRetry: () => void; onSpeak: (text: string) => void }) {
  const { t } = useI18n()
  const { text, images } = useMemo(() => splitImages(turn.content), [turn.content])
  const linked = useMemo(() => linkCitations(text, turn.citations ?? []), [text, turn.citations])
  const isImage = turn.route?.kind === 'image'

  return (
    <div className="flex flex-col gap-2">
      <RouteChip route={turn.route} routedVia={turn.routedVia} />
      {turn.pending && !turn.content && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span className="size-2 animate-pulse rounded-full bg-primary" />
          {isImage ? t('chat.generatingImage') : t('chat.thinking')}
        </div>
      )}
      {turn.reasoning && (
        <details className="rounded-lg border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          <summary className="cursor-pointer select-none">{t('chat.showReasoning')}</summary>
          <p className="mt-2 whitespace-pre-wrap">{turn.reasoning}</p>
        </details>
      )}
      {images.map((img, i) => (
        <figure key={i} className="flex flex-col gap-1.5">
          <img src={img.src} alt={img.alt} className="max-h-[512px] w-full max-w-lg rounded-xl border object-contain" />
          <a href={img.src} download={`elpgpt-${turn.id}-${i + 1}.png`} className="inline-flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
            <Download className="size-3.5" /> {t('chat.downloadImage')}
          </a>
        </figure>
      ))}
      {linked && <Markdown>{linked}</Markdown>}
      {(turn.citations?.length ?? 0) > 0 && (
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">{t('chat.sources')}</span>
          <div className="grid gap-1.5 sm:grid-cols-2">
            {turn.citations!.map(c => (
              <a key={`${c.index}-${c.url}`} href={c.url} target="_blank" rel="noreferrer noopener"
                className="group flex min-w-0 items-start gap-2 rounded-lg border px-2.5 py-1.5 text-xs hover:bg-muted/60">
                <span className="mt-px shrink-0 rounded bg-muted px-1 font-mono">{c.index}</span>
                <span className="min-w-0">
                  <span className="block truncate font-medium">{c.title ?? citationHost(c.url)}</span>
                  <span className="flex items-center gap-1 truncate text-muted-foreground">
                    {citationHost(c.url)} <ExternalLink className="size-3 opacity-0 group-hover:opacity-100" />
                  </span>
                </span>
              </a>
            ))}
          </div>
        </div>
      )}
      {turn.error && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          <span>{t('chat.errorPrefix', { message: turn.error })}</span>
          <Button size="xs" variant="outline" onClick={onRetry}><RotateCcw /> {t('chat.retry')}</Button>
        </div>
      )}
      {!turn.pending && text && (
        <div className="flex items-center gap-1 text-muted-foreground">
          <CopyButton text={turn.content} label={t('chat.copy')} />
          <Button size="icon-xs" variant="ghost" onClick={() => onSpeak(turn.content)} aria-label={t('chat.speakReplies')}>
            <Volume2 />
          </Button>
        </div>
      )}
    </div>
  )
}

export default function ChatPage() {
  const { t } = useI18n()
  const { data: keyData } = useQuery<{ apiKey: string }>({ queryKey: ['unified-key'], queryFn: () => apiFetch('/api/settings/api-key') })
  const { data: status } = useQuery<ElpStatus>({ queryKey: ['elp-status'], queryFn: () => apiFetch('/api/elp/status'), refetchInterval: 60_000 })
  const { data: mediaData } = useQuery<{ models: TranscriptionModelRow[] }>({ queryKey: ['media'], queryFn: () => apiFetch('/api/media') })
  const apiKey = keyData?.apiKey
  const mediaModels = useMemo(() => mediaData?.models ?? [], [mediaData])
  const canDictate = hasTranscription(mediaModels)
  const canSpeak = mediaModels.some(m => m.modality === 'audio' && m.enabled && m.keyCount > 0)

  const [turns, setTurns] = useState<ChatTurn[]>(() => {
    try { return deserializeConversation(localStorage.getItem(ELP_CONVERSATION_STORAGE_KEY)) } catch { return [] }
  })
  const [input, setInput] = useState('')
  const [attachments, setAttachments] = useState<string[]>([])
  const [model, setModel] = useState<string>(ELP_MODEL)
  const [translateOn, setTranslateOn] = useState(false)
  const [targetLang, setTargetLang] = useState('es')
  const [speakOn, setSpeakOn] = useState(false)
  const [speaking, setSpeaking] = useState(false)
  const [liveOpen, setLiveOpen] = useState(false)
  const [preview, setPreview] = useState<ElpRoutePreview | null>(null)
  const [busy, setBusy] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)
  const bottomRef = useRef<HTMLDivElement | null>(null)

  // Persist the conversation (images are dropped by the serializer).
  useEffect(() => {
    if (turns.some(turn => turn.pending)) return
    try { localStorage.setItem(ELP_CONVERSATION_STORAGE_KEY, serializeConversation(turns)) } catch { /* storage full or blocked */ }
  }, [turns])

  useEffect(() => { bottomRef.current?.scrollIntoView({ block: 'end' }) }, [turns])

  // Live routing badge: what elpgpt-auto would do with what is typed now.
  const prevIntent = previousIntent(turns)
  useEffect(() => {
    if (model !== ELP_MODEL || (!input.trim() && attachments.length === 0)) {
      setPreview(null)
      return
    }
    const text = translateOn ? translateCommand(input) : input
    const handle = window.setTimeout(() => {
      apiFetch<ElpRoutePreview>('/api/elp/route', {
        method: 'POST',
        body: JSON.stringify({ text, hasImage: attachments.length > 0, ...(prevIntent ? { previousIntent: prevIntent } : {}) }),
      }).then(setPreview).catch(() => setPreview(null))
    }, 250)
    return () => window.clearTimeout(handle)
  }, [input, attachments.length, translateOn, model, prevIntent])

  const pinnedOptions = useMemo(() => {
    const seen = new Map<string, string>()
    for (const r of status?.routes ?? []) {
      const { model: m, label, fallback, kind } = r.route
      if (!fallback && kind === 'chat' && m && !seen.has(m)) seen.set(m, label)
    }
    return [...seen.entries()].map(([value, label]) => ({ value, label }))
  }, [status])

  const updateTurn = useCallback((id: string, patch: Partial<ChatTurn>) => {
    setTurns(prev => prev.map(turn => (turn.id === id ? { ...turn, ...patch } : turn)))
  }, [])

  const stopSpeaking = useCallback(() => {
    audioRef.current?.pause()
    audioRef.current = null
    setSpeaking(false)
  }, [])

  const speak = useCallback(async (markdown: string) => {
    const text = speakableText(markdown)
    if (!text || !apiKey) return
    if (!canSpeak) {
      toast.info(t('chat.voiceUnavailable'))
      return
    }
    stopSpeaking()
    try {
      const res = await fetch(`${base}/v1/audio/speech`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: 'auto', input: text, response_format: 'mp3' }),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error?.message ?? `HTTP ${res.status}`)
      const url = URL.createObjectURL(await res.blob())
      const audio = new Audio(url)
      audioRef.current = audio
      setSpeaking(true)
      audio.onended = () => { URL.revokeObjectURL(url); setSpeaking(false) }
      await audio.play()
    } catch (err) {
      setSpeaking(false)
      toast.error(t('chat.speechFailed', { reason: err instanceof Error ? err.message : String(err) }))
    }
  }, [apiKey, canSpeak, stopSpeaking, t])

  const send = useCallback(async (override?: string, history: ChatTurn[] = turns) => {
    const text = (override ?? input).trim()
    const images = override === undefined ? attachments : []
    if ((!text && images.length === 0) || busy || !apiKey) return

    const userTurn: ChatTurn = { id: newId(), role: 'user', content: text, ...(images.length ? { attachments: images } : {}) }
    const assistantId = newId()
    const nextHistory = [...history, userTurn]
    setTurns([...nextHistory, { id: assistantId, role: 'assistant', content: '', pending: true, route: model === ELP_MODEL ? preview : null }])
    if (override === undefined) { setInput(''); setAttachments([]) }
    setPreview(null)

    // Translate mode forces the translation route and an interpreter prompt.
    const wire = translateOn
      ? nextHistory.map((turn, i) => (i === nextHistory.length - 1 ? { ...turn, content: translateCommand(turn.content) } : turn))
      : nextHistory
    const controller = new AbortController()
    abortRef.current = controller
    setBusy(true)
    try {
      const res = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, stream: true, messages: toWireMessages(wire, translateOn ? translationSystemPrompt(targetLang) : undefined) }),
        signal: controller.signal,
      })
      const route = parseRouteHeader(res.headers.get('x-elp-route'))
      const routedVia = res.headers.get('x-routed-via')
      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => null)
        throw new Error(body?.error?.message ?? `HTTP ${res.status}`)
      }
      updateTurn(assistantId, { route: route ?? null, routedVia })
      const result = await readElpStream(res.body, partial => {
        updateTurn(assistantId, {
          content: partial.content,
          reasoning: partial.reasoning || undefined,
          citations: partial.citations.length ? partial.citations : undefined,
          ...(partial.route ? { route: partial.route } : {}),
        })
      })
      updateTurn(assistantId, { pending: false, ...(result.error && !result.content ? { error: result.error } : {}) })
      if (speakOn && result.content) void speak(result.content)
    } catch (err) {
      const aborted = controller.signal.aborted
      setTurns(prev => prev.map(turn => turn.id !== assistantId ? turn : {
        ...turn,
        pending: false,
        ...(aborted ? {} : { error: err instanceof Error ? err.message : String(err) }),
      }))
    } finally {
      setBusy(false)
      abortRef.current = null
    }
  }, [turns, input, attachments, busy, apiKey, model, preview, translateOn, targetLang, speakOn, speak, updateTurn])

  const retry = (assistantId: string) => {
    const idx = turns.findIndex(turn => turn.id === assistantId)
    const user = idx > 0 ? turns[idx - 1] : undefined
    if (!user || user.role !== 'user') return
    void send(user.content, turns.slice(0, idx - 1))
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void send()
    }
  }

  const addFiles = async (files: FileList | null) => {
    if (!files) return
    const next = [...attachments]
    for (const file of Array.from(files)) {
      if (next.length >= MAX_ATTACHMENTS) break
      if (!IMAGE_MIME_TYPES.includes(file.type)) continue
      try { next.push(await readImageAttachment(file)) } catch { toast.error(t('chat.attachFailed')) }
    }
    setAttachments(next)
  }

  const newChat = () => {
    abortRef.current?.abort()
    stopSpeaking()
    setTurns([])
    setInput('')
    setAttachments([])
  }

  const missing = (status?.providers ?? []).filter(p => !p.connected)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3 sm:px-6">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-lg font-semibold"><Sparkles className="size-5 text-primary" /> {t('chat.title')}</h1>
          <p className="text-xs text-muted-foreground">{t('chat.tagline')}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {(status?.providers ?? []).map(p => (
            <span key={p.platform} className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs"
              title={p.connected ? t('chat.connected') : t('chat.notConnected')}>
              <span className={cn('size-1.5 rounded-full', p.connected ? 'bg-emerald-500' : 'bg-muted-foreground/40')} />
              {PROVIDER_LABELS[p.platform]}
            </span>
          ))}
          {missing.length > 0 && (
            <Link to="/keys" className="inline-flex items-center gap-1 text-xs text-primary hover:underline"><KeyRound className="size-3.5" />{t('chat.addKey')}</Link>
          )}
          <Button size="sm" variant="outline" onClick={newChat}><Plus /> {t('chat.newChat')}</Button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6 sm:px-6">
          {turns.length === 0 && (
            <div className="flex flex-col items-center gap-4 py-10 text-center">
              <h2 className="text-2xl font-semibold tracking-tight">{t('chat.emptyTitle')}</h2>
              <p className="max-w-lg text-sm text-muted-foreground">{t('chat.emptyBody')}</p>
              <div className="grid w-full max-w-xl gap-2 sm:grid-cols-2">
                {EXAMPLES.map(key => (
                  <button key={key} type="button" onClick={() => setInput(t(`chat.example.${key}`))}
                    className="rounded-xl border px-3 py-2.5 text-left text-sm hover:bg-muted/60">
                    {t(`chat.example.${key}`)}
                  </button>
                ))}
              </div>
            </div>
          )}
          {turns.map(turn => turn.role === 'user' ? (
            <div key={turn.id} className="flex flex-col items-end gap-2">
              {turn.attachments?.map((src, i) => <img key={i} src={src} alt="" className="max-h-48 rounded-xl border" />)}
              {turn.content && <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl bg-primary px-3.5 py-2 text-sm text-primary-foreground">{turn.content}</div>}
            </div>
          ) : (
            <AssistantTurn key={turn.id} turn={turn} onRetry={() => retry(turn.id)} onSpeak={text => void speak(text)} />
          ))}
          <div ref={bottomRef} />
        </div>
      </div>

      <div className="border-t bg-background/95 px-4 pb-4 pt-3 sm:px-6">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-2">
          <div className="flex min-h-6 flex-wrap items-center gap-2">
            {preview && <span className="text-xs text-muted-foreground">{t('chat.routingTo')}</span>}
            {preview && <RouteChip route={preview} compact />}
            {preview?.fallback && (
              <span className="text-xs text-amber-700 dark:text-amber-300">
                {t('chat.freeFallback')} <Link to="/keys" className="underline">{t('chat.addKey')}</Link>
              </span>
            )}
          </div>

          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {attachments.map((src, i) => (
                <div key={i} className="relative">
                  <img src={src} alt="" className="size-14 rounded-lg border object-cover" />
                  <button type="button" aria-label={t('chat.removeAttachment')} onClick={() => setAttachments(a => a.filter((_, j) => j !== i))}
                    className="absolute -right-1.5 -top-1.5 rounded-full border bg-background p-0.5"><X className="size-3" /></button>
                </div>
              ))}
            </div>
          )}

          <div className="flex items-end gap-2 rounded-2xl border bg-card p-2 focus-within:ring-2 focus-within:ring-primary/30">
            <Button size="icon-sm" variant="ghost" onClick={() => fileRef.current?.click()} aria-label={t('chat.attach')} disabled={busy}>
              <Paperclip />
            </Button>
            <input ref={fileRef} type="file" accept={IMAGE_MIME_TYPES.join(',')} multiple className="hidden"
              onChange={e => { void addFiles(e.target.files); e.target.value = '' }} />
            <textarea
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              rows={1}
              placeholder={translateOn ? t('chat.translatePlaceholder') : t('chat.placeholder')}
              className="max-h-48 min-h-9 flex-1 resize-none bg-transparent px-1 py-1.5 text-sm outline-none [field-sizing:content]"
              aria-label={t('chat.placeholder')}
            />
            <DictationButton
              available={canDictate}
              model="auto"
              apiKey={apiKey}
              disabled={busy}
              onText={text => (speakOn ? void send(text) : setInput(prev => appendDictation(prev, text)))}
            />
            {busy ? (
              <Button size="icon-sm" variant="secondary" onClick={() => abortRef.current?.abort()} aria-label={t('chat.stop')}><Square /></Button>
            ) : (
              <Button size="icon-sm" onClick={() => void send()} disabled={(!input.trim() && attachments.length === 0) || !apiKey} aria-label={t('chat.send')}><Send /></Button>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2 text-xs">
            <label className="inline-flex items-center gap-1.5">
              <span className="text-muted-foreground">{t('chat.modelPicker')}</span>
              <select value={model} onChange={e => setModel(e.target.value)} className="rounded-md border bg-background px-1.5 py-1">
                <option value={ELP_MODEL}>{t('chat.modeAuto')}</option>
                {pinnedOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
            <button type="button" onClick={() => setTranslateOn(v => !v)} aria-pressed={translateOn}
              className={cn('inline-flex items-center gap-1 rounded-md border px-2 py-1', translateOn && 'border-primary bg-primary/10')}>
              <Languages className="size-3.5" /> {t('chat.translate')}
            </button>
            {translateOn && (
              <label className="inline-flex items-center gap-1.5">
                <span className="text-muted-foreground">{t('chat.translateTo')}</span>
                <select value={targetLang} onChange={e => setTargetLang(e.target.value)} className="rounded-md border bg-background px-1.5 py-1">
                  {TRANSLATE_LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.native}</option>)}
                </select>
              </label>
            )}
            <button type="button" onClick={() => (speaking ? stopSpeaking() : setSpeakOn(v => !v))} aria-pressed={speakOn}
              className={cn('inline-flex items-center gap-1 rounded-md border px-2 py-1', speakOn && 'border-primary bg-primary/10')}
              title={canSpeak ? undefined : t('chat.voiceUnavailable')}>
              {speaking ? <VolumeX className="size-3.5" /> : <Volume2 className="size-3.5" />}
              {speaking ? t('chat.stopSpeaking') : t('chat.speakReplies')}
            </button>
            <button type="button" onClick={() => setLiveOpen(true)}
              className="inline-flex items-center gap-1 rounded-md border px-2 py-1">
              <AudioLines className="size-3.5" /> {t('chat.live.open')}
            </button>
            {speakOn && <span className="text-muted-foreground">{t('chat.voiceHint')}</span>}
          </div>
        </div>
      </div>
      <LiveInterpreter
        open={liveOpen}
        onOpenChange={setLiveOpen}
        available={status?.liveTranslate?.available ?? false}
        defaultLanguage={targetLang}
      />
    </div>
  )
}
