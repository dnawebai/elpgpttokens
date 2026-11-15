/**
 * Stripe subscriptions for the public elpgpt.com/chat.
 *
 * Members pay on Stripe's hosted Checkout page (card data never touches this
 * server); Stripe webhooks keep their plan in sync; Stripe's customer portal
 * handles card changes and cancellation. Prices live in the operator's Stripe
 * dashboard and are referenced by ID (STRIPE_PRICE_MONTHLY / _YEARLY), so the
 * amounts are never hard-coded here.
 *
 * Ordering: Stripe does not guarantee webhook order. The Stripe customer is
 * created (and stored on the member) BEFORE Checkout, so every subscription
 * event maps to a member; and each event re-reads the subscription from Stripe
 * instead of trusting the possibly stale snapshot in the payload. Handling an
 * event twice is harmless: it only sets state.
 */
import Stripe from 'stripe';
import { proxyFetch } from '../lib/proxy.js';
import { publicChatEnabled, getMember, memberByStripeCustomer, setStripeCustomer, applySubscriptionState, type Member } from './members.js';

export type BillingInterval = 'month' | 'year';

/** Statuses that keep the Subscriber plan. past_due keeps access while Stripe
 *  retries a failed payment; it lapses to unpaid/canceled if retries fail. */
const ACCESS_STATUSES = new Set(['active', 'trialing', 'past_due']);

const SUBSCRIPTION_EVENTS = new Set([
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'customer.subscription.paused',
  'customer.subscription.resumed',
]);

export class BillingError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message);
  }
}

function priceIds(): Partial<Record<BillingInterval, string>> {
  const month = process.env.STRIPE_PRICE_MONTHLY?.trim();
  const year = process.env.STRIPE_PRICE_YEARLY?.trim();
  return { ...(month ? { month } : {}), ...(year ? { year } : {}) };
}

/** STRIPE_AUTOMATIC_TAX=1: Stripe Tax adds sales tax/VAT at Checkout. Opt-in,
 *  because Stripe refuses the session if Stripe Tax isn't set up on the account. */
export function automaticTaxEnabled(): boolean {
  return ['1', 'true', 'on', 'yes'].includes(process.env.STRIPE_AUTOMATIC_TAX?.trim().toLowerCase() ?? '');
}

export function billingEnabled(): boolean {
  return publicChatEnabled()
    && !!process.env.STRIPE_SECRET_KEY?.trim()
    && !!process.env.STRIPE_WEBHOOK_SECRET?.trim()
    && Object.keys(priceIds()).length > 0;
}

let client: { key: string; stripe: Stripe } | null = null;

/** One client per secret key. Outbound calls go through proxyFetch so the
 *  operator's proxy settings apply (and tests can intercept them). */
function stripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY?.trim();
  if (!key) throw new BillingError('Billing is not configured', 404, 'billing_disabled');
  if (client?.key !== key) {
    const fetchViaProxy = ((url: string | URL | Request, init?: RequestInit) =>
      proxyFetch(typeof url === 'string' ? url : url instanceof URL ? url.href : url.url, init, 'stripe', 'unknown')) as typeof fetch;
    client = { key, stripe: new Stripe(key, { httpClient: Stripe.createFetchHttpClient(fetchViaProxy), maxNetworkRetries: 2 }) };
  }
  return client.stripe;
}

/** Test hook: forget the cached client (e.g. after changing env). */
export function resetBillingClient(): void {
  client = null;
  priceCache = null;
}

export interface PriceDisplay {
  interval: BillingInterval;
  amount: number | null;
  currency: string | null;
}

let priceCache: { at: number; key: string; prices: PriceDisplay[] } | null = null;
const PRICE_CACHE_MS = 10 * 60 * 1000;

/** The configured prices with their amounts, for the Upgrade dialog. Cached;
 *  falls back to intervals without amounts if Stripe can't be reached. */
export async function billingPrices(): Promise<PriceDisplay[]> {
  const ids = priceIds();
  const cacheKey = JSON.stringify(ids);
  if (priceCache && priceCache.key === cacheKey && Date.now() - priceCache.at < PRICE_CACHE_MS) return priceCache.prices;
  const prices: PriceDisplay[] = [];
  for (const interval of ['month', 'year'] as const) {
    const id = ids[interval];
    if (!id) continue;
    try {
      const price = await stripe().prices.retrieve(id);
      prices.push({ interval, amount: price.unit_amount ?? null, currency: price.currency ?? null });
    } catch {
      prices.push({ interval, amount: null, currency: null });
    }
  }
  priceCache = { at: Date.now(), key: cacheKey, prices };
  return prices;
}

/** Where Checkout and the portal send people back. ELPGPT_PUBLIC_URL wins
 *  (behind a proxy the request's own host and scheme can be wrong). */
export function returnBase(requestOrigin: string): string {
  const configured = process.env.ELPGPT_PUBLIC_URL?.trim().replace(/\/+$/, '');
  return configured && /^https?:\/\//.test(configured) ? configured : requestOrigin.replace(/\/+$/, '');
}

