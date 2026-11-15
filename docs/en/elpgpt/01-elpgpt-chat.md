# ELPGPT: one chat over Claude, ChatGPT and Perplexity

ELPGPT puts the paid frontier models behind one conversation and picks the right
one for every message, so a user doesn't need a separate subscription for each.

- **`/chat`** — the chat page in the dashboard.
- **`elpgpt-auto`** — the virtual model behind it, usable from any
  OpenAI-compatible client at `POST /v1/chat/completions`.

## How auto-routing works

Every message is classified by intent, deterministically and in microseconds
(`server/src/services/intent.ts`, English/Spanish/Portuguese), then sent down
that intent's ladder of models:

| Intent | Typical prompt | Default route |
|---|---|---|
| `web_search` | "search…", "latest", "news today", "busca…", a price or score | Perplexity Agent API (`fast`), cited |
| `image_generation` | "create an image of…", "dibuja…", `/image …` | OpenAI GPT Image 2.6 Flare |
| `code` | a stack trace, code fence, "fix this bug" | Claude Opus 5.5 (effort `high`) → GPT-6.1 Sol |
| `reasoning` | math, "step by step", "compare pros and cons" | Claude Opus 5.5 (effort `high`) → GPT-6.1 Sol |
| `writing` | "write/draft/summarize…", "redacta un correo…" | Claude Opus 5.5 → GPT-6.1 Sol |
| `vision` | an attached image | Claude Opus 5.5 → GPT-6.1 Sol |
| `translation` | "translate…", "traduce al inglés…" | GPT-6.1 Sol → Claude Opus 5.5 |
| `chat` | everything else | GPT-6.1 Sol → Claude Opus 5.5 |

The ladder is a strict group chain, so failover, key rotation, cooldowns,
logging and analytics are exactly the normal router's. If the first model fails,
the next one in the ladder answers; the request never silently drops to an
unrelated model.

**When a provider has no key**, that route is skipped. When no premium route is
usable for an intent, the request falls back to the free pool (`auto`). A search
prompt is then still grounded: if any search engine is configured (Tavily,
Brave, Exa…), its results are injected and the model cites them.

Short follow-ups to an image ("make it darker", "otra versión") stay on the image
route and reuse the previous prompt.

### Seeing the decision

Every `elpgpt-auto` response carries an `X-ELP-Route` header: URI-encoded JSON
with `intent`, `reason`, `confidence`, `platform`, `model`, `label`, `kind`
(`chat` or `image`) and `fallback`. `X-Routed-Via` still names the model that
actually answered after any failover. Search answers carry a `citations` array
(on the response, or on the final usage frame of a stream), and its `index`
values match the `[n]` markers in the text.

`POST /api/elp/route` (dashboard session) previews the decision for typed text
without calling any model; `/chat` uses it for the live "Routing to…" badge.
`GET /api/elp/status` lists which providers are connected and the current
route per intent.

## Setup

1. Add keys on the **Keys** page: Anthropic, OpenAI, Perplexity. Any subset
   works; missing ones are skipped. They can also be imported from a `.env` file
   as `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` and `PERPLEXITY_API_KEY` (only
   those exact names; `OPENAI_BASE_URL` and the like are ignored).
2. Open **Chat**.

The premium models are added to the catalog at startup with auto-routing
**off**, so plain `auto` never spends on them. Only `elpgpt-auto` (or naming
a model explicitly) reaches them. You can opt one into `auto` from the Models
page.

### Changing the routes

Set `ELPGPT_ROUTES` to override any intent's ladder. Intents you leave out keep
the defaults, and invalid entries are ignored with a warning:

```bash
ELPGPT_ROUTES='{"chat":[{"platform":"anthropic","model":"claude-opus-5-5","effort":"low"}],"web_search":[{"platform":"perplexity","model":"low"}]}'
```

Models named here are added to the catalog automatically. For Perplexity the
"model" is an Agent API effort preset (`fast`, `low`, `medium`, `high`,
`xhigh`) or an explicit `vendor/model` id, which gets the `web_search` tool
attached.

## Tools in /chat

- **Translate**: pick a target language; every message is translated, with the
  source language detected automatically.
- **Voice**: the mic transcribes speech (OpenAI `gpt-transcribe` when connected,
  otherwise the free speech-to-text pool). **Read replies aloud** speaks each
  answer through the text-to-speech pool. With it on, a spoken message is sent
  straight away: a hands-free conversation. Combined with Translate, it works as
  a turn-by-turn interpreter.
- **Live interpreter**: real-time speech-to-speech translation with OpenAI's
  `gpt-realtime-translate`. Pick a target language and an audio source (your
  microphone, or a browser tab such as a video call or YouTube) and hear the
  translation a moment later, with original and translated transcripts on
  screen. The source language is detected automatically. See
  [How the live interpreter connects](#how-the-live-interpreter-connects).
- **Images**: generated images show inline with a download link; attach images
  for vision questions.
- **Model**: Auto by default, or pin one premium model.

## How the live interpreter connects

1. The browser captures audio and creates a WebRTC offer with an `oai-events`
   data channel.
2. It sends the offer and target language to `POST /api/elp/realtime/translate`
   (dashboard session).
3. The server reserves an OpenAI key from the pool and mints a short-lived
   translation client secret (`/v1/realtime/translations/client_secrets`). It
   posts the offer with that secret to `/v1/realtime/translations/calls` and
   returns only the SDP answer.
4. Audio then flows directly between the browser and OpenAI. Translated speech
   arrives as an audio track, and transcripts arrive on the data channel. Stop
   sends `session.close` so pending translation is flushed before hanging up.

Neither the operator's key nor the client secret ever reaches the browser, and
the dashboard CSP (`connect-src 'self'`) stays as it is. A rejected key is
skipped in favor of the next one. Set `ELPGPT_LIVE_TRANSLATE_MODEL` to use a
different model id. OpenAI bills realtime translation to the operator's key.

## Provider notes

- **Anthropic** uses the official `@anthropic-ai/sdk` (native Messages API,
  API version `2026-10-21`). Adaptive thinking is on with summarized reasoning,
  and refusals fall back server-side (`fallbacks: "default"`) on models that
  support it. `temperature`/`top_p`/`top_k` are never sent: that API version
  rejects them. Forced `tool_choice` becomes `auto` plus an instruction,
  because current Claude models reject forced tool choice.
- **Perplexity** uses the Agent API (`/v1/agent`). Sonar Chat Completions
  support ended on 2026-09-27.
- **OpenAI** uses Chat Completions with `max_completion_tokens`, and default
  sampling only on reasoning models (GPT-5 onward, o-series). Images and
  transcription are native in `services/media.ts`.

## Not in this release

- **Public visitors and subscribers.** `/chat` is behind the dashboard login,
  like every other page: the gateway has one operator account and a unified
  key, and that key must never be shipped to visitors' browsers. Serving
  elpgpt.com/chat to the public needs user accounts, per-user quotas and billing
  in front of `elpgpt-auto`.
- **Two-way conversations.** The live interpreter translates one direction at a
  time, into the chosen language. A two-person call needs one session per
  direction with separate audio tracks, as OpenAI recommends.
