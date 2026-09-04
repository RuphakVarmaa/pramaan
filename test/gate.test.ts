// Pramaan — gate tests. (S2 RAILS, CONTRACTS.md §3)
//
// In-scope cart passes; each of the 5 reasons fires on its trigger; exact
// evaluation-order case (wrong merchant AND expired -> MERCHANT_MISMATCH).

import { describe, it, expect } from 'vitest';
import { evaluateGate } from '../src/gate.js';
import type { DelegationArtifact, GateInput } from '../src/types.js';

function makeArtifact(overrides: Partial<DelegationArtifact['scope']> = {}): DelegationArtifact {
  return {
    version: 1,
    artifactId: 'dl_test_1',
    merchantId: 'kadai-and-co',
    agentId: 'agent-007',
    principal: 'principal-42',
    scope: {
      categories: ['coffee', 'equipment'],
      maxPerTxnPaise: 500_000n, // ₹5,000
      maxAggregatePaise: 2_000_000n, // ₹20,000
      expiresAt: '2099-01-01T00:00:00Z',
      ...overrides,
    },
    issuedAt: '2026-01-01T00:00:00Z',
    nonce: 'n0nce',
  };
}

const NOW = '2026-06-01T12:00:00Z';

function makeInput(overrides: {
  artifact?: DelegationArtifact;
  cart?: GateInput['cart'];
  now?: string;
  aggregateSpentPaise?: bigint;
} = {}): GateInput {
  return {
    artifact: overrides.artifact ?? makeArtifact(),
    cart:
      overrides.cart ??
      ({ merchantId: 'kadai-and-co', lines: [{ sku: 'SKU-1', category: 'coffee', qty: 2, unitPaise: 125_00n }] } as GateInput['cart']),
    now: overrides.now ?? NOW,
    aggregateSpentPaise: overrides.aggregateSpentPaise ?? 0n,
  };
}

