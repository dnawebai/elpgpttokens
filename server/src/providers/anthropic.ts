import Anthropic from '@anthropic-ai/sdk';
import type {
  ChatMessage,
  ChatCompletionResponse,
  ChatCompletionChunk,
  ChatToolCall,
  ChatToolDefinition,
  ChatToolChoice,
  TokenUsage,
} from '@freellmapi/shared/types.js';
import {
  BaseProvider,
  parseRetryAfterMs,
  type CompletionOptions,
  type KeyValidationResult,
  type ProviderHttpError,
} from './base.js';
import type { QuotaObservationContext } from '../services/provider-quota.js';
import { resolveMaxTokens } from '../lib/sampling-params.js';
import { contentToString } from '../lib/content.js';
import { proxyFetch } from '../lib/proxy.js';
import { providerTimeoutMs } from '../lib/provider-timeout.js';

type MessageParam = Anthropic.Beta.BetaMessageParam;
type ContentBlockParam = Anthropic.Beta.BetaContentBlockParam;
type CreateParams = Anthropic.Beta.MessageCreateParamsNonStreaming;
type Effort = NonNullable<NonNullable<CreateParams['output_config']>['effort']>;

/** Non-streaming default keeps the request under SDK HTTP timeouts; streams
 *  have no such limit, so they get room for long answers. */
const DEFAULT_MAX_TOKENS = 16_000;
const DEFAULT_STREAM_MAX_TOKENS = 64_000;

/**
 * Models that run adaptive thinking and accept `thinking: {type: "adaptive",
 * display: "summarized"}`. Every Claude 5-family model does; on Opus 4.6–4.8
 * and Sonnet 4.6 adaptive must be asked for explicitly. Older models (Haiku
 * 4.5, Sonnet 4.5…) take a token budget instead, so they get no `thinking`.
 */
function supportsAdaptiveThinking(modelId: string): boolean {
  return /^claude-(?:fable|mythos|opus|sonnet|haiku)-5/.test(modelId)
    || /^claude-(?:opus-4-[678]|sonnet-4-6)/.test(modelId);
}

/**
 * Models that take the server-side `fallbacks` parameter: on a policy decline
 * the API re-runs the same request on a fallback model inside the same call,
 * so a refusal does not end the user's turn. `"default"` lets the API pick the
 * fallback by refusal category, so no model list has to be maintained here.
 */
function supportsServerSideFallback(modelId: string): boolean {
  return /^claude-(?:fable-5-[12]|opus-5-5|opus-5(?:$|[^-\d])|sonnet-5-5)/.test(modelId);
}

/** OpenAI-scale effort (none|minimal|low|medium|high) onto Claude's scale. */
function toClaudeEffort(effort: CompletionOptions['reasoning_effort']): Effort | undefined {
  switch (effort) {
    case 'none':
    case 'minimal':
    case 'low':
      return 'low';
    case 'medium':
      return 'medium';
    case 'high':
      return 'high';
    default:
      return undefined;
  }
}

function toFinishReason(stop: string | null | undefined): string {
  switch (stop) {
    case 'tool_use':
      return 'tool_calls';
    case 'max_tokens':
    case 'model_context_window_exceeded':
      return 'length';
    case 'refusal':
      return 'content_filter';
    default:
      return 'stop';
  }
}

const IMAGE_MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

function imageBlock(url: string): ContentBlockParam | null {
  const data = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  if (data) {
    const mediaType = data[1].toLowerCase();
    if (!IMAGE_MEDIA_TYPES.has(mediaType)) return null;
    return {
      type: 'image',
      source: { type: 'base64', media_type: mediaType as 'image/png', data: data[2] },
    };
  }
  if (/^https?:\/\//i.test(url)) return { type: 'image', source: { type: 'url', url } };
  return null;
}

/** OpenAI user/assistant content (string or typed parts) as Claude blocks. */
function toContentBlocks(content: ChatMessage['content']): ContentBlockParam[] {
  if (content == null) return [];
  if (typeof content === 'string') return content.length > 0 ? [{ type: 'text', text: content }] : [];
  const blocks: ContentBlockParam[] = [];
  for (const part of content) {
    if (typeof part === 'string') {
      if (part) blocks.push({ type: 'text', text: part });
      continue;
    }
    const type = part.type;
    if (type === 'image_url' || type === 'image') {
      const iu = (part as { image_url?: unknown }).image_url;
      const url = typeof iu === 'string' ? iu : (iu as { url?: string } | undefined)?.url;
      const block = url ? imageBlock(url) : null;
      if (block) blocks.push(block);
      continue;
    }
    if (typeof part.text === 'string' && part.text.length > 0) blocks.push({ type: 'text', text: part.text });
  }
  return blocks;
}

function parseToolArguments(raw: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : { value: parsed };
  } catch {
    return { _raw: raw };
  }
}

