// test/passthrough.test.ts — S4 RISK swarm.
//
// Proves Layer 3 with numbers: flagged legit agents WITH valid in-scope
// artifacts are released (false positives freed), while flagged malicious
// requests (no artifact / forged signature / wrong merchant / over-cap /
// expired) stay blocked. Also pins the mock risk engine's thresholds to
// their documented behavior.
//
// S1's src/artifact.ts has NOT landed yet at time of writing, so artifact
// issuance below is a faithful contract implementation (Ed25519 over
// canonical(wire), base64 sig — CONTRACTS.md §1). When S1 lands, the batch
// swarm / integration tests can swap in the real issuer; the wire format and
// verification logic are identical per the frozen contract.

import { describe, expect, it } from 'vitest';
import { generateKeyPairSync, sign, verify } from 'node:crypto';
import { pramaanFraudGate } from '../src/passthrough.js';
import type {
  FraudEvaluateTransaction,
  PassthroughLedgerEvent,
  PassthroughDeps,
} from '../src/passthrough.js';
import type {
  DelegationArtifactWire,
  RiskSignals,
} from '../src/types.js';
import type { FraudVerdict } from '../src/types.js';
import {
  BLOCK_SCORE_THRESHOLD,
  MIN_ACCOUNT_AGE_DAYS,
  TRIGGERS,
  VELOCITY_PER_MIN_LIMIT,
  evaluateRisk,
} from '../risk-mock/engine.js';

// ---- faithful S1-contract artifact issuance (Ed25519, base64, canonical JSON) ----

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`)
    .join(',')}}`;
}

const { publicKey, privateKey } = generateKeyPairSync('ed25519');

function issueArtifact(overrides: {
  merchantId?: string;
  agentId?: string;
  categories?: string[];
  maxPerTxnPaise?: string;
  maxAggregatePaise?: string;
  expiresAt?: string;
}): { wire: DelegationArtifactWire; sig: string } {
  const wire: DelegationArtifactWire = {
    version: 1,
    artifactId: 'dl_' + 'a'.repeat(24),
    merchantId: overrides.merchantId ?? 'kadai-and-co',
    agentId: overrides.agentId ?? 'agent:shopping-assistant-v3',
    principal: 'user:asha',
    scope: {
      categories: overrides.categories ?? ['food', 'groceries'],
      maxPerTxnPaise: overrides.maxPerTxnPaise ?? '500000', // ₹5,000
      maxAggregatePaise: overrides.maxAggregatePaise ?? '2000000', // ₹20,000
      expiresAt: overrides.expiresAt ?? '2030-01-01T00:00:00.000Z',
    },
    issuedAt: '2026-01-01T00:00:00.000Z',
    nonce: 'n0nc3',
  };
  const sig = sign(null, Buffer.from(canonical(wire), 'utf8'), privateKey).toString('base64');
  return { wire, sig };
}

// ---- in-memory stub deps (ledger capture; faithful to contract semantics) ----

interface DepsFixture {
  ledger: PassthroughLedgerEvent[];
  spent: bigint;
}

function makeDeps(overrides: Partial<DepsFixture> = {}) {
  const fixture: DepsFixture = {
    ledger: [],
    spent: 0n,
    ...overrides,
  };
  const deps: PassthroughDeps = {
      verifyArtifact: (wire: DelegationArtifactWire, sig: string) => ({
        ok: verify(
          null,
          Buffer.from(canonical(wire), 'utf8'),
          publicKey,
          Buffer.from(sig, 'base64'),
        ),
      }),
      evaluateGate: (wire: DelegationArtifactWire, tx: FraudEvaluateTransaction, now: string) => {
        if (tx.merchantId !== wire.merchantId) {
          return { ok: false, reason: 'MERCHANT_MISMATCH' as const };
        }
        if (tx.amountPaise > BigInt(wire.scope.maxPerTxnPaise)) {
          return { ok: false, reason: 'CAP_EXCEEDED_PER_TXN' as const };
        }
        if (tx.category !== undefined && !wire.scope.categories.includes(tx.category)) {
          return { ok: false, reason: 'CATEGORY_OUT_OF_SCOPE' as const };
        }
        if (new Date(now).getTime() > new Date(wire.scope.expiresAt).getTime()) {
          return { ok: false, reason: 'ARTIFACT_EXPIRED' as const };
        }
        return { ok: true };
      },
      aggregateSpent: async (_artifactId: string) => fixture.spent,
      appendLedgerEvent: async (event: PassthroughLedgerEvent) => {
        fixture.ledger.push(event);
      },
      now: '2026-06-01T00:00:00.000Z',
  };
  return { deps, fixture };
}

