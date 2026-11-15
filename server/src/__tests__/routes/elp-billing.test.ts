import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import Stripe from 'stripe';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { resetPublicThrottle } from '../../routes/public.js';
import { resetBillingClient } from '../../services/billing.js';
import { mintDashboardToken } from '../helpers/auth.js';

// Stripe subscriptions for the public chat. api.stripe.com is mocked at the
// fetch layer (the SDK runs on its fetch client), and webhooks are signed with
// the SDK's own test helper, so signature checking runs for real.

let app: Express;
let dashToken = '';
const realFetch = globalThis.fetch;
const WEBHOOK_SECRET = 'whsec_test_secret';
const signer = new Stripe('sk_test_signer');

async function call(method: string, path: string, opts: { body?: unknown; raw?: string; headers?: Record<string, string> } = {}) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const { port } = server.address() as { port: number };
  const res = await realFetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { ...(opts.body ? { 'Content-Type': 'application/json' } : {}), ...opts.headers },
    body: opts.raw ?? (opts.body ? JSON.stringify(opts.body) : undefined),
  });
  const text = await res.text();
  server.close();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body: json };
}

interface StripeCall { method: string; path: string; form: URLSearchParams }

/** Mutable fake of the Stripe objects these tests touch. */
const stripeState = {
  subscriptions: new Map<string, Record<string, unknown>>(),
  customerSeq: 0,
};

function subscription(id: string, opts: { customer: string; status: string; price?: string; memberId?: number; periodEnd?: number }) {
  const sub = {
    id, object: 'subscription', customer: opts.customer, status: opts.status,
    metadata: opts.memberId ? { elp_member_id: String(opts.memberId) } : {},
    items: { object: 'list', data: [{ id: `si_${id}`, object: 'subscription_item', price: { id: opts.price ?? 'price_month', object: 'price' }, current_period_end: opts.periodEnd ?? 1_900_000_000 }] },
  };
  stripeState.subscriptions.set(id, sub);
  return sub;
}

function mockStripe(): StripeCall[] {
  const calls: StripeCall[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith('http://127.0.0.1')) return realFetch(input as any, init);
    const u = new URL(url);
    const method = (init?.method ?? 'GET').toUpperCase();
    const form = new URLSearchParams(typeof init?.body === 'string' ? init.body : '');
    calls.push({ method, path: u.pathname, form });
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (u.host !== 'api.stripe.com') return json(599, { error: { message: `unexpected ${u.host}` } });
    if (method === 'POST' && u.pathname === '/v1/customers') return json(200, { id: `cus_${++stripeState.customerSeq}`, object: 'customer' });
    if (method === 'POST' && u.pathname === '/v1/checkout/sessions') return json(200, { id: 'cs_1', object: 'checkout.session', url: 'https://checkout.stripe.com/c/pay/cs_1' });
    if (method === 'POST' && u.pathname === '/v1/billing_portal/sessions') return json(200, { id: 'bps_1', object: 'billing_portal.session', url: 'https://billing.stripe.com/p/session/bps_1' });
    const sub = u.pathname.match(/^\/v1\/subscriptions\/([^/]+)$/);
    if (method === 'GET' && sub) {
      const found = stripeState.subscriptions.get(sub[1]);
      return found ? json(200, found) : json(404, { error: { type: 'invalid_request_error', message: 'No such subscription' } });
    }
    const price = u.pathname.match(/^\/v1\/prices\/([^/]+)$/);
    if (method === 'GET' && price) return json(200, { id: price[1], object: 'price', unit_amount: price[1] === 'price_year' ? 15000 : 1500, currency: 'usd' });
    return json(404, { error: { type: 'invalid_request_error', message: `unmocked ${method} ${u.pathname}` } });
  });
  return calls;
}

async function signup(email = 'ana@example.com') {
  const res = await call('POST', '/api/public/signup', { body: { email, password: 'correct-horse-1' } });
  return res.body.token as string;
}

const member = (token: string) => ({ 'x-member-token': token });