export interface AnthropicRequestParts {
  system: string | undefined;
  messages: MessageParam[];
}

/**
 * OpenAI chat messages → Claude system + messages.
 *
 * - Every `system` message joins the top-level `system` prompt, in order.
 * - `tool` results become `tool_result` blocks in a user turn; consecutive
 *   results share ONE user message (splitting parallel results across
 *   messages teaches the model to stop calling tools in parallel).
 * - Assistant `tool_calls` become `tool_use` blocks after the text.
 * - `reasoning_content` is dropped: Claude thinking blocks can't be rebuilt
 *   from text, and a block without its signature is rejected.
 * - Consecutive same-role turns are merged so the transcript alternates.
 */
export function toAnthropicMessages(messages: ChatMessage[]): AnthropicRequestParts {
  const systemParts: string[] = [];
  const out: MessageParam[] = [];

  const push = (role: 'user' | 'assistant', blocks: ContentBlockParam[]) => {
    if (blocks.length === 0) return;
    const last = out[out.length - 1];
    if (last && last.role === role && Array.isArray(last.content)) {
      (last.content as ContentBlockParam[]).push(...blocks);
      return;
    }
    out.push({ role, content: blocks });
  };

  for (const m of messages) {
    switch (m.role) {
      case 'system': {
        const text = contentToString(m.content).trim();
        if (text) systemParts.push(text);
        break;
      }
      case 'user':
        push('user', toContentBlocks(m.content));
        break;
      case 'assistant': {
        const blocks = toContentBlocks(m.content);
        for (const call of m.tool_calls ?? []) {
          blocks.push({
            type: 'tool_use',
            id: call.id,
            name: call.function.name,
            input: parseToolArguments(call.function.arguments),
          });
        }
        push('assistant', blocks);
        break;
      }
      case 'tool':
        push('user', [{
          type: 'tool_result',
          tool_use_id: m.tool_call_id ?? '',
          content: contentToString(m.content),
        }]);
        break;
    }
  }

  return { system: systemParts.length > 0 ? systemParts.join('\n\n') : undefined, messages: out };
}

function toAnthropicTools(tools: ChatToolDefinition[] | undefined): Anthropic.Beta.BetaTool[] | undefined {
  if (!tools?.length) return undefined;
  return tools.map((t) => ({
    name: t.function.name,
    ...(t.function.description ? { description: t.function.description } : {}),
    input_schema: (t.function.parameters as Anthropic.Beta.BetaTool['input_schema'] | undefined)
      ?? { type: 'object', properties: {} },
    ...(t.function.strict ? { strict: true } : {}),
  }));
}

/**
 * OpenAI tool_choice onto Claude. Forced choices (`required`, a pinned
 * function) return a 400 on the current Claude models, so they become `auto`
 * plus an instruction in the system prompt — the documented replacement, and
 * one that works on every model rather than a per-model allow-list.
 */
function toAnthropicToolChoice(
  choice: ChatToolChoice | undefined,
  parallel: boolean | undefined,
): { toolChoice?: Anthropic.Beta.BetaToolChoice; instruction?: string } {
  const disableParallel = parallel === false ? { disable_parallel_tool_use: true } : {};
  if (choice === 'none') return { toolChoice: { type: 'none' } };
  if (choice === 'required') {
    return { toolChoice: { type: 'auto', ...disableParallel }, instruction: 'You must answer by calling one of the available tools.' };
  }
  if (choice && typeof choice === 'object') {
    return {
      toolChoice: { type: 'auto', ...disableParallel },
      instruction: `You must answer by calling the \`${choice.function.name}\` tool.`,
    };
  }
  return parallel === false ? { toolChoice: { type: 'auto', disable_parallel_tool_use: true } } : {};
}

function toUsage(u: {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}): TokenUsage {
  const cached = u.cache_read_input_tokens ?? 0;
  const prompt = (u.input_tokens ?? 0) + cached + (u.cache_creation_input_tokens ?? 0);
  const completion = u.output_tokens ?? 0;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    ...(cached > 0 ? { prompt_tokens_details: { cached_tokens: cached } } : {}),
  };
}

