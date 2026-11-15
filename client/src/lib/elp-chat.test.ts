import { describe, it, expect } from 'vitest'
import {
  parseRouteHeader,
  readElpStream,
  splitImages,
  linkCitations,
  citationHost,
  speakableText,
  translationSystemPrompt,
  translateCommand,
  stripCommand,
  toWireMessages,
  previousIntent,
  serializeConversation,
  deserializeConversation,
  type ChatTurn,
} from './elp-chat'

function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c))
      controller.close()
    },
  })
}

const route = { intent: 'web_search', reason: 'keyword:"latest"', confidence: 0.9, platform: 'perplexity', model: 'fast', label: 'Perplexity Search', kind: 'chat', fallback: false } as const

describe('parseRouteHeader', () => {
  it('decodes the URI-encoded JSON header', () => {
    expect(parseRouteHeader(encodeURIComponent(JSON.stringify(route)))).toEqual(route)
  })
  it('returns null for missing or garbage values', () => {
    expect(parseRouteHeader(null)).toBeNull()
    expect(parseRouteHeader('%E0%A4%A')).toBeNull()
    expect(parseRouteHeader(encodeURIComponent('{"x":1}'))).toBeNull()
  })
})

describe('readElpStream', () => {
  it('assembles content across split frames and keeps citations from the usage frame', async () => {
    const citations = [{ index: 1, url: 'https://a.example/x', title: 'A' }]
    const frames = [
      `data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant', content: '' } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'Hel' } }] })}\n\nda`,
      `ta: ${JSON.stringify({ choices: [{ delta: { content: 'lo[1]', reasoning_content: 'hmm' } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [], usage: { total_tokens: 3 }, citations })}\n\n`,
      'data: [DONE]\n\n',
    ]
    const updates: string[] = []
    const result = await readElpStream(streamOf(...frames), p => updates.push(p.content))
    expect(result).toMatchObject({ content: 'Hello[1]', reasoning: 'hmm', citations, done: true })
    expect(updates.at(-1)).toBe('Hello[1]')
  })

  it('picks up elp_route from an image answer and in-band errors', async () => {
    const result = await readElpStream(streamOf(
      `data: ${JSON.stringify({ elp_route: route, choices: [{ delta: { content: '' } }] })}\n\n`,
      `data: ${JSON.stringify({ error: { message: 'Provider error (x): boom' } })}\n\n`,
      'data: [DONE]\n\n',
    ), () => {})
    expect(result.route).toEqual(route)
    expect(result.error).toBe('Provider error (x): boom')
  })
})

describe('splitImages', () => {
  it('extracts data-URL and https images, leaving the text', () => {
    const { text, images } = splitImages('Here you go\n\n![a cat](data:image/png;base64,AAAA)\n![b](https://img.example/b.png)')
    expect(text).toBe('Here you go')
    expect(images).toEqual([
      { alt: 'a cat', src: 'data:image/png;base64,AAAA' },
      { alt: 'b', src: 'https://img.example/b.png' },
    ])
  })
  it('ignores non-image links and http images', () => {
    expect(splitImages('[link](https://x.example) ![x](http://insecure.example/x.png)').images).toEqual([])
  })
})

describe('linkCitations', () => {
  const citations = [{ index: 1, url: 'https://a.example' }, { index: 2, url: 'https://b.example' }]
  it('links [n] and [web:n] markers to their sources', () => {
    expect(linkCitations('Rates held[1][web:2]. Unknown[9].', citations))
      .toBe('Rates held[[1]](https://a.example)[[2]](https://b.example). Unknown[9].')
  })
  it('leaves code fences and existing links alone', () => {
    const text = 'see [1](https://keep.example)\n```\narr[1]\n```'
    expect(linkCitations(text, citations)).toBe(text)
  })
  it('is a no-op without citations', () => {
    expect(linkCitations('a[1]', [])).toBe('a[1]')
  })
})

describe('citationHost', () => {
  it('shows the bare host', () => {
    expect(citationHost('https://www.reuters.com/markets/x')).toBe('reuters.com')
    expect(citationHost('not a url')).toBe('not a url')
  })
})

describe('speakableText', () => {
  it('strips markdown, code, citations and URLs for TTS', () => {
    const md = '# Title\n**Bold** answer[1] with `code` and [a link](https://x.example).\n```js\nconst x = 1\n```\n- item https://y.example'
    expect(speakableText(md)).toBe('Title Bold answer with code and a link. item')
  })
  it('caps the length', () => {
    expect(speakableText('a'.repeat(5000), 100)).toHaveLength(100)
  })
})

describe('translation helpers', () => {
  it('builds an interpreter prompt and a forcing command', () => {
    expect(translationSystemPrompt('es')).toContain('into Spanish')
    expect(translateCommand('hello')).toBe('/translate hello')
    expect(stripCommand('/translate hello')).toBe('hello')
    expect(stripCommand('/image a fox')).toBe('a fox')
    expect(stripCommand('plain')).toBe('plain')
  })
})

describe('toWireMessages', () => {
  const turns: ChatTurn[] = [
    { id: '1', role: 'user', content: 'what is this?', attachments: ['data:image/png;base64,AAAA'] },
    { id: '2', role: 'assistant', content: 'A cat.', route: { ...route, intent: 'vision' } },
    { id: '3', role: 'user', content: 'draw it' },
    { id: '4', role: 'assistant', content: '![a cat](data:image/png;base64,BBBB)', route: { ...route, intent: 'image_generation' } },
    { id: '5', role: 'user', content: 'again' },
    { id: '6', role: 'assistant', content: '', error: 'boom' },
    { id: '7', role: 'assistant', content: '', pending: true },
  ]
  it('maps attachments to image parts, drops failed turns, never resends generated images', () => {
    expect(toWireMessages(turns, 'sys')).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: [{ type: 'text', text: 'what is this?' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] },
      { role: 'assistant', content: 'A cat.' },
      { role: 'user', content: 'draw it' },
      { role: 'assistant', content: '[generated image: a cat]' },
      { role: 'user', content: 'again' },
    ])
  })
  it('reports the previous routed intent', () => {
    expect(previousIntent(turns)).toBe('image_generation')
    expect(previousIntent([])).toBeUndefined()
  })
})

describe('conversation persistence', () => {
  it('round-trips without images or pending turns', () => {
    const turns: ChatTurn[] = [
      { id: '1', role: 'user', content: 'hi', attachments: ['data:image/png;base64,AAAA'] },
      { id: '2', role: 'assistant', content: 'pic ![x](data:image/png;base64,BBBB)' },
      { id: '3', role: 'assistant', content: '', pending: true },
    ]
    const restored = deserializeConversation(serializeConversation(turns))
    expect(restored).toEqual([
      { id: '1', role: 'user', content: 'hi' },
      { id: '2', role: 'assistant', content: 'pic ![x](image omitted)' },
    ])
  })
  it('tolerates corrupt storage', () => {
    expect(deserializeConversation('{nope')).toEqual([])
    expect(deserializeConversation(JSON.stringify([{ role: 'x' }]))).toEqual([])
  })
})
