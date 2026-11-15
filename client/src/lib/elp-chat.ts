// Pure helpers behind /chat (ELPGPT): the routing badge, the stream reader
// that also keeps citations, image/citation post-processing of answers, and
// the text that voice mode reads aloud. Kept free of React so every rule is
// unit-testable.
import type { ElpRouteInfo, SearchCitation } from '@freellmapi/shared/types'
import { frameData } from './playground-stream'

export const ELP_MODEL = 'elpgpt-auto'
export const ELP_CONVERSATION_STORAGE_KEY = 'elpgpt.chat.conversation'

export type ElpIntent =
  | 'image_generation' | 'web_search' | 'translation' | 'code'
  | 'reasoning' | 'writing' | 'vision' | 'chat'

export interface ElpRoutePreview extends ElpRouteInfo {
  targetLanguage?: string | null
}

/** The `X-ELP-Route` response header: URI-encoded JSON, or absent. */
export function parseRouteHeader(value: string | null | undefined): ElpRouteInfo | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(decodeURIComponent(value)) as ElpRouteInfo
    return parsed && typeof parsed === 'object' && typeof parsed.intent === 'string' ? parsed : null
  } catch {
    return null
  }
}

interface StreamFrame {
  error?: { message?: unknown }
  citations?: SearchCitation[]
  elp_route?: ElpRouteInfo
  choices?: Array<{ delta?: { content?: unknown; reasoning_content?: unknown; reasoning?: unknown } }>
}

export interface ElpStreamResult {
  content: string
  reasoning: string
  citations: SearchCitation[]
  route: ElpRouteInfo | null
  error?: string
  done: boolean
}

/**
 * Read an OpenAI-style SSE chat stream, keeping the two ELPGPT extras that the
 * Playground reader ignores: `citations` (search sources, on the final usage
 * frame) and `elp_route` (on the first frame of a generated-image answer).
 */
export async function readElpStream(
  stream: ReadableStream<Uint8Array>,
  onUpdate: (partial: ElpStreamResult) => void,
): Promise<ElpStreamResult> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  const result: ElpStreamResult = { content: '', reasoning: '', citations: [], route: null, done: false }
  let buffer = ''

  const handle = (frame: string): boolean => {
    const data = frameData(frame)
    if (data === null) return false
    if (data === '[DONE]') return true
    let obj: StreamFrame
    try { obj = JSON.parse(data) as StreamFrame } catch { return false }
    if (obj?.error) {
      result.error = typeof obj.error.message === 'string' ? obj.error.message : String(obj.error)
    }
    if (Array.isArray(obj?.citations) && obj.citations.length > 0) result.citations = obj.citations
    if (obj?.elp_route && typeof obj.elp_route === 'object') result.route = obj.elp_route
    const delta = obj?.choices?.[0]?.delta
    if (typeof delta?.content === 'string') result.content += delta.content
    const reasoning = delta?.reasoning_content ?? delta?.reasoning
    if (typeof reasoning === 'string') result.reasoning += reasoning
    return false
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let sep: number
      while ((sep = buffer.search(/\r?\n\r?\n/)) !== -1) {
        const frame = buffer.slice(0, sep)
        buffer = buffer.slice(sep).replace(/^\r?\n\r?\n/, '')
        if (handle(frame)) {
          result.done = true
          onUpdate({ ...result })
          return result
        }
      }
      onUpdate({ ...result })
    }
    if (buffer.trim() && handle(buffer)) result.done = true
  } finally {
    reader.releaseLock()
  }
  onUpdate({ ...result })
  return result
}

export interface AnswerImage { src: string; alt: string }

const IMAGE_MD = /!\[([^\]]*)\]\(((?:data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+)|(?:https:\/\/[^\s)]+))\)/g

/**
 * Pull generated images out of an answer. The shared Markdown renderer strips
 * `data:` URLs (a sane default for model output), so images the gateway
 * generated are rendered by the chat page itself; the rest stays markdown.
 */
export function splitImages(content: string): { text: string; images: AnswerImage[] } {
  const images: AnswerImage[] = []
  const text = content.replace(IMAGE_MD, (_m, alt: string, src: string) => {
    images.push({ src, alt })
    return ''
  }).trim()
  return { text, images }
}

/**
 * Turn inline citation markers (`[1]`, `[web:1]`) into markdown links to the
 * matching source. Fenced code is left alone, and markers with no matching
 * source stay as they are.
 */
export function linkCitations(text: string, citations: readonly SearchCitation[]): string {
  if (citations.length === 0) return text
  const byIndex = new Map(citations.map(c => [c.index, c.url]))
  return text
    .split(/(```[\s\S]*?```)/g)
    .map(part => part.startsWith('```')
      ? part
      : part.replace(/\[(?:web:)?(\d{1,3})\](?!\()/g, (m, n: string) => {
        const url = byIndex.get(Number(n))
        return url ? `[[${n}]](${url})` : m
      }))
    .join('')
}

/** Host for a source card ("news.example.com"). */
export function citationHost(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, '') } catch { return url }
}