// ---- shared scenario fixtures ----

const FLAGGED: RiskSignals = { velocityPerMin: 8, headless: true, accountAgeDays: 90 };
const CLEAR: RiskSignals = { velocityPerMin: 2, headless: false, accountAgeDays: 400 };

const legitTx: FraudEvaluateTransaction = {
  merchantId: 'kadai-and-co',
  agentId: 'agent:shopping-assistant-v3',
  amountPaise: 120000n, // ₹1,200 — within caps
  orderId: 'order_ref_1',
};

describe('pramaanFraudGate — the seven scenarios', () => {
  it('(1) risk-clear transaction -> RELEASE / RISK_ENGINE_CLEAR, no ledger row', async () => {
    const { deps, fixture } = makeDeps();
    const verdict = await pramaanFraudGate(legitTx, CLEAR, null, deps);
    expect(verdict).toEqual({ action: 'RELEASE', reason: 'RISK_ENGINE_CLEAR' });
    expect(fixture.ledger).toHaveLength(0); // no interposition, no ledger line
  });

  it('(2) flagged legit agent WITH valid in-scope artifact -> RELEASE / PRAMAAN_DELEGATION_PROOF (+ route writes AGENT_RELEASED)', async () => {
    const { deps, fixture } = makeDeps();
    const { wire, sig } = issueArtifact({});
    const verdict = await pramaanFraudGate(legitTx, FLAGGED, { wire, sig }, deps);
    expect(verdict).toEqual({
      action: 'RELEASE',
      reason: 'PRAMAAN_DELEGATION_PROOF',
      artifactId: wire.artifactId,
    });
    // passthrough itself writes nothing — the route does. Simulate route-side:
    await deps.appendLedgerEvent({
      type: 'AGENT_RELEASED',
      ...(verdict.artifactId !== undefined ? { artifactId: verdict.artifactId } : {}),
      ...(legitTx.orderId !== undefined ? { orderId: legitTx.orderId } : {}),
      amountPaise: legitTx.amountPaise,
      verdict: 'RELEASE',
      reason: 'PRAMAAN_DELEGATION_PROOF',
    });
    expect(fixture.ledger).toEqual([
      {
        type: 'AGENT_RELEASED',
        artifactId: wire.artifactId,
        orderId: 'order_ref_1',
        amountPaise: 120000n,
        verdict: 'RELEASE',
        reason: 'PRAMAAN_DELEGATION_PROOF',
      },
    ]);
  });

  it('(3) flagged malicious, no artifact -> BLOCK / NO_VALID_DELEGATION (+ ATTEMPT_BLOCKED)', async () => {
    const { deps, fixture } = makeDeps();
    const verdict = await pramaanFraudGate(legitTx, FLAGGED, null, deps);
    expect(verdict).toEqual({ action: 'BLOCK', reason: 'NO_VALID_DELEGATION' });
    await deps.appendLedgerEvent({
      type: 'ATTEMPT_BLOCKED',
      amountPaise: legitTx.amountPaise,
      verdict: 'DENY',
      reason: verdict.reason,
    });
    expect(fixture.ledger).toEqual([
      {
        type: 'ATTEMPT_BLOCKED',
        amountPaise: 120000n,
        verdict: 'DENY',
        reason: 'NO_VALID_DELEGATION',
      },
    ]);
  });

  it('(4) flagged with FORGED signature -> BLOCK', async () => {
    const { deps } = makeDeps();
    const { wire } = issueArtifact({});
    const forged = sign(
      null,
      Buffer.from(canonical({ ...wire, agentId: 'agent:evil-twin' }), 'utf8'),
      privateKey,
    ).toString('base64');
    const verdict = await pramaanFraudGate(legitTx, FLAGGED, { wire, sig: forged }, deps);
    expect(verdict).toEqual({ action: 'BLOCK', reason: 'NO_VALID_DELEGATION' });
  });

  it('(5) flagged with artifact but amount over per-txn cap -> BLOCK', async () => {
    const { deps } = makeDeps();
    const { wire, sig } = issueArtifact({ maxPerTxnPaise: '100000' }); // ₹1,000 cap
    const verdict = await pramaanFraudGate(legitTx, FLAGGED, { wire, sig }, deps); // ₹1,200 tx
    expect(verdict).toEqual({ action: 'BLOCK', reason: 'NO_VALID_DELEGATION' });
  });

  it('(5b) flagged with artifact but aggregate headroom exhausted -> BLOCK', async () => {
    const { deps } = makeDeps({ spent: 1950000n }); // ₹19,500 already spent, cap ₹20,000
    const { wire, sig } = issueArtifact({});
    const verdict = await pramaanFraudGate(legitTx, FLAGGED, { wire, sig }, deps); // ₹1,200 more would bust it
    expect(verdict).toEqual({ action: 'BLOCK', reason: 'NO_VALID_DELEGATION' });
  });

  it('(6) flagged with artifact for a DIFFERENT merchant -> BLOCK', async () => {
    const { deps } = makeDeps();
    const { wire, sig } = issueArtifact({ merchantId: 'some-other-shop' });
    const verdict = await pramaanFraudGate(legitTx, FLAGGED, { wire, sig }, deps);
    expect(verdict).toEqual({ action: 'BLOCK', reason: 'NO_VALID_DELEGATION' });
  });

  it('(6b) artifact belongs to a DIFFERENT agent -> BLOCK', async () => {
    const { deps } = makeDeps();
    const { wire, sig } = issueArtifact({ agentId: 'agent:someone-else' });
    const verdict = await pramaanFraudGate(legitTx, FLAGGED, { wire, sig }, deps);
    expect(verdict).toEqual({ action: 'BLOCK', reason: 'NO_VALID_DELEGATION' });
  });

  it('(7) flagged with EXPIRED artifact -> BLOCK', async () => {
    const { deps } = makeDeps();
    const { wire, sig } = issueArtifact({ expiresAt: '2026-01-01T00:00:00.000Z' }); // now = 2026-06-01
    const verdict = await pramaanFraudGate(legitTx, FLAGGED, { wire, sig }, deps);
    expect(verdict).toEqual({ action: 'BLOCK', reason: 'NO_VALID_DELEGATION' });
  });

  it('(8) flagged, tx carries out-of-scope category -> BLOCK; in-scope category -> RELEASE', async () => {
    const { deps } = makeDeps();
    const { wire, sig } = issueArtifact({ categories: ['food', 'groceries'] });
    const outOfScope = await pramaanFraudGate(
      { ...legitTx, category: 'crypto' },
      FLAGGED,
      { wire, sig },
      deps,
    );
    expect(outOfScope).toEqual({ action: 'BLOCK', reason: 'NO_VALID_DELEGATION' });

    const inScope = await pramaanFraudGate(
      { ...legitTx, category: 'food' },
      FLAGGED,
      { wire, sig },
      deps,
    );
    expect(inScope.action).toBe('RELEASE');
    expect(inScope.reason).toBe('PRAMAAN_DELEGATION_PROOF');
  });

  it('(9) missing sig or missing wire alone -> BLOCK (fail closed)', async () => {
    const { deps } = makeDeps();
    const { wire, sig } = issueArtifact({});
    const noSig = await pramaanFraudGate(legitTx, FLAGGED, { wire }, deps);
    const noWire = await pramaanFraudGate(legitTx, FLAGGED, { sig }, deps);
    expect(noSig).toEqual({ action: 'BLOCK', reason: 'NO_VALID_DELEGATION' });
    expect(noWire).toEqual({ action: 'BLOCK', reason: 'NO_VALID_DELEGATION' });
  });
});

