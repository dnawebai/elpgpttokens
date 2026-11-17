import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
  ChatMessage,
  SearchCitation,
  TokenUsage,
} from '@freellmapi/shared/types.js';
import { BaseProvider, providerHttpError, type CompletionOptions, type KeyValidationResult } from './base.js';
import { contentToString } from '../lib/content.js';
import { providerTimeoutMs, streamStallTimeoutMs } from '../lib/provider-timeout.js';
import { resolveMaxTokens } from '../lib/sampling-params.js';
import { recordQuotaObservationsFromResponse, type QuotaObservationContext } from '../services/provider-quota.js';

/**
 * Perplexity Agent API (`POST /v1/agent`).
 *
 * Sonar Chat Completions support ended on 2026-09-27, so this adapter speaks
 * the Agent API directly: an `input` array of message items, top-level
 * `instructions` for the system prompt, and an `effort` preset (fast | low |
 * medium | high | xhigh) in place of a model. Answers carry inline `[n]` (or
 * `[web:n]`) markers; the sources come back as a `search_results` output item
 * whose result ids match the markers. They are surfaced as `citations` on the
 * chat response (and on the final stream chunk) so /chat can render them.
 *
 * Model ids for this platform are either an effort preset (`fast`, `low`, …)
 * or an explicit `vendor/model` id served through the Agent API, which then
 * gets the `web_search` tool attached (explicit models don't search unless the
 * tool is present).
 */

export const PERPLEXITY_BASE_URL = 'https://api.perplexity.ai';
export const PERPLEXITY_EFFORTS = ['fast', 'low', 'medium', 'high', 'xhigh'] as const;
type Effort = typeof PERPLEXITY_EFFORTS[number];

function isEffort(id: string): id is Effort {
  return (PERPLEXITY_EFFORTS as readonly string[]).includes(id);
}

interface SearchResult {
  id?: number | string;
  title?: string;
  url?: string;
  date?: string;
  snippet?: string;
  source?: string;
}

interface OutputItem {
  type?: string;
  role?: string;
  content?: { type?: string; text?: string }[];
  results?: SearchResult[];
}

interface AgentResponse {
  id?: string;
  model?: string;
  created_at?: number;
  status?: string;
  output?: OutputItem[];
  output_text?: string;
  error?: { message?: string } | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    prompt_tokens?: number;
    completion_tokens?: number;
  };
}

type InputContent = string | Array<{ type: 'input_text'; text: string } | { type: 'input_image'; image_url: string }>;

function toInputContent(content: ChatMessage['content']): InputContent {
  if (!Array.isArray(content)) return contentToString(content);
  const parts: Exclude<InputContent, string> = [];
  for (const part of content) {
    if (typeof part === 'string') {
      if (part) parts.push({ type: 'input_text', text: part });
      continue;
    }
    if (part.type === 'image_url' || part.type === 'image') {
      const iu = (part as { image_url?: unknown }).image_url;
      const url = typeof iu === 'string' ? iu : (iu as { url?: string } | undefined)?.url;
      if (url && /^(?:data:image\/|https:\/\/)/i.test(url)) parts.push({ type: 'input_image', image_url: url });
      continue;
    }
    if (typeof part.text === 'string' && part.text) parts.push({ type: 'input_text', text: part.text });
  }
  return parts.length === 1 && parts[0].type === 'input_text' ? parts[0].text : parts;
}

/** Build the Agent API body. Exported for tests. */
export function buildAgentRequest(messages: ChatMessage[], modelId: string, options: CompletionOptions | undefined, stream: boolean) {
  const instructions = messages
    .filter(m => m.role === 'system')
    .map(m => contentToString(m.content).trim())
    .filter(Boolean)
    .join('\n\n');

  // Tool turns have no Agent API equivalent here; their text still informs
  // the answer, so they are replayed as user context rather than dropped.
  const input = messages
    .filter(m => m.role !== 'system')
    .map(m => {
      if (m.role === 'tool') {
        return { type: 'message' as const, role: 'user' as const, content: `Tool result: ${contentToString(m.content)}` };
      }
      return {
        type: 'message' as const,
        role: m.role === 'assistant' ? 'assistant' as const : 'user' as const,
        content: m.role === 'assistant' ? contentToString(m.content) : toInputContent(m.content),
      };
    })
    .filter(item => (typeof item.content === 'string' ? item.content.length > 0 : item.content.length > 0));

  const maxOutput = resolveMaxTokens('perplexity', options?.max_tokens, options?.contextBudget);
  return {
    ...(isEffort(modelId) ? { effort: modelId } : { model: modelId, tools: [{ type: 'web_search' }] }),
    input,
    ...(instructions ? { instructions } : {}),
    ...(maxOutput ? { max_output_tokens: maxOutput } : {}),
    ...(stream ? { stream: true } : {}),
  };
}