function memberRow(email = 'ana@example.com') {
  return getDb().prepare('SELECT id, plan, plan_source, stripe_customer_id, stripe_subscription_id, subscription_status, subscription_period_end FROM elp_members WHERE email = ?')
    .get(email) as { id: number; plan: string; plan_source: string; stripe_customer_id: string | null; stripe_subscription_id: string | null; subscription_status: string | null; subscription_period_end: number | null };
}

function sendEvent(type: string, object: Record<string, unknown>, secret = WEBHOOK_SECRET) {
  const payload = JSON.stringify({ id: `evt_${Math.random().toString(36).slice(2)}`, object: 'event', type, data: { object } });
  const signature = signer.webhooks.generateTestHeaderString({ payload, secret });
  return call('POST', '/api/public/billing/webhook', { raw: payload, headers: { 'Content-Type': 'application/json', 'Stripe-Signature': signature } });
}

/** Sign up, start a checkout (which creates the Stripe customer), return the ids. */
async function checkedOutMember(email = 'ana@example.com') {
  const token = await signup(email);
  await call('POST', '/api/public/billing/checkout', { body: { interval: 'month' }, headers: member(token) });
  const row = memberRow(email);
  return { token, id: row.id, customer: row.stripe_customer_id! };
}

const BILLING_ENV = ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_PRICE_MONTHLY', 'STRIPE_PRICE_YEARLY', 'ELPGPT_PUBLIC_URL'];

beforeEach(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  for (const k of ['ELPGPT_PUBLIC_CHAT', 'ELPGPT_PUBLIC_SIGNUP', ...BILLING_ENV]) delete process.env[k];
  process.env.ELPGPT_PUBLIC_CHAT = '1';
  initDb(':memory:');
  app = createApp();
  dashToken = mintDashboardToken();
  resetPublicThrottle();
  resetBillingClient();
  stripeState.subscriptions.clear();
  stripeState.customerSeq = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const k of BILLING_ENV) delete process.env[k];
});

describe('billing is off until Stripe is configured', () => {
  it('reports disabled and refuses checkout', async () => {
    const token = await signup();
    const status = await call('GET', '/api/public/status', { headers: member(token) });
    expect(status.body.billing).toEqual({ enabled: false });
    const checkout = await call('POST', '/api/public/billing/checkout', { body: { interval: 'month' }, headers: member(token) });
    expect(checkout.status).toBe(404);
    expect(checkout.body.error.code).toBe('billing_disabled');
  });

  it('needs a webhook secret as well as a key and a price', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_123';
    process.env.STRIPE_PRICE_MONTHLY = 'price_month';
    expect((await call('GET', '/api/public/status')).body.billing).toEqual({ enabled: false });
  });
});

