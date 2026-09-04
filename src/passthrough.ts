// src/passthrough.ts — Layer 3: free authorized agents, block malicious ones.
//
// Implements CONTRACTS.md §6 flow EXACTLY:
//   (a) risk engine ALLOW                    -> RELEASE / RISK_ENGINE_CLEAR
//       (no interposition; no ledger row is written on this path)
//   (b) risk BLOCK, no artifact provided     -> BLOCK / NO_VALID_DELEGATION
//   (c) risk BLOCK, artifact provided:
//         - signature invalid                -> BLOCK / NO_VALID_DELEGATION
//         - artifact/agent/merchant/scope
//           mismatch (incl. per-txn cap,
//           aggregate headroom, category
//           when carried, expiry)            -> BLOCK / NO_VALID_DELEGATION
//         - ALL checks pass                  -> RELEASE / PRAMAAN_DELEGATION_PROOF
//           (+ artifactId). The CALLER (route) appends the AGENT_RELEASED
//           ledger row — passthrough itself writes nothing and stays pure.
//
// CATEGORY HANDLING (documented choice, reported to Orchestrator):
//   A fraud-evaluate request carries ONE purchase. The frozen FraudTransaction
//   type has no category field, but this module accepts an optional `category`
//   on the transaction (FraudEvaluateTransaction). If the tx carries a category,
//   it must be inside wire.scope.categories. If it does NOT, we scope-check
//   amount + merchant (+ caps + expiry) only and skip the category check — we
//   do not guess a category for a purchase the caller never classified, and an
//   absent category must not manufacture a denial the issuer never expressed.
//   The route-side adapter (src/routes/fraud.ts, makeEvaluateGateDep) mirrors
//   this when bridging to S2's cart-based gate: a tx without a category is
//   evaluated on a synthetic line whose category is trivially in-scope, so the
//   gate's category step is neutralized for single unclassified purchases.
//
// All dependencies are injected — pure and unit-testable (no db/env access,
// no Date.now(); `now` arrives via deps).

import { evaluateRisk } from '../risk-mock/engine.js';
import type {
  DelegationArtifactWire,
  FraudTransaction,
  FraudVerdict,
  GateReason,
  LedgerEventType,
  RiskSignals,
  Verdict,
} from './types.js';

/** A single purchase. Carries an optional category when the caller classified it.
 *  `orderId` is re-declared to tolerate explicit `undefined` at construction
 *  sites under exactOptionalPropertyTypes (S2's app.ts builds tx objects that way). */
export type FraudEvaluateTransaction = FraudTransaction & {
  category?: string;
  orderId?: string | undefined;
};

export interface PramaanArtifactInput {
  wire?: DelegationArtifactWire;
  sig?: string;
}

/** Result of artifact verification. `reason` is free-form (route adapters may
 *  surface provider strings); passthrough consumes only `ok` — every failure
 *  maps to NO_VALID_DELEGATION per CONTRACTS §6. */
export interface VerifyArtifactResult {
  ok: boolean;
  reason?: string;
}

/** Result of scope evaluation. Same rule: passthrough consumes only `ok`. */
export interface EvaluateGateResult {
  ok: boolean;
  reason?: string;
}

/** Event shape handed to the injected ledger writer (mirrors LedgerRow's
 *  optional fields; the real adapter forwards to S1's appendLedgerEvent(db, event)). */
export interface PassthroughLedgerEvent {
  type: LedgerEventType;
  artifactId?: string;
  orderId?: string;
  amountPaise?: bigint;
  verdict?: Verdict;
  reason?: string;
}

export interface PassthroughDeps {
  /** S1 artifact verification (signature + structural validity; expiry when
   *  the implementation takes a `now`). Return { ok:false, reason } to block. */
  verifyArtifact: (
    wire: DelegationArtifactWire,
    sig: string,
    now?: string,
  ) => Promise<VerifyArtifactResult> | VerifyArtifactResult;
  /** Scope evaluation for this exact transaction (merchant, per-txn cap,
   *  expiry; aggregate when the implementation folds spend in). */
  evaluateGate: (
    wire: DelegationArtifactWire,
    tx: FraudEvaluateTransaction,
    now: string,
  ) => Promise<EvaluateGateResult> | EvaluateGateResult;
  /** Captured spend so far for this artifact (aggregate-cap source of truth). */
  aggregateSpent: (artifactId: string) => Promise<bigint> | bigint;
  /** Ledger writer (route/test harness captures; S1 appendLedgerEvent in prod). */
  appendLedgerEvent: (event: PassthroughLedgerEvent) => Promise<unknown> | unknown;
  /** ISO-8601 UTC timestamp — injected, never Date.now() inside this module. */
  now: string;
}

export async function pramaanFraudGate(
  tx: FraudEvaluateTransaction,
  signals: RiskSignals,
  artifactInput: PramaanArtifactInput | null,
  deps: PassthroughDeps,
): Promise<FraudVerdict> {
  // (a) Risk engine clear -> no interposition, no ledger line.
  const risk = evaluateRisk(signals);
  if (risk.action === 'ALLOW') {
    return { action: 'RELEASE', reason: 'RISK_ENGINE_CLEAR' };
  }

  // (b) Flagged, but the requester presents no delegation proof.
  const wire = artifactInput?.wire;
  const sig = artifactInput?.sig;
  if (!wire || !sig) {
    return { action: 'BLOCK', reason: 'NO_VALID_DELEGATION' };
  }

  // (c1) Signature / structural verification.
  const verification = await deps.verifyArtifact(wire, sig, deps.now);
  if (!verification.ok) {
    return { action: 'BLOCK', reason: 'NO_VALID_DELEGATION' };
  }

  // (c2) The artifact must belong to the agent attempting the payment.
  if (wire.agentId !== tx.agentId) {
    return { action: 'BLOCK', reason: 'NO_VALID_DELEGATION' };
  }

  // (c3) Category, only when the transaction carries one (see header note).
  if (tx.category !== undefined && !wire.scope.categories.includes(tx.category)) {
    return { action: 'BLOCK', reason: 'NO_VALID_DELEGATION' };
  }

  // (c4) Aggregate headroom: captured spend + this purchase <= aggregate cap.
  //      Fail closed if spend history is unavailable.
  let spent: bigint;
  try {
    spent = await deps.aggregateSpent(wire.artifactId);
  } catch {
    return { action: 'BLOCK', reason: 'NO_VALID_DELEGATION' };
  }
  if (spent + tx.amountPaise > BigInt(wire.scope.maxAggregatePaise)) {
    return { action: 'BLOCK', reason: 'NO_VALID_DELEGATION' };
  }

  // (c5) Scope: merchant match, per-txn cap, expiry (+ any folded-in checks).
  const scope = await deps.evaluateGate(wire, tx, deps.now);
  if (!scope.ok) {
    return { action: 'BLOCK', reason: 'NO_VALID_DELEGATION' };
  }

  // All checks passed — the flagged agent proved delegation. The CALLER (route)
  // appends the AGENT_RELEASED row; this module stays ledger-silent.
  return {
    action: 'RELEASE',
    reason: 'PRAMAAN_DELEGATION_PROOF',
    artifactId: wire.artifactId,
  };
}
