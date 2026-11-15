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

## Public chat (elpgpt.com/chat)

Set `ELPGPT_PUBLIC_CHAT=1` to open `/chat` to the public. It is off by default,
because anonymous visitors spend the operator's quota. With it on, a browser
that has no dashboard session gets the public chat instead of the login
screen; the operator still gets the full dashboard chat.

| Who | Models | Daily messages (default) | Extras |
|---|---|---|---|
| Guest (no account) | Free models | `ELPGPT_VISITOR_DAILY_LIMIT` (10) | |
| Free member | Free models | `ELPGPT_FREE_DAILY_LIMIT` (30) | |
| Subscriber | Claude, ChatGPT, Perplexity, GPT Image, within a premium allowance | `ELPGPT_SUBSCRIBER_DAILY_LIMIT` (300) | Voice, live interpreter |

Every tier gets the same auto-routing; free tiers just route onto the free pool,
and subscribers get cost-efficient premium routes (see
[Premium allowance](#premium-allowance-fair-use)). Every tier sends only the
recent part of a conversation: the newest turns that fit
`ELPGPT_PUBLIC_CONTEXT_CHARS` (48,000 characters, about 12K tokens), plus any
system instructions and always the latest message. Each message resends the
history, so this is what keeps long chats from getting expensive.

### Premium allowance (fair use)

A subscription is a flat fee, but premium calls cost real money and their
costs differ by orders of magnitude. With API prices as of November 2026, an
everyday chat on Haiku or Luna costs well under a cent. A high-effort coding
answer on Sonnet costs a few cents, the same on Opus around ten, an image about
five, and a minute of live interpreting about three. Three layers keep a
subscription profitable without making it feel limited:

1. **Cost-efficient routes.** Subscribers get `SUBSCRIBER_ROUTES`
   (`server/src/services/elp-router.ts`). Everyday chat and translation run on
   Claude Haiku 5.5 or GPT-6 Luna, writing and images-in-questions on Claude
   Sonnet 5.5, and code and reasoning on Sonnet at high effort. Search and
   image creation are the same as the default routes. Opus stays in the
   operator's own chat. Override with `ELPGPT_SUBSCRIBER_ROUTES`, which uses the
   same format as `ELPGPT_ROUTES`.
2. **An allowance in estimated provider cost:** `ELPGPT_PREMIUM_DAILY_USD`
   (default `1`) and `ELPGPT_PREMIUM_MONTHLY_USD` (default `4`). Tokens are
   costed from the usage the gateway logs for every call, with a 20% margin;
   images, dictation and live interpreting are charged fixed estimates. The
   daily ceiling keeps one afternoon from burning the month. The monthly one
   keeps heavy users profitable: $4 is about half of what a $96/year plan
   brings in after card fees. The prices behind this live in
   `server/src/services/premium-usage.ts`.
3. **A soft landing.** When the allowance runs out, the subscriber keeps
   chatting on the free models until it resets (midnight UTC, or the 1st of the
   month), so "unlimited messages" stays true. Voice and the live interpreter
   pause until then. Subscribers see only a share ("Premium 72% left today") and
   the reset time, never dollar amounts. The operator sees each subscriber's
   spend in **Chat → Members**.

The live interpreter's audio goes straight from the browser to OpenAI, so its
minutes can't be measured here. They are charged ahead in 5-minute blocks: one
when a session starts, and another as the interpreter asks to keep going
(`/api/public/realtime/extend`). When a block no longer fits, the interpreter
stops and says why. A modified client could skip those requests, so treat the
interpreter as the least tightly bounded cost.

Set either ceiling to `unlimited` to remove it.
Guests can sign up from the chat (`ELPGPT_PUBLIC_SIGNUP=0` closes sign-ups), and
`ELPGPT_VISITOR_DAILY_LIMIT=0` requires an account to chat at all.

**Subscriptions:** members pay through Stripe (see
[Subscriptions with Stripe](#subscriptions-with-stripe)). The operator can also
grant or remove the Subscriber plan by hand, or disable an account, from
**Chat → Members** in the dashboard.

**How it stays safe:**

- Members are not dashboard users. They have their own tables (`elp_members`,
  `elp_member_sessions`) and tokens (`x-member-token`), and a member token can
  never open `/api/*`.
- `/api/public/chat` checks the caller's plan and daily quota, keeps only
  `messages` and `stream`, forces the model to `elpgpt-auto`, and hands the
  request to the gateway in-process with the unified key injected server-side.
  The key never reaches a browser.
- Premium routing is switched off by a request property set on the server, not
  by a header, so a client cannot unlock it.
- Guests are counted by a keyed hash of their IP (raw IPs are never stored).
  Behind a reverse proxy, set `TRUST_PROXY` so the real client IP is used;
  otherwise every guest shares the proxy's quota.
- Sign-up and sign-in are throttled per IP, and disabling a member signs them
  out everywhere.

## Subscriptions with Stripe

A free member clicks **Upgrade**, picks monthly or yearly, and pays on Stripe's
hosted Checkout page; card details never touch this server. Stripe then calls
the webhook and the member becomes a Subscriber, usually within seconds (the
chat waits for it and says so). **Manage subscription** opens Stripe's customer
portal to change the card or cancel. When a subscription ends or payment fails
for good, the member drops back to Free.

### Setup

1. In the Stripe dashboard, create a product (for example "ELPGPT Subscriber")
   with a monthly and/or a yearly **recurring** price. Copy the price IDs
   (`price_…`). If you use Stripe Tax, give the product a digital-service tax
   category, such as "Artificial Intelligence as a Service (AIaaS) - Cloud
   Based - Personal Use" or "Software as a Service (SaaS) - Personal Use", not
   a physical-goods one, and set `STRIPE_AUTOMATIC_TAX=1` so Checkout adds the
   tax.
2. Add a webhook endpoint: `https://<your-host>/api/public/billing/webhook`,
   with the events `checkout.session.completed`,
   `customer.subscription.created`, `customer.subscription.updated`,
   `customer.subscription.deleted`, `customer.subscription.paused` and
   `customer.subscription.resumed`. Copy its signing secret (`whsec_…`).
3. Turn on the customer portal (Settings → Billing → Customer portal) and allow
   cancellation and payment method updates.
4. Set the environment and restart:

   ```bash
   STRIPE_SECRET_KEY=sk_live_...
   STRIPE_WEBHOOK_SECRET=whsec_...
   STRIPE_PRICE_MONTHLY=price_...   # either or both
   STRIPE_PRICE_YEARLY=price_...
   ELPGPT_PUBLIC_URL=https://elpgpt.com   # where Checkout sends people back
   STRIPE_AUTOMATIC_TAX=1                 # only with Stripe Tax set up
   ```

Billing turns on only when the public chat is on and the key, the webhook
secret and at least one price are set. The Upgrade dialog shows the amounts
from Stripe, so changing a price is done in Stripe, not here. Use test-mode keys
(`sk_test_…`) and the Stripe CLI (`stripe listen --forward-to
localhost:3001/api/public/billing/webhook`) to try it locally.

### How it stays correct

- The plan changes only when a **signed** webhook arrives, never because the
  browser came back from Checkout. The webhook is checked against the exact
  bytes Stripe signed (it is mounted before the JSON parsers).
- Stripe doesn't guarantee event order, so every event re-reads the
  subscription from Stripe instead of trusting the payload. Replays and
  duplicates are harmless.
- The Stripe customer is created before Checkout, so every event maps back to a
  member.
- `active`, `trialing` and `past_due` (while Stripe retries the card) keep the
  Subscriber plan; anything else returns the member to Free.
- Only subscriptions to the configured prices count, so other products on the
  same Stripe account are ignored. Another app may even sell the **same** price
  on the same account (for example an existing site's Pro plan): its checkouts
  are ignored too, because only sessions ELPGPT created (tagged with the member
  id) are trusted, and only customers ELPGPT created are matched to members.
- A plan the operator set by hand in **Chat → Members** is never changed by
  billing.
- A webhook that fails to process answers 500, so Stripe delivers it again.

## Not in this release

- **Two-way conversations.** The live interpreter translates one direction at a
  time, into the chosen language. A two-person call needs one session per
  direction with separate audio tracks, as OpenAI recommends.