function toCitations(results: SearchResult[] | undefined): SearchCitation[] {
  if (!results?.length) return [];
  return results
    .filter((r): r is SearchResult & { url: string } => typeof r.url === 'string' && /^https?:\/\//i.test(r.url))
    .map((r, i) => ({
      index: typeof r.id === 'number' ? r.id : Number.parseInt(String(r.id ?? ''), 10) || i + 1,
      url: r.url,
      ...(r.title ? { title: r.title } : {}),
      ...(r.snippet ? { snippet: r.snippet.slice(0, 300) } : {}),
      ...(r.date ? { date: r.date } : {}),
    }));
}

function citationsFrom(output: OutputItem[] | undefined): SearchCitation[] {
  return (output ?? []).flatMap(item => (item.type === 'search_results' ? toCitations(item.results) : []));
}

function textFrom(res: AgentResponse): string {
  if (typeof res.output_text === 'string') return res.output_text;
  return (res.output ?? [])
    .filter(item => item.type === 'message')
    .flatMap(item => item.content ?? [])
    .filter(part => part.type === 'output_text' && typeof part.text === 'string')
    .map(part => part.text)
    .join('');
}

function toUsage(u: AgentResponse['usage']): TokenUsage {
  const prompt = u?.input_tokens ?? u?.prompt_tokens ?? 0;
  const completion = u?.output_tokens ?? u?.completion_tokens ?? 0;
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: u?.total_tokens ?? prompt + completion };
}

async function errorFor(res: Response, name: string): Promise<Error> {
  let body: any = null;
  try { body = await res.json(); } catch { /* status is still useful */ }
  const detail = body?.error?.message ?? body?.detail ?? body?.message ?? res.statusText;
  return providerHttpError(res, `${name} API error ${res.status}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`, body);
}

export class PerplexityProvider extends BaseProvider {
  readonly platform = 'perplexity' as const;
  readonly name = 'Perplexity';
  private readonly baseUrl: string;

  constructor(opts: { baseUrl?: string } = {}) {
    super();
    this.baseUrl = (opts.baseUrl ?? PERPLEXITY_BASE_URL).replace(/\/+$/, '');
  }

  /** The only key check is a malformed request to the billed endpoint; don't
   *  repeat it every few minutes (see BaseProvider.supportsKeyPolling). */
  override get supportsKeyPolling(): boolean {
    return false;
  }

