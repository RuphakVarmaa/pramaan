// Pramaan — Razorpay adapter, test mode only. (S2 RAILS, CONTRACTS.md §4.1)
//
// - Orders are created against https://api.razorpay.com/v1/orders with Basic auth.
// - PRAMAAN_STUB_PAYMENTS=1 forces deterministic stub mode (no network).
// - Live/test key ids MUST start with 'rzp_test_' (test mode only; enforced
//   unless stub mode is on).

import { createHash } from 'node:crypto';

const RZP_ORDERS_URL = 'https://api.razorpay.com/v1/orders';
const RZP_PAYMENTS_URL = 'https://api.razorpay.com/v1/payments';

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
  amountPaise: bigint; // paise — bigint all the way to the wire (serialized as number-string; paise magnitudes stay < 2^53)
  receipt: string;
  notes?: Record<string, string>;
}

export interface RazorpayOrder {
  id: string;
  amount: number; // paise, as Razorpay echoes it back (JSON number on their side)
  currency: 'INR';
  receipt: string;
  status: string;
  notes?: Record<string, string>;
}

export interface FetchPaymentResult {
  id: string;
  amount: number; // paise
  status: string;
  order_id?: string;
  captured?: boolean;
}

export interface RazorpayDeps {
  fetchFn?: typeof fetch;
  env?: Record<string, string | undefined>;
}

export interface RazorpayClient {
  createOrder(input: CreateOrderInput): Promise<RazorpayOrder>;
  fetchPayment(paymentId: string): Promise<FetchPaymentResult>;
}

function envGet(env: Record<string, string | undefined>, key: string): string | undefined {
  return env[key] === '' ? undefined : env[key];
}

export function isStubMode(env: Record<string, string | undefined> = process.env): boolean {
  return envGet(env, 'PRAMAAN_STUB_PAYMENTS') === '1';
}

export function getMode(env: Record<string, string | undefined> = process.env): 'live-api' | 'stub' {
  return isStubMode(env) ? 'stub' : 'live-api';
}

function requireTestKeys(keyId: string | undefined, keySecret: string | undefined): void {
  if (!keyId || !keySecret) {
    throw new RazorpayError(
      'RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET not configured',
      0,
      null,
    );
  }
  // Test mode only: refuse key ids that are not Razorpay test keys.
  if (!keyId.startsWith('rzp_test_')) {
    throw new RazorpayError(
      `Refusing non-test Razorpay key id "${keyId}" — Pramaan is test-mode only`,
      0,
      null,
    );
  }
}

/** Deterministic stub order id: order_stub_<first 12 hex of sha256(receipt)>. */
function stubOrderId(receipt: string): string {
  return 'order_stub_' + createHash('sha256').update(receipt).digest('hex').slice(0, 12);
}

/**
 * Build a Razorpay client. In stub mode it never touches the network; live
 * mode requires rzp_test_* credentials and performs real fetch calls.
 */
export function createRazorpayClient(deps: RazorpayDeps = {}): RazorpayClient {
  const env = deps.env ?? process.env;
  const doFetch = deps.fetchFn ?? fetch;

  if (isStubMode(env)) {
    return {
      async createOrder(input: CreateOrderInput): Promise<RazorpayOrder> {
        const amountStr = input.amountPaise.toString();
        if (!/^\d+$/.test(amountStr) || input.amountPaise <= 0n) {
          throw new RazorpayError('Invalid amount for order (must be positive integer paise)', 0, null);
        }
        const amount = Number(amountStr); // echo-back only; validated < 2^53
        if (!Number.isSafeInteger(amount)) {
          throw new RazorpayError('Amount exceeds safe integer range', 0, null);
        }
        return {
          id: stubOrderId(input.receipt),
          amount,
          currency: 'INR',
          receipt: input.receipt,
          status: 'stubbed',
          notes: input.notes,
        };
      },
      async fetchPayment(paymentId: string): Promise<FetchPaymentResult> {
        if (paymentId.startsWith('pay_stub_')) {
          return {
            id: paymentId,
            amount: 0,
            status: 'stubbed',
          };
        }
        throw new RazorpayError(`Payment ${paymentId} not found in stub mode`, 404, {
          error: { code: 'PAYMENT_NOT_FOUND' },
        });
      },
    };
  }

  const keyId = envGet(env, 'RAZORPAY_KEY_ID');
  const keySecret = envGet(env, 'RAZORPAY_KEY_SECRET');
  requireTestKeys(keyId, keySecret);
  const auth =
    'Basic ' + Buffer.from(`${keyId}:${keySecret}`, 'utf8').toString('base64');

  async function rzpFetch(url: string, init: RequestInit): Promise<unknown> {
    let res: Response;
    try {
      res = await doFetch(url, init);
    } catch (err) {
      throw new RazorpayError(
        `Razorpay network error: ${err instanceof Error ? err.message : String(err)}`,
        0,
        null,
      );
    }
    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      /* keep raw text body */
    }
    if (!res.ok) {
      const desc =
        (body as { error?: { description?: string } } | null)?.error?.description ??
        `HTTP ${res.status}`;
      throw new RazorpayError(`Razorpay error: ${desc}`, res.status, body);
    }
    return body;
  }

  return {
    async createOrder(input: CreateOrderInput): Promise<RazorpayOrder> {
      const amountStr = input.amountPaise.toString();
      if (!/^\d+$/.test(amountStr) || input.amountPaise <= 0n) {
        throw new RazorpayError('Invalid amount for order (must be positive integer paise)', 0, null);
      }
      const body = JSON.stringify({
        amount: Number(amountStr), // Razorpay accepts integer paise; validated safe below
        currency: 'INR',
        receipt: input.receipt,
        notes: input.notes ?? {},
      });
      if (!Number.isSafeInteger(Number(amountStr))) {
        throw new RazorpayError('Amount exceeds safe integer range', 0, null);
      }
      const json = (await rzpFetch(RZP_ORDERS_URL, {
        method: 'POST',
        headers: {
          authorization: auth,
          'content-type': 'application/json',
        },
        body,
      })) as RazorpayOrder;
      return json;
    },
    async fetchPayment(paymentId: string): Promise<FetchPaymentResult> {
      const json = (await rzpFetch(`${RZP_PAYMENTS_URL}/${encodeURIComponent(paymentId)}`, {
        method: 'GET',
        headers: { authorization: auth },
      })) as FetchPaymentResult;
      return json;
    },
  };
}