/** SDK errors → the gateway's ProviderHttpError, so the router can read the
 *  status, honour Retry-After, and decide whether to fail over. */
export function toProviderError(err: unknown, signal?: AbortSignal): Error {
  // A client hang-up or the fallback loop's own hedge abort: hand back the
  // marked reason it aborted with, so the loop recognises it and stops without
  // benching a healthy key (the SDK would wrap it as APIUserAbortError).
  if (signal?.aborted && signal.reason instanceof Error) return signal.reason;
  if (err instanceof Anthropic.APIError) {
    const out = new Error(`Anthropic API error ${err.status ?? 'network'}: ${err.message}`) as ProviderHttpError;
    if (typeof err.status === 'number') out.status = err.status;
    const retryAfter = parseRetryAfterMs(err.headers?.get?.('retry-after') ?? null);
    if (retryAfter !== undefined) out.retryAfterMs = retryAfter;
    if (err instanceof Anthropic.APIConnectionTimeoutError) out.message = `Anthropic request timed out (timeout): ${err.message}`;
    return out;
  }
  return err instanceof Error ? err : new Error(String(err));
}

export class AnthropicProvider extends BaseProvider {
  readonly platform = 'anthropic' as const;
  readonly name = 'Anthropic';
  private readonly baseURL?: string;

  constructor(opts: { baseURL?: string } = {}) {
    super();
    this.baseURL = opts.baseURL;
  }

  /** One client per call: keys rotate per request, and the SDK client is a
   *  thin object. Retries are off because the gateway's router owns retry and
   *  failover (it benches the key and moves to the next route). Outbound
   *  traffic goes through proxyFetch so the operator's proxy settings apply. */
  protected client(apiKey: string, timeoutMs: number): Anthropic {
    return new Anthropic({
      apiKey,
      maxRetries: 0,
      timeout: timeoutMs,
      ...(this.baseURL ? { baseURL: this.baseURL } : {}),
      fetch: ((url: string | URL | Request, init?: RequestInit) =>
        proxyFetch(typeof url === 'string' ? url : url instanceof URL ? url.href : url.url, init, this.platform, 'chat', timeoutMs)) as typeof fetch,
    });
  }