describe('billing (configured)', () => {
  beforeEach(() => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_123';
    process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
    process.env.STRIPE_PRICE_MONTHLY = 'price_month';
    process.env.STRIPE_PRICE_YEARLY = 'price_year';
  });

  it('lists the configured prices with their amounts', async () => {
    mockStripe();
    expect((await call('GET', '/api/public/status')).body.billing).toEqual({ enabled: true });
    const res = await call('GET', '/api/public/billing/prices');
    expect(res.body.prices).toEqual([
      { interval: 'month', amount: 1500, currency: 'usd' },
      { interval: 'year', amount: 15000, currency: 'usd' },
    ]);
  });

  it('requires a signed-in member and a valid interval', async () => {
    mockStripe();
    const guest = await call('POST', '/api/public/billing/checkout', { body: { interval: 'month' } });
    expect(guest.status).toBe(401);
    expect(guest.body.error.code).toBe('sign_in_required');
    const token = await signup();
    const bad = await call('POST', '/api/public/billing/checkout', { body: { interval: 'week' }, headers: member(token) });
    expect(bad.status).toBe(400);
  });

  it('creates the Stripe customer before Checkout and reuses it', async () => {
    const calls = mockStripe();
    process.env.ELPGPT_PUBLIC_URL = 'https://elpgpt.com/';
    const token = await signup();
    const res = await call('POST', '/api/public/billing/checkout', { body: { interval: 'year' }, headers: member(token) });
    expect(res.status).toBe(200);
    expect(res.body.url).toBe('https://checkout.stripe.com/c/pay/cs_1');

    const row = memberRow();
    expect(row.stripe_customer_id).toBe('cus_1');
    expect(row.plan).toBe('free'); // nothing changes until Stripe's webhook says so
    expect(calls.map(c => `${c.method} ${c.path}`)).toEqual(['POST /v1/customers', 'POST /v1/checkout/sessions']);
    const customer = calls[0].form;
    expect(customer.get('email')).toBe('ana@example.com');
    expect(customer.get('metadata[elp_member_id]')).toBe(String(row.id));
    const session = calls[1].form;
    expect(session.get('mode')).toBe('subscription');
    expect(session.get('customer')).toBe('cus_1');
    expect(session.get('client_reference_id')).toBe(String(row.id));
    expect(session.get('line_items[0][price]')).toBe('price_year');
    expect(session.get('subscription_data[metadata][elp_member_id]')).toBe(String(row.id));
    expect(session.get('success_url')).toBe('https://elpgpt.com/chat?billing=success');
    expect(session.get('cancel_url')).toBe('https://elpgpt.com/chat?billing=cancel');

    calls.length = 0;
    await call('POST', '/api/public/billing/checkout', { body: { interval: 'month' }, headers: member(token) });
    expect(calls.map(c => c.path)).toEqual(['/v1/checkout/sessions']);
  });

  it('rejects a webhook with a bad signature and changes nothing', async () => {
    mockStripe();
    const { customer } = await checkedOutMember();
    subscription('sub_1', { customer, status: 'active' });
    const res = await sendEvent('customer.subscription.created', { id: 'sub_1', object: 'subscription' }, 'whsec_wrong');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_signature');
    expect(memberRow().plan).toBe('free');
  });

  it('an active subscription makes the member a Subscriber; cancelling downgrades them', async () => {
    mockStripe();
    const { token, customer } = await checkedOutMember();
    subscription('sub_1', { customer, status: 'active', periodEnd: 1_950_000_000 });
    const created = await sendEvent('customer.subscription.created', { id: 'sub_1', object: 'subscription' });
    expect(created.status).toBe(200);
    expect(memberRow()).toMatchObject({ plan: 'subscriber', plan_source: 'stripe', stripe_subscription_id: 'sub_1', subscription_status: 'active', subscription_period_end: 1_950_000_000 });

    const status = await call('GET', '/api/public/status', { headers: member(token) });
    expect(status.body.tier).toBe('subscriber');
    expect(status.body.features.premium).toBe(true);
    expect(status.body.member).toMatchObject({ canManageBilling: true, subscription: { status: 'active', periodEnd: 1_950_000_000, source: 'stripe' } });

    // past_due keeps access while Stripe retries the card.
    subscription('sub_1', { customer, status: 'past_due' });
    await sendEvent('customer.subscription.updated', { id: 'sub_1', object: 'subscription' });
    expect(memberRow().plan).toBe('subscriber');

    subscription('sub_1', { customer, status: 'canceled' });
    await sendEvent('customer.subscription.deleted', { id: 'sub_1', object: 'subscription' });
    expect(memberRow()).toMatchObject({ plan: 'free', subscription_status: 'canceled' });
  });

  it('trusts Stripe over the event payload (events can arrive out of order)', async () => {
    mockStripe();
    const { customer } = await checkedOutMember();
    subscription('sub_1', { customer, status: 'canceled' });
    // A stale "active" snapshot delivered late must not re-grant access.
    await sendEvent('customer.subscription.updated', { id: 'sub_1', object: 'subscription', status: 'active', customer });
    expect(memberRow().plan).toBe('free');
  });

  it('checkout.session.completed links the customer and syncs the subscription', async () => {
    mockStripe();
    const token = await signup();
    const { id } = memberRow();
    subscription('sub_9', { customer: 'cus_other', status: 'active' });
    const res = await sendEvent('checkout.session.completed', {
      id: 'cs_9', object: 'checkout.session', mode: 'subscription', client_reference_id: String(id), customer: 'cus_other', subscription: 'sub_9',
    });
    expect(res.body).toEqual({ received: true, handled: true });
    expect(memberRow()).toMatchObject({ stripe_customer_id: 'cus_other', plan: 'subscriber' });
    expect((await call('GET', '/api/public/status', { headers: member(token) })).body.tier).toBe('subscriber');
  });

  it('never revokes a plan the operator granted by hand', async () => {
    mockStripe();
    const { id, customer } = await checkedOutMember();
    const patch = await call('PATCH', `/api/elp/members/${id}`, { body: { plan: 'subscriber' }, headers: { Authorization: `Bearer ${dashToken}` } });
    expect(patch.status).toBe(200);
    subscription('sub_1', { customer, status: 'incomplete_expired' });
    await sendEvent('customer.subscription.updated', { id: 'sub_1', object: 'subscription' });
    expect(memberRow()).toMatchObject({ plan: 'subscriber', plan_source: 'manual', subscription_status: 'incomplete_expired' });
  });

  it('keeps a manual grant manual even if the member also pays and then cancels', async () => {
    mockStripe();
    const { id, customer } = await checkedOutMember();
    await call('PATCH', `/api/elp/members/${id}`, { body: { plan: 'subscriber' }, headers: { Authorization: `Bearer ${dashToken}` } });
    subscription('sub_1', { customer, status: 'active' });
    await sendEvent('customer.subscription.created', { id: 'sub_1', object: 'subscription' });
    expect(memberRow()).toMatchObject({ plan: 'subscriber', plan_source: 'manual', subscription_status: 'active' });
    subscription('sub_1', { customer, status: 'canceled' });
    await sendEvent('customer.subscription.deleted', { id: 'sub_1', object: 'subscription' });
    expect(memberRow()).toMatchObject({ plan: 'subscriber', plan_source: 'manual' });
  });

  it('ignores subscriptions to prices that are not ELPGPT\'s', async () => {
    mockStripe();
    const { customer } = await checkedOutMember();
    subscription('sub_x', { customer, status: 'active', price: 'price_some_other_product' });
    const res = await sendEvent('customer.subscription.created', { id: 'sub_x', object: 'subscription' });
    expect(res.status).toBe(200);
    expect(memberRow()).toMatchObject({ plan: 'free', stripe_subscription_id: null });
  });

  it('acknowledges unrelated event types without acting on them', async () => {
    mockStripe();
    const res = await sendEvent('invoice.paid', { id: 'in_1', object: 'invoice' });
    expect(res.body).toEqual({ received: true, handled: false });
  });

  it('answers 500 when Stripe cannot be read, so Stripe redelivers', async () => {
    mockStripe();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await sendEvent('customer.subscription.updated', { id: 'sub_missing', object: 'subscription' });
    expect(res.status).toBe(500);
  });

  it('refuses a second checkout while a subscription is active', async () => {
    mockStripe();
    const { token, customer } = await checkedOutMember();
    subscription('sub_1', { customer, status: 'active' });
    await sendEvent('customer.subscription.created', { id: 'sub_1', object: 'subscription' });
    const res = await call('POST', '/api/public/billing/checkout', { body: { interval: 'month' }, headers: member(token) });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('already_subscribed');
  });

  it('opens the customer portal for members with a billing account', async () => {
    const calls = mockStripe();
    const fresh = await signup('new@example.com');
    const none = await call('POST', '/api/public/billing/portal', { headers: member(fresh) });
    expect(none.status).toBe(400);
    expect(none.body.error.code).toBe('no_billing_account');

    const { token } = await checkedOutMember();
    calls.length = 0;
    const res = await call('POST', '/api/public/billing/portal', { headers: member(token) });
    expect(res.body.url).toBe('https://billing.stripe.com/p/session/bps_1');
    expect(calls[0].form.get('customer')).toBe('cus_1');
    expect(calls[0].form.get('return_url')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/chat$/);
  });
});
