// Pramaan — route tests via fastify inject(). (Orchestrator, on behalf of S2; CONTRACTS.md §4)
//
// - Full happy path: POST /delegations -> POST /checkout (stub mode) produces
//   the ledger chain DELEGATION_ISSUED -> ATTEMPT_ALLOWED -> PAYMENT_CAPTURED.
// - Cap-exceeded checkout -> 403 + reason + ATTEMPT_BLOCKED row.
// - No payment without artifact: missing/invalid sig -> 403/400, NO order created,
//   NO ATTEMPT_ALLOWED row.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateEd25519KeyPair } from '../src/crypto.js';
import { openLedger, appendLedgerEvent, readLedger, aggregateSpent } from '../src/ledger.js';
import { issueDelegation, verifyArtifact } from '../src/artifact.js';
import { pramaanFraudGate } from '../src/passthrough.js';
import { buildApp } from '../src/app.js';
import type { AppDeps } from '../src/app.js';
import { createRazorpayClient } from '../src/razorpay.js';
import type { DelegationArtifactWire } from '../src/types.js';
import Fastify, { type FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';

const TEST_DIR = join(tmpdir(), `pramaan-routes-${process.pid}-${Date.now()}`);
const DB_PATH = join(TEST_DIR, 'ledger.db');

let app: FastifyInstance;
let db: DatabaseSync;

const ENV = { PRAMAAN_STUB_PAYMENTS: '1' };

beforeAll(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  db = openLedger(DB_PATH);

  const kp = generateEd25519KeyPair();
  const deps: AppDeps = {
    env: ENV,
    razorpay: createRazorpayClient({ env: ENV }),
    ledger: {
      append: (event) =>
        appendLedgerEvent(db, {
          type: event.type,
          ...(event.artifactId != null ? { artifactId: event.artifactId } : {}),
          ...(event.orderId != null ? { orderId: event.orderId } : {}),
          ...(event.amountPaise != null ? { amountPaise: event.amountPaise } : {}),
          ...(event.verdict != null ? { verdict: event.verdict } : {}),
          ...(event.reason != null ? { reason: event.reason } : {}),
        }),
      read: (artifactId?: string, limit?: number) => {
        let rows = readLedger(db);
        if (artifactId) rows = rows.filter((r) => r.artifactId === artifactId);
        if (typeof limit === 'number' && Number.isInteger(limit) && limit >= 0) rows = rows.slice(-limit);
        return rows;
      },
      aggregateSpent: (artifactId: string) => aggregateSpent(db, artifactId),
    },
    disputes: {
      create: (input) => 'dsp_test_' + input.delegationId + '_' + input.now.replace(/\W/g, ''),
    },
    publicKey: kp.publicKey,
    issueDelegation: (input) => issueDelegation(input, kp),
    verifyArtifact: (wire, sig, now) => verifyArtifact(wire, sig, kp.publicKey, now),
    fraudGate: pramaanFraudGate,
    fastify: () => Fastify(),
  };
  app = buildApp(deps);
});

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

// ---- helpers -------------------------------------------------------------