async function ensureCustomer(member: Member): Promise<string> {
  if (member.stripeCustomerId) return member.stripeCustomerId;
  const customer = await stripe().customers.create({
    email: member.email,
    metadata: { elp_member_id: String(member.id) },
  }, { idempotencyKey: `elp-member-customer-${member.id}` });
  setStripeCustomer(member.id, customer.id);
  return customer.id;
}

export async function createCheckout(member: Member, interval: BillingInterval, origin: string): Promise<string> {
  if (!billingEnabled()) throw new BillingError('Subscriptions are not available on this server.', 404, 'billing_disabled');
  const price = priceIds()[interval];
  if (!price) throw new BillingError('That billing period is not offered.', 400, 'invalid_interval');
  // Subscribers (paid or granted by the operator) change plans in the portal.
  if (member.plan === 'subscriber') {
    throw new BillingError('You already have an active subscription.', 409, 'already_subscribed');
  }
  const customer = await ensureCustomer(member);
  const base = returnBase(origin);
  const session = await stripe().checkout.sessions.create({
    mode: 'subscription',
    customer,
    client_reference_id: String(member.id),
    line_items: [{ price, quantity: 1 }],
    subscription_data: { metadata: { elp_member_id: String(member.id) } },
    allow_promotion_codes: true,
    // The customer exists before Checkout, so the billing address Checkout
    // collects for the tax calculation has to be saved back onto it.
    ...(automaticTaxEnabled() ? { automatic_tax: { enabled: true }, customer_update: { address: 'auto' as const } } : {}),
    success_url: `${base}/chat?billing=success`,
    cancel_url: `${base}/chat?billing=cancel`,
  });
  if (!session.url) throw new BillingError('Stripe did not return a checkout page.', 502, 'stripe_error');
  return session.url;
}

export async function createPortal(member: Member, origin: string): Promise<string> {
  if (!billingEnabled()) throw new BillingError('Subscriptions are not available on this server.', 404, 'billing_disabled');
  if (!member.stripeCustomerId) throw new BillingError('No subscription to manage yet.', 400, 'no_billing_account');
  const session = await stripe().billingPortal.sessions.create({
    customer: member.stripeCustomerId,
    return_url: `${returnBase(origin)}/chat`,
  });
  return session.url;
}

function customerId(value: string | { id: string } | null | undefined): string | null {
  if (!value) return null;
  return typeof value === 'string' ? value : value.id;
}

/** Map a subscription to its member and record the state it implies. */
async function syncSubscription(subscriptionId: string): Promise<void> {
  const sub = await stripe().subscriptions.retrieve(subscriptionId);
  const configured = new Set(Object.values(priceIds()));
  // Only subscriptions to ELPGPT's prices grant anything: other products on
  // the same Stripe account are none of this integration's business.
  if (!sub.items.data.some(item => configured.has(item.price.id))) return;
  const byCustomer = customerId(sub.customer);
  const member = (byCustomer && memberByStripeCustomer(byCustomer))
    || getMember(Number(sub.metadata?.elp_member_id));
  if (!member) return;
  if (byCustomer && !member.stripeCustomerId) setStripeCustomer(member.id, byCustomer);
  const periodEnd = sub.items.data.reduce<number | null>((max, item) =>
    typeof item.current_period_end === 'number' && (max === null || item.current_period_end > max) ? item.current_period_end : max, null);
  applySubscriptionState(member.id, {
    subscriptionId: sub.id,
    status: sub.status,
    periodEnd,
    grantsAccess: ACCESS_STATUSES.has(sub.status),
  });
}

/**
 * Verify and apply one webhook delivery. Throws BillingError(400) on a bad
 * signature so the route answers 400 and Stripe retries a genuine delivery.
 */
export async function handleStripeWebhook(rawBody: Buffer | string, signature: string | undefined): Promise<{ handled: boolean; type: string }> {
  const secret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
  if (!secret || !process.env.STRIPE_SECRET_KEY?.trim()) throw new BillingError('Billing is not configured', 404, 'billing_disabled');
  let event: Stripe.Event;
  try {
    event = stripe().webhooks.constructEvent(rawBody, signature ?? '', secret);
  } catch {
    throw new BillingError('Invalid Stripe signature', 400, 'invalid_signature');
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as Stripe.Checkout.Session;
    if (session.mode !== 'subscription') return { handled: false, type: event.type };
    const member = getMember(Number(session.client_reference_id));
    const cust = customerId(session.customer as string | { id: string } | null);
    if (member && cust && !member.stripeCustomerId) setStripeCustomer(member.id, cust);
    const subscription = customerId(session.subscription as string | { id: string } | null);
    if (subscription) await syncSubscription(subscription);
    return { handled: true, type: event.type };
  }

  if (SUBSCRIPTION_EVENTS.has(event.type)) {
    const sub = event.data.object as Stripe.Subscription;
    await syncSubscription(sub.id);
    return { handled: true, type: event.type };
  }

  return { handled: false, type: event.type };
}