  private headers(apiKey: string): Record<string, string> {
    return { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${apiKey}` };
  }

  async chatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
    quotaContext?: QuotaObservationContext,
  ): Promise<ChatCompletionResponse> {
    // Agentic search runs several rounds; higher efforts take minutes.
    const timeoutMs = options?.timeoutMs ?? providerTimeoutMs(this.platform, 180_000);
    const res = await this.fetchWithTimeout(`${this.baseUrl}/v1/agent`, {
      method: 'POST',
      headers: this.headers(apiKey),
      body: JSON.stringify(buildAgentRequest(messages, modelId, options, false)),
    }, timeoutMs, { signal: options?.signal, timeoutBounds: 'request' });
    if (quotaContext) recordQuotaObservationsFromResponse(res, { ...quotaContext, platform: this.platform });
    if (!res.ok) throw await errorFor(res, this.name);

    const body = await res.json() as AgentResponse;
    if (body.status === 'failed') {
      throw Object.assign(new Error(`${this.name} run failed: ${body.error?.message ?? 'unknown error'}`), { status: 502 });
    }
    const citations = citationsFrom(body.output);
    return {
      id: body.id ?? this.makeId(),
      object: 'chat.completion',
      created: body.created_at ?? Math.floor(Date.now() / 1000),
      model: body.model ?? modelId,
      choices: [{
        index: 0,
        message: { role: 'assistant', content: textFrom(body) },
        finish_reason: body.status === 'incomplete' ? 'length' : 'stop',
      }],
      usage: toUsage(body.usage),
      ...(citations.length > 0 ? { citations } : {}),
    };
  }

  async *streamChatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
    quotaContext?: QuotaObservationContext,
  ): AsyncGenerator<ChatCompletionChunk> {
    const timeoutMs = options?.timeoutMs ?? providerTimeoutMs(this.platform, 180_000);
    const res = await this.fetchWithTimeout(`${this.baseUrl}/v1/agent`, {
      method: 'POST',
      headers: this.headers(apiKey),
      body: JSON.stringify(buildAgentRequest(messages, modelId, options, true)),
    }, timeoutMs, { signal: options?.signal });
    if (quotaContext) recordQuotaObservationsFromResponse(res, { ...quotaContext, platform: this.platform });
    if (!res.ok) throw await errorFor(res, this.name);

    const reader = res.body?.getReader();
    if (!reader) throw new Error('No response body');

    const created = Math.floor(Date.now() / 1000);
    let id = this.makeId();
    let model = modelId;
    const chunk = (delta: ChatCompletionChunk['choices'][0]['delta'], finish: string | null = null, extra: Partial<ChatCompletionChunk> = {}): ChatCompletionChunk => ({
      id, object: 'chat.completion.chunk', created, model,
      choices: [{ index: 0, delta, finish_reason: finish }],
      ...extra,
    });

    // Search can take a while before the first token; give the first read the
    // whole chat budget, then the normal stall watchdog.
    const stallMs = streamStallTimeoutMs(this.platform);
    const firstByteMs = this.firstByteBudgetMs(timeoutMs, stallMs);
    const decoder = new TextDecoder();
    let buffer = '';
    let first = true;
    let sentRole = false;
    let citations: SearchCitation[] = [];
    let finished = false;

    try {
      while (!finished) {
        const { done, value } = first
          ? await this.readWithStallTimeout(() => reader.read(), firstByteMs, this.firstByteTimeoutMessage(firstByteMs))
          : await this.readWithStallTimeout(() => reader.read(), stallMs);
        first = false;
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE events are separated by a blank line.
        let sep: number;
        while ((sep = buffer.search(/\r?\n\r?\n/)) !== -1) {
          const rawEvent = buffer.slice(0, sep);
          buffer = buffer.slice(sep).replace(/^\r?\n\r?\n/, '');
          const data = rawEvent
            .split(/\r?\n/)
            .filter(line => line.startsWith('data:'))
            .map(line => line.slice(5).replace(/^ /, ''))
            .join('\n');
          if (!data || data === '[DONE]') continue;
          let event: any;
          try { event = JSON.parse(data); } catch { continue; }

          switch (event?.type) {
            case 'response.created':
            case 'response.in_progress':
              if (event.response?.id) id = event.response.id;
              if (event.response?.model) model = event.response.model;
              break;
            case 'response.output_text.delta':
              if (typeof event.delta === 'string' && event.delta) {
                if (!sentRole) { sentRole = true; yield chunk({ role: 'assistant', content: '' }); }
                yield chunk({ content: event.delta });
              }
              break;
            case 'response.output_item.done':
              if (event.item?.type === 'search_results') citations = [...citations, ...toCitations(event.item.results)];
              break;
            case 'response.completed':
            case 'response.incomplete': {
              const response = (event.response ?? {}) as AgentResponse;
              if (response.model) model = response.model;
              const final = citationsFrom(response.output);
              if (final.length > 0) citations = final;
              if (!sentRole) {
                // Some runs only report the text on the terminal event.
                const text = textFrom(response);
                sentRole = true;
                yield chunk({ role: 'assistant', content: '' });
                if (text) yield chunk({ content: text });
              }
              yield chunk({}, event.type === 'response.incomplete' ? 'length' : 'stop', {
                usage: toUsage(response.usage),
                ...(citations.length > 0 ? { citations } : {}),
              });
              finished = true;
              break;
            }
            case 'response.failed':
            case 'error': {
              const message = event.response?.error?.message ?? event.error?.message ?? event.message ?? 'stream failed';
              throw Object.assign(new Error(`${this.name} stream error: ${message}`), { status: 502 });
            }
          }
          if (finished) break;
        }
      }
    } finally {
      reader.cancel().catch(() => { /* upstream already gone */ });
    }

    if (!finished) {
      throw new Error(`${this.name} stream ended unexpectedly (no response.completed) — connection reset or truncated upstream`);
    }
  }

  /**
   * An empty body is rejected before any search runs: 400/422 means the key
   * authenticated, 401/403 means it did not. Nothing is billed.
   */
  async validateKey(apiKey: string): Promise<KeyValidationResult> {
    const res = await this.fetchWithTimeout(`${this.baseUrl}/v1/agent`, {
      method: 'POST',
      headers: this.headers(apiKey),
      body: '{}',
    }, 15_000, { timeoutBounds: 'request' });
    if (res.status === 401 || res.status === 403) return this.validationResult(res);
    if (res.status === 429 || res.status >= 500) throw await errorFor(res, this.name);
    return true;
  }
}