/**
 * What voice mode reads aloud: the answer without code, markdown syntax,
 * citation markers or URLs, capped so a long answer doesn't monopolise the
 * speech provider.
 */
export function speakableText(markdown: string, max = 3000): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\[(?:web:)?\d{1,3}\]/g, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/[*_~>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

/** Languages offered by the Translate tool (code → English name). */
export const TRANSLATE_LANGUAGES: ReadonlyArray<{ code: string; name: string; native: string }> = [
  { code: 'en', name: 'English', native: 'English' },
  { code: 'es', name: 'Spanish', native: 'Español' },
  { code: 'pt', name: 'Portuguese', native: 'Português' },
  { code: 'fr', name: 'French', native: 'Français' },
  { code: 'de', name: 'German', native: 'Deutsch' },
  { code: 'it', name: 'Italian', native: 'Italiano' },
  { code: 'zh', name: 'Chinese (Simplified)', native: '中文' },
  { code: 'ja', name: 'Japanese', native: '日本語' },
  { code: 'ko', name: 'Korean', native: '한국어' },
  { code: 'ar', name: 'Arabic', native: 'العربية' },
  { code: 'ru', name: 'Russian', native: 'Русский' },
  { code: 'hi', name: 'Hindi', native: 'हिन्दी' },
]

export function languageName(code: string): string {
  return TRANSLATE_LANGUAGES.find(l => l.code === code)?.name ?? code
}

/** System prompt for the Translate tool. The `/translate` command on the user
 *  turn makes the router send it down the translation ladder. */
export function translationSystemPrompt(targetCode: string): string {
  const target = languageName(targetCode)
  return [
    `You are a professional interpreter. Translate everything the user sends into ${target}.`,
    'Detect the source language yourself. Keep the meaning, tone, names and formatting.',
    `Reply with the ${target} translation only — no notes, no quotes, no explanations.`,
  ].join(' ')
}

export function translateCommand(text: string): string {
  return `/translate ${text}`
}

/** Slash command that forces an intent, for the manual override picker. */
export const FORCE_COMMANDS: Partial<Record<ElpIntent, string>> = {
  web_search: '/search',
  image_generation: '/image',
  code: '/code',
}

/** Remove a leading slash command before showing a user turn back. */
export function stripCommand(text: string): string {
  return text.replace(/^\s*\/(?:image|imagine|img|search|web|translate|code)\b\s*/i, '')
}

export interface ChatTurn {
  id: string
  role: 'user' | 'assistant'
  /** What the user typed (without forced commands) / the answer markdown. */
  content: string
  /** Data URLs of images the user attached. */
  attachments?: string[]
  route?: ElpRouteInfo | null
  routedVia?: string | null
  citations?: SearchCitation[]
  reasoning?: string
  error?: string
  pending?: boolean
}

type WireContent = string | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>

/** Turn history into chat-completion messages. Errored or pending assistant
 *  turns are skipped so a failed answer doesn't poison the next request. */
export function toWireMessages(turns: readonly ChatTurn[], system?: string): Array<{ role: string; content: WireContent }> {
  const out: Array<{ role: string; content: WireContent }> = []
  if (system) out.push({ role: 'system', content: system })
  for (const turn of turns) {
    if (turn.role === 'assistant') {
      if (turn.pending || turn.error || !turn.content) continue
      // A generated image is a multi-MB data URL: never resend it to a model.
      out.push({ role: 'assistant', content: turn.content.replace(IMAGE_MD, '[generated image: $1]') })
      continue
    }
    if (turn.attachments?.length) {
      out.push({
        role: 'user',
        content: [
          ...(turn.content ? [{ type: 'text' as const, text: turn.content }] : []),
          ...turn.attachments.map(url => ({ type: 'image_url' as const, image_url: { url } })),
        ],
      })
    } else {
      out.push({ role: 'user', content: turn.content })
    }
  }
  return out
}

/** Intent of the previous user turn, for the preview's follow-up rule. */
export function previousIntent(turns: readonly ChatTurn[]): ElpIntent | undefined {
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i]
    if (t.role === 'assistant' && t.route?.intent) return t.route.intent as ElpIntent
  }
  return undefined
}

/** Saved conversation; generated images are dropped to stay within storage limits. */
export function serializeConversation(turns: readonly ChatTurn[]): string {
  return JSON.stringify(turns
    .filter(t => !t.pending)
    .map(t => ({ ...t, content: t.content.replace(IMAGE_MD, '![$1](image omitted)'), attachments: undefined })))
}

export function deserializeConversation(raw: string | null): ChatTurn[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed)
      ? parsed.filter((t): t is ChatTurn => !!t && (t.role === 'user' || t.role === 'assistant') && typeof t.content === 'string')
      : []
  } catch {
    return []
  }
}