describe('risk-mock engine — documented threshold behavior', () => {
  it('velocity threshold: > 5 triggers, 5 itself does not, 6 does', () => {
    expect(evaluateRisk({ velocityPerMin: 6, headless: false, accountAgeDays: 400 }).triggered).toContain(TRIGGERS.VELOCITY);
    expect(evaluateRisk({ velocityPerMin: 6, headless: false, accountAgeDays: 400 }).score).toBe(1);
    expect(evaluateRisk({ velocityPerMin: 5, headless: false, accountAgeDays: 400 }).triggered).not.toContain(TRIGGERS.VELOCITY);
    expect(VELOCITY_PER_MIN_LIMIT).toBe(5);
  });

  it('accountAge threshold: < 30 days triggers; 29 triggers, 30 does not, 31 does not', () => {
    expect(evaluateRisk({ velocityPerMin: 0, headless: false, accountAgeDays: 29 }).triggered).toContain(TRIGGERS.NEW_ACCOUNT);
    expect(evaluateRisk({ velocityPerMin: 0, headless: false, accountAgeDays: 30 }).triggered).not.toContain(TRIGGERS.NEW_ACCOUNT);
    expect(evaluateRisk({ velocityPerMin: 0, headless: false, accountAgeDays: 31 }).triggered).not.toContain(TRIGGERS.NEW_ACCOUNT);
    expect(MIN_ACCOUNT_AGE_DAYS).toBe(30);
  });

  it('headless: true triggers, false does not', () => {
    expect(evaluateRisk({ velocityPerMin: 0, headless: true, accountAgeDays: 400 }).triggered).toContain(TRIGGERS.HEADLESS);
    expect(evaluateRisk({ velocityPerMin: 0, headless: false, accountAgeDays: 400 }).triggered).not.toContain(TRIGGERS.HEADLESS);
  });

  it('2-of-3 -> BLOCK, 1-of-3 -> ALLOW, 3-of-3 -> BLOCK, 0-of-3 -> ALLOW', () => {
    expect(BLOCK_SCORE_THRESHOLD).toBe(2);
    expect(evaluateRisk({ velocityPerMin: 0, headless: false, accountAgeDays: 400 })).toEqual({
      action: 'ALLOW',
      score: 0,
      triggered: [],
    });
    expect(evaluateRisk({ velocityPerMin: 6, headless: false, accountAgeDays: 400 }).action).toBe('ALLOW');
    expect(evaluateRisk({ velocityPerMin: 6, headless: false, accountAgeDays: 29 }).action).toBe('BLOCK');
    expect(evaluateRisk({ velocityPerMin: 0, headless: true, accountAgeDays: 29 }).action).toBe('BLOCK');
    expect(evaluateRisk({ velocityPerMin: 6, headless: true, accountAgeDays: 29 }).action).toBe('BLOCK');
    expect(evaluateRisk({ velocityPerMin: 6, headless: true, accountAgeDays: 29 }).score).toBe(3);
  });

  it('deterministic: identical signals give identical output (no randomness)', () => {
    const signals = { velocityPerMin: 9, headless: true, accountAgeDays: 3 };
    expect(evaluateRisk(signals)).toEqual(evaluateRisk({ ...signals }));
  });
});