describe('evaluateGate', () => {
  it('allows an in-scope cart and computes exact totals', () => {
    const cart = {
      merchantId: 'kadai-and-co',
      lines: [
        { sku: 'A', category: 'coffee', qty: 2, unitPaise: 125_00n },
        { sku: 'B', category: 'equipment', qty: 1, unitPaise: 990_00n },
      ],
    } as GateInput['cart'];
    const v = evaluateGate(makeInput({ cart }));
    expect(v.allowed).toBe(true);
    expect(v.totalPaise).toBe(2n * 125_00n + 990_00n); // 124000
    expect(v.aggregateAfterPaise).toBe(124_000n);
    expect(v.reason).toBeUndefined();
  });

  it('MERCHANT_MISMATCH fires on wrong merchant id', () => {
    const cart = {
      merchantId: 'evil-clone-shop',
      lines: [{ sku: 'A', category: 'coffee', qty: 1, unitPaise: 100n }],
    } as GateInput['cart'];
    const v = evaluateGate(makeInput({ cart }));
    expect(v.allowed).toBe(false);
    expect(v.reason).toBe('MERCHANT_MISMATCH');
  });

  it('ARTIFACT_EXPIRED fires when now is past expiresAt', () => {
    const artifact = makeArtifact({ expiresAt: '2026-01-01T00:00:00Z' });
    const v = evaluateGate(makeInput({ artifact, now: '2026-06-01T00:00:00Z' }));
    expect(v.allowed).toBe(false);
    expect(v.reason).toBe('ARTIFACT_EXPIRED');
  });

  it('CAP_EXCEEDED_PER_TXN fires when total exceeds per-txn cap', () => {
    const artifact = makeArtifact({ maxPerTxnPaise: 10_00n });
    const cart = {
      merchantId: 'kadai-and-co',
      lines: [{ sku: 'A', category: 'coffee', qty: 2, unitPaise: 10_00n }], // 2000 > 1000
    } as GateInput['cart'];
    const v = evaluateGate(makeInput({ artifact, cart }));
    expect(v.allowed).toBe(false);
    expect(v.reason).toBe('CAP_EXCEEDED_PER_TXN');
  });

  it('CAP_EXCEEDED_AGGREGATE fires when aggregate + total exceeds aggregate cap', () => {
    const artifact = makeArtifact({
      maxPerTxnPaise: 500_000n,
      maxAggregatePaise: 100_000n, // below per-txn so only aggregate trips
    });
    const cart = {
      merchantId: 'kadai-and-co',
      lines: [{ sku: 'A', category: 'coffee', qty: 1, unitPaise: 90_000n }],
    } as GateInput['cart'];
    const v = evaluateGate(makeInput({ artifact, cart, aggregateSpentPaise: 50_000n })); // 50000+90000 > 100000
    expect(v.allowed).toBe(false);
    expect(v.reason).toBe('CAP_EXCEEDED_AGGREGATE');
    expect(v.aggregateAfterPaise).toBe(140_000n);
  });

  it('CATEGORY_OUT_OF_SCOPE fires for a disallowed category', () => {
    const cart = {
      merchantId: 'kadai-and-co',
      lines: [{ sku: 'X', category: 'fireworks', qty: 1, unitPaise: 100n }],
    } as GateInput['cart'];
    const v = evaluateGate(makeInput({ cart }));
    expect(v.allowed).toBe(false);
    expect(v.reason).toBe('CATEGORY_OUT_OF_SCOPE');
  });

  it('evaluation order: wrong merchant AND expired -> MERCHANT_MISMATCH (first violation wins)', () => {
    const artifact = makeArtifact({ expiresAt: '2020-01-01T00:00:00Z' });
    const cart = {
      merchantId: 'not-kadai',
      lines: [{ sku: 'A', category: 'fireworks', qty: 999, unitPaise: 999_999n }],
    } as GateInput['cart'];
    const v = evaluateGate(makeInput({ artifact, cart }));
    expect(v.allowed).toBe(false);
    expect(v.reason).toBe('MERCHANT_MISMATCH'); // not ARTIFACT_EXPIRED or CAP_*
  });

  it('evaluation order: expired + per-txn over cap -> ARTIFACT_EXPIRED', () => {
    const artifact = makeArtifact({ expiresAt: '2020-01-01T00:00:00Z', maxPerTxnPaise: 1n });
    const v = evaluateGate(makeInput({ artifact }));
    expect(v.reason).toBe('ARTIFACT_EXPIRED');
  });

  it('evaluation order: per-txn over cap + out-of-scope category -> CAP_EXCEEDED_PER_TXN', () => {
    const artifact = makeArtifact({ maxPerTxnPaise: 1n });
    const cart = {
      merchantId: 'kadai-and-co',
      lines: [{ sku: 'A', category: 'fireworks', qty: 1, unitPaise: 10_000n }],
    } as GateInput['cart'];
    const v = evaluateGate(makeInput({ artifact, cart }));
    expect(v.reason).toBe('CAP_EXCEEDED_PER_TXN');
  });

  it('boundary: total exactly equal to per-txn and aggregate caps is allowed', () => {
    const artifact = makeArtifact({ maxPerTxnPaise: 200n, maxAggregatePaise: 200n });
    const cart = {
      merchantId: 'kadai-and-co',
      lines: [{ sku: 'A', category: 'coffee', qty: 2, unitPaise: 100n }],
    } as GateInput['cart'];
    const v = evaluateGate(makeInput({ artifact, cart }));
    expect(v.allowed).toBe(true);
  });

  it('boundary: artifact exactly at expiry instant is still valid', () => {
    const artifact = makeArtifact({ expiresAt: NOW });
    const v = evaluateGate(makeInput({ artifact }));
    expect(v.allowed).toBe(true);
  });

  it('big integer totals stay exact (no float coercion)', () => {
    const artifact = makeArtifact({
      maxPerTxnPaise: 10n ** 15n,
      maxAggregatePaise: 10n ** 15n,
    });
    const cart = {
      merchantId: 'kadai-and-co',
      lines: [{ sku: 'A', category: 'coffee', qty: 999_999_999, unitPaise: 999_999n }],
    } as GateInput['cart'];
    const v = evaluateGate(makeInput({ artifact, cart }));
    expect(v.allowed).toBe(true);
    expect(v.totalPaise).toBe(999_999_999n * 999_999n);
    expect(v.totalPaise).toBe(999_998_999_000_001n);
  });
});
