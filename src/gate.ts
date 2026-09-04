// Pramaan — the gate. (S2 RAILS, CONTRACTS.md §3)
//
// A pure function. No I/O, no clock reads, no side effects. The caller
// supplies `now` and the running `aggregateSpentPaise`; the gate only decides.
//
// Money is bigint paise end to end (shared invariant §8.3).

import type { GateInput, GateReason, GateVerdict } from './types.js';

/**
 * Evaluate a cart against a delegation artifact's scope.
 *
 * Evaluation order (first violation wins, exactly one reason):
 *   1. MERCHANT_MISMATCH       cart.merchantId !== artifact.merchantId
 *   2. ARTIFACT_EXPIRED        now > artifact.scope.expiresAt
 *   3. CAP_EXCEEDED_PER_TXN    totalPaise > maxPerTxnPaise
 *   4. CAP_EXCEEDED_AGGREGATE  aggregateSpentPaise + totalPaise > maxAggregatePaise
 *   5. CATEGORY_OUT_OF_SCOPE   any cart line's category not in scope.categories
 *
 * totalPaise = Σ qty × unitPaise (bigint math).
 */
export function evaluateGate(input: GateInput): GateVerdict {
  const { artifact, cart, now, aggregateSpentPaise } = input;
  const scope = artifact.scope;

  // Total in pure bigint arithmetic — never a float, never Number().
  let totalPaise = 0n;
  for (const line of cart.lines) {
    totalPaise += BigInt(line.qty) * line.unitPaise;
  }

  const aggregateAfterPaise = aggregateSpentPaise + totalPaise;

  // 1. MERCHANT_MISMATCH
  if (cart.merchantId !== artifact.merchantId) {
    return block('MERCHANT_MISMATCH', totalPaise, aggregateAfterPaise);
  }

  // 2. ARTIFACT_EXPIRED (strictly after; at the expiry instant it is still valid)
  if (Date.parse(now) > Date.parse(scope.expiresAt)) {
    return block('ARTIFACT_EXPIRED', totalPaise, aggregateAfterPaise);
  }

  // 3. CAP_EXCEEDED_PER_TXN
  if (totalPaise > scope.maxPerTxnPaise) {
    return block('CAP_EXCEEDED_PER_TXN', totalPaise, aggregateAfterPaise);
  }

  // 4. CAP_EXCEEDED_AGGREGATE
  if (aggregateAfterPaise > scope.maxAggregatePaise) {
    return block('CAP_EXCEEDED_AGGREGATE', totalPaise, aggregateAfterPaise);
  }

  // 5. CATEGORY_OUT_OF_SCOPE
  const allowed = new Set(scope.categories);
  for (const line of cart.lines) {
    if (!allowed.has(line.category)) {
      return block('CATEGORY_OUT_OF_SCOPE', totalPaise, aggregateAfterPaise);
    }
  }

  return { allowed: true, totalPaise, aggregateAfterPaise };
}

function block(
  reason: GateReason,
  totalPaise: bigint,
  aggregateAfterPaise: bigint,
): GateVerdict {
  return { allowed: false, reason, totalPaise, aggregateAfterPaise };
}