// Compile-time: verdicts are FraudVerdict, ledger rows use bigint paise.
const _typecheck: FraudVerdict = { action: 'BLOCK', reason: 'NO_VALID_DELEGATION' };
void _typecheck;

// ---- route-level: prove ledger discipline end-to-end via fastify inject ----

import fastify from 'fastify';
import { fraudRoutes } from '../src/routes/fraud.js';
import type { FraudRouteDeps } from '../src/routes/fraud.js';

function makeRouteDeps(verifyOk: boolean) {
  const ledger: Array<Record<string, unknown>> = [];
  const deps: FraudRouteDeps = {
    verifyArtifact: () => ({ ok: verifyOk, ...(verifyOk ? {} : { reason: 'SIGNATURE_INVALID' }) }),
    evaluateGate: () => ({ ok: true }),
    aggregateSpent: () => 0n,
    appendLedgerEvent: async (event) => {
      ledger.push(event as Record<string, unknown>);
    },
    now: () => '2026-06-01T00:00:00.000Z',
  };
  return { deps, ledger };
}

async function postFraud(payload: Record<string, unknown>, deps: FraudRouteDeps) {
  const app = fastify();
  await app.register(fraudRoutes, { deps });
  const res = await app.inject({ method: 'POST', url: '/fraud/evaluate', payload });
  await app.close();
  return { status: res.statusCode, body: res.json() as Record<string, unknown> };
}

