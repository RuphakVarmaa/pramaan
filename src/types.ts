// Pramaan — frozen contract types (CONTRACTS.md v1.0)
// Single source of truth for cross-module types. Swarms import from here;
// do not duplicate type definitions in owned modules.

export type GateReason =
  | 'CAP_EXCEEDED_PER_TXN'
  | 'CAP_EXCEEDED_AGGREGATE'
  | 'CATEGORY_OUT_OF_SCOPE'
  | 'ARTIFACT_EXPIRED'
  | 'MERCHANT_MISMATCH'
  | 'SIGNATURE_INVALID'
  | 'ARTIFACT_UNKNOWN';

export type LedgerEventType =
  | 'DELEGATION_ISSUED'
  | 'ATTEMPT_ALLOWED'
  | 'ATTEMPT_BLOCKED'
  | 'PAYMENT_CAPTURED'
  | 'AGENT_RELEASED'
  | 'DISPUTE_OPENED'
  | 'EVIDENCE_GENERATED';

export type Verdict = 'ALLOW' | 'BLOCK' | 'RELEASE' | 'DENY';

/** Layer 1 — the delegation artifact. All paise fields are bigint in-process. */
export interface DelegationArtifact {
  version: 1;
  artifactId: string;
  merchantId: string;
  agentId: string;
  principal: string;
  scope: {
    categories: string[];
    maxPerTxnPaise: bigint;
    maxAggregatePaise: bigint;
    expiresAt: string;
  };
  issuedAt: string;
  nonce: string;
}

/** Wire form: paise fields as strings (JSON has no bigint). */
export interface DelegationArtifactWire {
  version: 1;
  artifactId: string;
  merchantId: string;
  agentId: string;
  principal: string;
  scope: {
    categories: string[];
    maxPerTxnPaise: string;
    maxAggregatePaise: string;
    expiresAt: string;
  };
  issuedAt: string;
  nonce: string;
}

export interface SignedArtifact {
  artifact: DelegationArtifactWire;
  sig: string; // base64 Ed25519 signature over canonical(wire artifact)
}

export interface LedgerRow {
  seq: number;
  ts: string;
  type: LedgerEventType;
  artifactId?: string;
  orderId?: string;
  amountPaise?: bigint;
  verdict?: Verdict;
  reason?: string;
  prevHash: string;
  selfHash: string;
}

export interface CartLine {
  sku: string;
  qty: number;
  unitPaise: bigint;
  category: string;
}

export interface Cart {
  merchantId: string;
  lines: CartLine[];
}

export interface GateInput {
  artifact: DelegationArtifact;
  cart: Cart;
  now: string;
  aggregateSpentPaise: bigint;
}

export interface GateVerdict {
  allowed: boolean;
  reason?: GateReason;
  totalPaise: bigint;
  aggregateAfterPaise: bigint;
}

export interface Dispute {
  disputeId: string;
  delegationId: string;
  amountPaise: bigint;
  reason: string;
  openedAt: string;
}

export interface RiskSignals {
  velocityPerMin: number;
  headless: boolean;
  accountAgeDays: number;
}

export interface FraudTransaction {
  merchantId: string;
  agentId: string;
  amountPaise: bigint;
  orderId?: string;
}

export type FraudAction = 'RELEASE' | 'BLOCK';

export interface FraudVerdict {
  action: FraudAction;
  reason:
    | 'RISK_ENGINE_CLEAR'
    | 'RISK_ENGINE_DENY'
    | 'PRAMAAN_DELEGATION_PROOF'
    | 'NO_VALID_DELEGATION';
  artifactId?: string;
}

// ---- conversion helpers (wire <-> in-process) ----

export function artifactToWire(a: DelegationArtifact): DelegationArtifactWire {
  return {
    version: 1,
    artifactId: a.artifactId,
    merchantId: a.merchantId,
    agentId: a.agentId,
    principal: a.principal,
    scope: {
      categories: [...a.scope.categories],
      maxPerTxnPaise: a.scope.maxPerTxnPaise.toString(),
      maxAggregatePaise: a.scope.maxAggregatePaise.toString(),
      expiresAt: a.scope.expiresAt,
    },
    issuedAt: a.issuedAt,
    nonce: a.nonce,
  };
}

export function artifactFromWire(w: DelegationArtifactWire): DelegationArtifact {
  return {
    version: 1,
    artifactId: w.artifactId,
    merchantId: w.merchantId,
    agentId: w.agentId,
    principal: w.principal,
    scope: {
      categories: [...w.scope.categories],
      maxPerTxnPaise: BigInt(w.scope.maxPerTxnPaise),
      maxAggregatePaise: BigInt(w.scope.maxAggregatePaise),
      expiresAt: w.scope.expiresAt,
    },
    issuedAt: w.issuedAt,
    nonce: w.nonce,
  };
}