  buildParams(messages: ChatMessage[], modelId: string, options: CompletionOptions | undefined, stream: boolean): CreateParams {
    const { system, messages: converted } = toAnthropicMessages(messages);
    const { toolChoice, instruction } = toAnthropicToolChoice(options?.tool_choice, options?.parallel_tool_calls);
    const tools = toAnthropicTools(options?.tools);
    const systemText = [system, tools && instruction].filter(Boolean).join('\n\n');
    const maxTokens = resolveMaxTokens(
      this.platform,
      options?.max_tokens ?? (stream ? DEFAULT_STREAM_MAX_TOKENS : DEFAULT_MAX_TOKENS),
      options?.contextBudget,
    ) ?? DEFAULT_MAX_TOKENS;
    const effort = toClaudeEffort(options?.reasoning_effort);
    const stop = options?.stop == null ? undefined : Array.isArray(options.stop) ? options.stop : [options.stop];
    const fallback = supportsServerSideFallback(modelId);

    // temperature / top_p / top_k are deliberately never sent: API version
    // 2026-10-21 (what this SDK speaks) rejects them on every model.
    return {
      model: modelId,
      max_tokens: maxTokens,
      messages: converted,
      // Caches the conversation prefix across turns; a prefix below the
      // model's minimum silently doesn't cache, which costs nothing.
      cache_control: { type: 'ephemeral' },
      ...(systemText ? { system: systemText } : {}),
      ...(tools ? { tools } : {}),
      ...(tools && toolChoice ? { tool_choice: toolChoice } : {}),
      ...(stop?.length ? { stop_sequences: stop } : {}),
      ...(supportsAdaptiveThinking(modelId) ? { thinking: { type: 'adaptive', display: 'summarized' } } : {}),
      ...(effort ? { output_config: { effort } } : {}),
      ...(fallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } : {}),
    } as CreateParams;
  }

  async chatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
    _quotaContext?: QuotaObservationContext,
  ): Promise<ChatCompletionResponse> {
    const timeoutMs = options?.timeoutMs ?? providerTimeoutMs(this.platform, 120_000);
    let msg: Anthropic.Beta.BetaMessage;
    try {
      msg = await this.client(apiKey, timeoutMs).beta.messages.create(
        this.buildParams(messages, modelId, options, false),
        { signal: options?.signal },
      );
    } catch (err) {
      throw toProviderError(err, options?.signal);
    }

    let text = '';
    let reasoning = '';
    const toolCalls: ChatToolCall[] = [];
    for (const block of msg.content) {
      if (block.type === 'text') text += block.text;
      else if (block.type === 'thinking') reasoning += block.thinking;
      else if (block.type === 'tool_use') {
        toolCalls.push({ id: block.id, type: 'function', function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) } });
      }
    }

    return {
      id: msg.id,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: msg.model,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: text,
          ...(reasoning ? { reasoning_content: reasoning } : {}),
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: toFinishReason(msg.stop_reason),
      }],
      usage: toUsage(msg.usage),
    };
  }

  async *streamChatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
    _quotaContext?: QuotaObservationContext,
  ): AsyncGenerator<ChatCompletionChunk> {
    // Streams only bound time-to-headers; long generations are expected.
    const timeoutMs = options?.timeoutMs ?? providerTimeoutMs(this.platform, 120_000);
    const created = Math.floor(Date.now() / 1000);
    let id = this.makeId();
    let model = modelId;
    let inputUsage: TokenUsage | undefined;
    let outputTokens = 0;
    let stopReason: string | null = null;
    let sawStop = false;

    // Tool inputs arrive as JSON fragments; they are emitted whole when the
    // block closes, the same shape the other adapters use for tool deltas.
    const pendingTools = new Map<number, { id: string; name: string; json: string }>();
    let toolIndex = 0;

    const chunk = (delta: ChatCompletionChunk['choices'][0]['delta'], finish: string | null = null, usage?: TokenUsage): ChatCompletionChunk => ({
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finish }],
      ...(usage ? { usage } : {}),
    });

    let stream;
    try {
      stream = this.client(apiKey, timeoutMs).beta.messages.stream(
        this.buildParams(messages, modelId, options, true),
        { signal: options?.signal },
      );
    } catch (err) {
      throw toProviderError(err, options?.signal);
    }

    try {
      for await (const event of stream) {
        switch (event.type) {
          case 'message_start':
            id = event.message.id;
            model = event.message.model;
            inputUsage = toUsage(event.message.usage);
            yield chunk({ role: 'assistant', content: '' });
            break;
          case 'content_block_start':
            if (event.content_block.type === 'tool_use') {
              pendingTools.set(event.index, { id: event.content_block.id, name: event.content_block.name, json: '' });
            }
            break;
          case 'content_block_delta':
            if (event.delta.type === 'text_delta') {
              yield chunk({ content: event.delta.text });
            } else if (event.delta.type === 'thinking_delta') {
              if (event.delta.thinking) yield chunk({ reasoning_content: event.delta.thinking });
            } else if (event.delta.type === 'input_json_delta') {
              const tool = pendingTools.get(event.index);
              if (tool) tool.json += event.delta.partial_json;
            }
            break;
          case 'content_block_stop': {
            const tool = pendingTools.get(event.index);
            if (tool) {
              pendingTools.delete(event.index);
              const call = {
                index: toolIndex++,
                id: tool.id,
                type: 'function' as const,
                function: { name: tool.name, arguments: tool.json || '{}' },
              };
              yield chunk({ tool_calls: [call] as unknown as ChatToolCall[] });
            }
            break;
          }
          case 'message_delta':
            stopReason = event.delta.stop_reason ?? stopReason;
            outputTokens = event.usage?.output_tokens ?? outputTokens;
            break;
          case 'message_stop':
            sawStop = true;
            break;
        }
      }
    } catch (err) {
      throw toProviderError(err, options?.signal);
    }

    if (!sawStop) {
      throw new Error(`${this.name} stream ended unexpectedly (no message_stop) — connection reset or truncated upstream`);
    }

    const prompt = inputUsage?.prompt_tokens ?? 0;
    const usage: TokenUsage = {
      ...(inputUsage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }),
      completion_tokens: outputTokens,
      total_tokens: prompt + outputTokens,
    };
    yield chunk({}, toFinishReason(stopReason), usage);
  }

  /** GET /v1/models is free, so a key check never spends tokens. */
  async validateKey(apiKey: string): Promise<KeyValidationResult> {
    try {
      await this.client(apiKey, 15_000).models.list({ limit: 1 });
      return true;
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
        return { valid: false, error: `${this.name} key validation failed (HTTP ${err.status}): ${err.message}` };
      }
      throw toProviderError(err);
    }
  }
}