describe('POST /fraud/evaluate — route-level ledger discipline', () => {
  const validWire = issueArtifact({}).wire;
  const validSig = issueArtifact({}).sig;

  it('risk-clear -> RELEASE, NO ledger row (no interposition)', async () => {
    const { deps, ledger } = makeRouteDeps(true);
    const { status, body } = await postFraud(
      {
        transaction: { merchantId: 'kadai-and-co', agentId: 'agent:shopping-assistant-v3', amountPaise: '120000' },
        riskSignals: { velocityPerMin: 2, headless: false, accountAgeDays: 400 },
      },
      deps,
    );
    expect(status).toBe(200);
    expect(body).toEqual({ action: 'RELEASE', reason: 'RISK_ENGINE_CLEAR' });
    expect(ledger).toHaveLength(0);
  });

  it('flagged + valid artifact -> RELEASE + AGENT_RELEASED row', async () => {
    const { deps, ledger } = makeRouteDeps(true);
    const { status, body } = await postFraud(
      {
        transaction: { merchantId: 'kadai-and-co', agentId: 'agent:shopping-assistant-v3', amountPaise: '120000', orderId: 'order_9' },
        riskSignals: { velocityPerMin: 8, headless: true, accountAgeDays: 90 },
        artifactWire: validWire,
        sig: validSig,
      },
      deps,
    );
    expect(status).toBe(200);
    expect(body).toEqual({
      action: 'RELEASE',
      reason: 'PRAMAAN_DELEGATION_PROOF',
      artifactId: validWire.artifactId,
    });
    expect(ledger).toEqual([
      {
        type: 'AGENT_RELEASED',
        artifactId: validWire.artifactId,
        orderId: 'order_9',
        amountPaise: 120000n,
        verdict: 'RELEASE',
        reason: 'PRAMAAN_DELEGATION_PROOF',
      },
    ]);
  });

  it('flagged malicious, no artifact -> BLOCK + ATTEMPT_BLOCKED row', async () => {
    const { deps, ledger } = makeRouteDeps(true);
    const { status, body } = await postFraud(
      {
        transaction: { merchantId: 'kadai-and-co', agentId: 'agent:shopping-assistant-v3', amountPaise: '120000' },
        riskSignals: { velocityPerMin: 8, headless: true, accountAgeDays: 90 },
      },
      deps,
    );
    expect(status).toBe(200);
    expect(body).toEqual({ action: 'BLOCK', reason: 'NO_VALID_DELEGATION' });
    expect(ledger).toEqual([
      {
        type: 'ATTEMPT_BLOCKED',
        amountPaise: 120000n,
        verdict: 'DENY',
        reason: 'NO_VALID_DELEGATION',
      },
    ]);
  });

  it('flagged + forged signature -> BLOCK + ATTEMPT_BLOCKED row', async () => {
    const { deps, ledger } = makeRouteDeps(false); // verification fails
    const { body } = await postFraud(
      {
        transaction: { merchantId: 'kadai-and-co', agentId: 'agent:shopping-assistant-v3', amountPaise: '120000' },
        riskSignals: { velocityPerMin: 8, headless: true, accountAgeDays: 90 },
        artifactWire: validWire,
        sig: Buffer.from('forged').toString('base64'),
      },
      deps,
    );
    expect(body).toEqual({ action: 'BLOCK', reason: 'NO_VALID_DELEGATION' });
    // NOTE: FraudVerdict carries artifactId only on PRAMAAN_DELEGATION_PROOF
    // (frozen type), so a signature-invalid BLOCK row has no artifactId.
    expect(ledger).toEqual([
      {
        type: 'ATTEMPT_BLOCKED',
        amountPaise: 120000n,
        verdict: 'DENY',
        reason: 'NO_VALID_DELEGATION',
      },
    ]);
  });

  it('rejects non-string / negative amountPaise with 400 (paise boundary)', async () => {
    const { deps, ledger } = makeRouteDeps(true);
    const bad1 = await postFraud(
      {
        transaction: { merchantId: 'm', agentId: 'a', amountPaise: 120000 },
        riskSignals: { velocityPerMin: 1, headless: false, accountAgeDays: 100 },
      },
      deps,
    );
    const bad2 = await postFraud(
      {
        transaction: { merchantId: 'm', agentId: 'a', amountPaise: '-5' },
        riskSignals: { velocityPerMin: 1, headless: false, accountAgeDays: 100 },
      },
      deps,
    );
    expect(bad1.status).toBe(400);
    expect(bad2.status).toBe(400);
    expect(ledger).toHaveLength(0);
  });
});
