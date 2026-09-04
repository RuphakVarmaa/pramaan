// Pramaan — Razorpay adapter (CONTRACTS.md §4.1). Test mode ONLY.
// - createOrder({ amountPaise, receipt, notes }) -> { orderId, amountPaise, status }
//   Plain fetch against https://api.razorpay.com/v1/orders with Basic auth.
// - PRAMAAN_STUB_PAYMENTS=1 forces stub mode: deterministic order_stub_<sha256-12-of-receipt>
//   ids, status 'stubbed', zero network.
// - Non-2xx -> RazorpayError with .status and .body.
// - Paise stay integer end to end: the request body is assembled by string
//   interpolation (JSON.stringify cannot carry bigint, and Number() on money
//   is forbidden) — the raw decimal digits go on the wire verbatim.

import { createHash, randomUUID } from 'node:crypto';

const RZP_API = 'https://api.razorpay.com/v1';

export class RazorpayError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = 'RazorpayError';
    this.status = status;
    this.body = body;
  }
}

export interface CreateOrderInput {
  amountPaise: bigint;
  receipt: string;
  notes?: Record<string, string>;
}

export interface RazorpayOrder {
  orderId: string;
  amountPaise: bigint;
  status: string;
  receipt: string;
}

export interface RazorpayPayment {
  paymentId: string;
  status: string;
  amountPaise: bigint;
  orderId?: string;
}

export type RazorpayMode = 'live-api' | 'stub';

export interface RazorpayDeps {
  env?: Record<string, string | undefined>;
  fetchFn?: typeof fetch;
}

export interface RazorpayClient {
  createOrder(input: CreateOrderInput): Promise<RazorpayOrder>;
  fetchPayment(paymentId: string): Promise<RazorpayPayment>;
}

export function isStubMode(env: Record<string, string | undefined> = process.env): boolean {
  return env.PRAMAAN_STUB_PAYMENTS === '1';
}

export function getMode(env: Record<string, string | undefined> = process.env): RazorpayMode {
  return isStubMode(env) ? 'stub' : 'live-api';
}

/** Test mode only: live mode refuses key ids that are not rzp_test_*. */
function assertTestKeyId(keyId: string): void {
  if (!keyId.startsWith('rzp_test_')) {
    throw new RazorpayError(
      'Pramaan is test-mode only: RAZORPAY_KEY_ID must start with rzp_test_',
      0,
      { error: { code: 'NON_TEST_KEY' } },
    );
  }
}

function basicAuth(keyId: string, keySecret: string): string {
  return 'Basic ' + Buffer.from(`${keyId}:${keySecret}`, 'utf8').toString('base64');
}

function stubOrderId(receipt: string): string {
  return 'order_stub_' + createHash('sha256').update(receipt, 'utf8').digest('hex').slice(0, 12);
}

function positivePaise(amountPaise: bigint): void {
  if (typeof amountPaise !== 'bigint' || amountPaise <= 0n) {
    throw new RazorpayError('amountPaise must be a positive bigint (integer paise)', 0, null);
  }
}

export function createRazorpayClient(deps: RazorpayDeps = {}): RazorpayClient {
  const env = deps.env ?? process.env;
  const doFetch = deps.fetchFn ?? fetch;

  // ---- stub mode: deterministic, offline, honestly labelled 'stubbed' ----
  if (isStubMode(env)) {
    return {
      async createOrder(input) {
        positivePaise(input.amountPaise);
        return {
          orderId: stubOrderId(input.receipt),
          amountPaise: input.amountPaise,
          status: 'stubbed',
          receipt: input.receipt,
        };
      },
      async fetchPayment(paymentId) {
        if (!paymentId.startsWith('pay_stub_')) {
          throw new RazorpayError(`payment ${paymentId} not found (stub mode)`, 404, {
            error: { code: 'PAYMENT_NOT_FOUND' },
          });
        }
        return { paymentId, status: 'stubbed', amountPaise: 0n };
      },
    };
  }

  // ---- live test-mode API ----
  const keyId = env.RAZORPAY_KEY_ID;
  const keySecret = env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) {
    throw new RazorpayError(
      'RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET not configured (or set PRAMAAN_STUB_PAYMENTS=1)',
      0,
      null,
    );
  }
  assertTestKeyId(keyId);
  const auth = basicAuth(keyId, keySecret);

  async function rzpFetch(url: string, init: RequestInit): Promise<unknown> {
    let res: Response;
    try {
      res = await doFetch(url, init);
    } catch (err) {
      throw new RazorpayError(
        `razorpay network error: ${err instanceof Error ? err.message : String(err)}`,
        0,
        null,
      );
    }
    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      /* non-JSON body — keep raw text */
    }
    if (!res.ok) {
      const description =
        (body as { error?: { description?: string } } | null)?.error?.description ??
        `HTTP ${res.status}`;
      throw new RazorpayError(`razorpay error: ${description}`, res.status, body);
    }
    return body;
  }

  return {
    async createOrder(input) {
      positivePaise(input.amountPaise);
      // Paise go on the wire as raw decimal digits (exact, no float hop).
      const payload =
        `{"amount":${input.amountPaise.toString()},"currency":"INR",` +
        `"receipt":${JSON.stringify(input.receipt)},` +
        `"notes":${JSON.stringify(input.notes ?? {})}}`;
      const body = (await rzpFetch(`${RZP_API}/orders`, {
        method: 'POST',
        headers: { authorization: auth, 'content-type': 'application/json' },
        body: payload,
      })) as { id?: string; status?: string; receipt?: string };
      if (typeof body?.id !== 'string') {
        throw new RazorpayError('razorpay returned no order id', 502, body);
      }
      return {
        orderId: body.id,
        amountPaise: input.amountPaise, // echoed; the wire amount was exact
        status: typeof body.status === 'string' ? body.status : 'created',
        receipt: typeof body.receipt === 'string' ? body.receipt : input.receipt,
      };
    },

    async fetchPayment(paymentId) {
      const body = (await rzpFetch(`${RZP_API}/payments/${encodeURIComponent(paymentId)}`, {
        method: 'GET',
        headers: { authorization: auth },
      })) as { id?: string; status?: string; amount?: number; order_id?: string };
      if (typeof body?.id !== 'string') {
        throw new RazorpayError(`payment ${paymentId} not found`, 404, body);
      }
      return {
        paymentId: body.id,
        status: typeof body.status === 'string' ? body.status : 'unknown',
        // Razorpay echoes integer paise as a JSON number; read it back exactly
        // through its decimal text form.
        amountPaise: BigInt(Math.trunc(body.amount ?? 0)),
        ...(typeof body.order_id === 'string' ? { orderId: body.order_id } : {}),
      };
    },
  };
}

/** Dispute ids (used by the /disputes route) — exported here so app.ts and the
 *  sidecar share one generator. */
export function newDisputeId(): string {
  return 'dsp_' + randomUUID().replaceAll('-', '').slice(0, 20);
}