async function issueArtifact(overrides: Partial<{ maxPerTxn: string; maxAggregate: string; categories: string[]; expiresAt: string }> = {}) {
  const res = await app.inject({
    method: 'POST',
    url: '/delegations',
    payload: {
      merchantId: 'kadai-and-co',
      agentId: 'agent-007',
      principal: 'human:rupa@upi',
      scope: {
        categories: overrides.categories ?? ['coffee', 'equipment'],
        maxPerTxnPaise: overrides.maxPerTxn ?? '500000',
        maxAggregatePaise: overrides.maxAggregate ?? '2000000',
        expiresAt: overrides.expiresAt ?? '2099-01-01T00:00:00Z',
      },
    },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { artifactId: string; artifact: DelegationArtifactWire; sig: string };
}

function coffeeLine(qty = 1) {
  return { sku: 'KC-COF-CHIK-250', category: 'coffee', qty, unitPaise: '52000' };
}

async function ledgerRows(artifactId?: string): Promise<Array<Record<string, unknown>>> {
  const url = artifactId ? `/ledger?artifactId=${artifactId}` : '/ledger';
  return ((await app.inject({ method: 'GET', url })).json().rows) as Array<Record<string, unknown>>;
}

// ---- tests ----------------------------------------------------------------

describe('POST /delegations', () => {
  it('issues a signed artifact with string paise and writes DELEGATION_ISSUED', async () => {
    const before = (await ledgerRows()).length;
    const b = await issueArtifact();
    expect(b.artifactId).toMatch(/^dl_[0-9a-f]{24}$/);
    expect(typeof b.artifact.scope.maxPerTxnPaise).toBe('string');
    expect(b.sig).toBeTruthy();
    const after = await ledgerRows();
    expect(after.length).toBe(before + 1);
    expect(after[after.length - 1]?.type).toBe('DELEGATION_ISSUED');
  });

  it('rejects malformed scope with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/delegations',
      payload: { agentId: 'a', principal: 'p', scope: { categories: [], maxPerTxnPaise: '1', maxAggregatePaise: '1', expiresAt: '2099-01-01T00:00:00Z' } },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /gate (pure, no side effects)', () => {
  it('returns the verdict without writing any ledger row', async () => {
    const b = await issueArtifact();
    const before = (await ledgerRows()).length;
    const res = await app.inject({
      method: 'POST',
      url: '/gate',
      payload: { artifactWire: b.artifact, sig: b.sig, cart: { merchantId: 'kadai-and-co', lines: [coffeeLine()] } },
    });
    expect(res.statusCode).toBe(200);
    const v = res.json() as { allowed: boolean; totalPaise: string; aggregateAfterPaise: string };
    expect(v.allowed).toBe(true);
    expect(v.totalPaise).toBe('52000');
    expect(v.aggregateAfterPaise).toBe('52000');
    expect((await ledgerRows()).length).toBe(before); // PURE: no rows written
  });

  it('blocks an out-of-scope category with the reason code', async () => {
    const b = await issueArtifact({ categories: ['coffee'] });
    const res = await app.inject({
      method: 'POST',
      url: '/gate',
      payload: {
        artifactWire: b.artifact,
        sig: b.sig,
        cart: { merchantId: 'kadai-and-co', lines: [{ sku: 'KC-MER-TSH-BLK', category: 'merch', qty: 1, unitPaise: '64000' }] },
      },
    });
    const v = res.json() as { allowed: boolean; reason: string };
    expect(v.allowed).toBe(false);
    expect(v.reason).toBe('CATEGORY_OUT_OF_SCOPE');
  });
});

describe('POST /checkout', () => {
  it('happy path: full ledger chain DELEGATION_ISSUED -> ATTEMPT_ALLOWED -> PAYMENT_CAPTURED', async () => {
    const b = await issueArtifact();
    const res = await app.inject({
      method: 'POST',
      url: '/checkout',
      payload: { artifactWire: b.artifact, sig: b.sig, cart: { merchantId: 'kadai-and-co', lines: [coffeeLine(2)] } },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { orderId: string; amountPaise: string; status: string };
    expect(body.orderId).toMatch(/^order_stub_[0-9a-f]{12}$/);
    expect(body.amountPaise).toBe('104000');
    expect(body.status).toBe('stubbed');

    const rows = await ledgerRows(b.artifactId);
    const types = rows.map((r) => r.type);
    expect(types).toEqual(['DELEGATION_ISSUED', 'ATTEMPT_ALLOWED', 'PAYMENT_CAPTURED']);
    expect(rows[2]?.amountPaise).toBe('104000');
  });

  it('cap-exceeded: 403 with reason + ATTEMPT_BLOCKED row, no order', async () => {
    const b = await issueArtifact({ maxPerTxn: '50000' }); // below one coffee
    const before = (await ledgerRows(b.artifactId)).length;
    const res = await app.inject({
      method: 'POST',
      url: '/checkout',
      payload: { artifactWire: b.artifact, sig: b.sig, cart: { merchantId: 'kadai-and-co', lines: [coffeeLine()] } },
    });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { reason: string }).reason).toBe('CAP_EXCEEDED_PER_TXN');
    const rows = await ledgerRows(b.artifactId);
    expect(rows.length).toBe(before + 1);
    expect(rows[rows.length - 1]?.type).toBe('ATTEMPT_BLOCKED');
    expect(rows.some((r) => r.type === 'PAYMENT_CAPTURED')).toBe(false);
  });

  it('NO PAYMENT WITHOUT A VALID ARTIFACT: missing sig -> 403, no order, no ATTEMPT_ALLOWED', async () => {
    const b = await issueArtifact();
    const beforeAll = (await ledgerRows()).length;

    // missing artifact entirely -> 400
    const r1 = await app.inject({
      method: 'POST',
      url: '/checkout',
      payload: { cart: { merchantId: 'kadai-and-co', lines: [coffeeLine()] } },
    });
    expect(r1.statusCode).toBe(400);

    // forged signature -> 403 SIGNATURE_INVALID
    const r2 = await app.inject({
      method: 'POST',
      url: '/checkout',
      payload: { artifactWire: b.artifact, sig: 'forged-signature-value', cart: { merchantId: 'kadai-and-co', lines: [coffeeLine()] } },
    });
    expect(r2.statusCode).toBe(403);
    expect((r2.json() as { reason: string }).reason).toBe('SIGNATURE_INVALID');

    const newRows = (await ledgerRows()).slice(beforeAll);
    expect(newRows.every((r) => r.type !== 'ATTEMPT_ALLOWED' && r.type !== 'PAYMENT_CAPTURED')).toBe(true);
  });
});

describe('POST /disputes + GET /evidence', () => {
  it('opens a dispute with a 201 and DISPUTE_OPENED row', async () => {
    const b = await issueArtifact();
    await app.inject({
      method: 'POST',
      url: '/checkout',
      payload: { artifactWire: b.artifact, sig: b.sig, cart: { merchantId: 'kadai-and-co', lines: [coffeeLine()] } },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/disputes',
      payload: { delegationId: b.artifactId, amountPaise: '52000', reason: 'item not received' },
    });
    expect(res.statusCode).toBe(201);
    expect((res.json() as { disputeId: string }).disputeId).toBeTruthy();
    const rows = await ledgerRows(b.artifactId);
    expect(rows[rows.length - 1]?.type).toBe('DISPUTE_OPENED');
  });

  it('evidence route answers 501 until S3 lands (honest, not faked)', async () => {
    const res = await app.inject({ method: 'GET', url: '/evidence/dl_000000000000000000000000?disputeId=dsp_x' });
    expect([200, 501]).toContain(res.statusCode);
  });
});

describe('GET /ledger', () => {
  it('returns rows in seq order with paise as strings', async () => {
    const res = await app.inject({ method: 'GET', url: '/ledger' });
    expect(res.statusCode).toBe(200);
    const rows = (res.json().rows) as Array<Record<string, unknown>>;
    expect(rows.length).toBeGreaterThan(0);
    const seqs = rows.map((r) => r.seq as number);
    expect(seqs).toEqual([...seqs].sort((a, b2) => a - b2));
    for (const r of rows) {
      if (r.amountPaise !== undefined && r.amountPaise !== null) {
        expect(typeof r.amountPaise).toBe('string');
      }
    }
  });
});
