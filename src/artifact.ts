// Pramaan — delegation artifacts (CONTRACTS.md §1)
// issueDelegation mints and signs a DelegationArtifact; verifyArtifact checks
// structural validity, signature, and expiry against a caller-supplied `now`
// (never a hidden clock). Zero npm dependencies.

import { randomBytes } from 'node:crypto';
import { sign, verify } from './crypto.js';
import type { DelegationArtifact, DelegationArtifactWire, GateReason } from './types.js';
import { artifactToWire, artifactFromWire } from './types.js';

export type IssueDelegationInput = {
  merchantId: string;
  agentId: string;
  principal: string;
  scope: {
    categories: string[];      // subset of catalog categories, non-empty
    maxPerTxnPaise: bigint;    // per-transaction cap, > 0n
    maxAggregatePaise: bigint; // lifetime aggregate cap, > 0n
    expiresAt: string;         // ISO-8601 UTC, strictly after issuedAt
  };
};

export type Signer = { publicKey: string; privateKey: string };

export type VerifyArtifactOk = { ok: true; artifact: DelegationArtifact };
export type VerifyArtifactErr = { ok: false; reason: GateReason };
export type VerifyArtifactResult = VerifyArtifactOk | VerifyArtifactErr;

// ---------------------------------------------------------------------------
// §1.4 issue
// ---------------------------------------------------------------------------

export function issueDelegation(
  input: IssueDelegationInput,
  signer: Signer,
): { artifact: DelegationArtifact; sig: string } {
  if (typeof input.merchantId !== 'string' || input.merchantId.length === 0) {
    throw new Error('issueDelegation: merchantId must be a non-empty string');
  }
  if (typeof input.agentId !== 'string' || input.agentId.length === 0) {
    throw new Error('issueDelegation: agentId must be a non-empty string');
  }
  if (typeof input.principal !== 'string' || input.principal.length === 0) {
    throw new Error('issueDelegation: principal must be a non-empty string');
  }
  validateScope(input.scope);

  const artifact: DelegationArtifact = {
    version: 1,
    artifactId: 'dl_' + randomBytes(12).toString('hex'), // "dl_" + 24 hex
    merchantId: input.merchantId,
    agentId: input.agentId,
    principal: input.principal,
    scope: {
      categories: [...input.scope.categories],
      maxPerTxnPaise: input.scope.maxPerTxnPaise,
      maxAggregatePaise: input.scope.maxAggregatePaise,
      // issuedAt is set here (per §1.4 "sets issuedAt"); normalize to UTC ISO.
      expiresAt: toIso(input.scope.expiresAt),
    },
    issuedAt: new Date().toISOString(),
    nonce: randomBytes(16).toString('hex'), // 32 hex, single-use
  };

  // §1.2: signature is over the canonical JSON of the WIRE form (paise as strings).
  const sig = sign(artifactToWire(artifact), signer.privateKey);
  return { artifact, sig };
}

// ---------------------------------------------------------------------------
// §1.4 verify
// ---------------------------------------------------------------------------

export function verifyArtifact(
  wire: DelegationArtifactWire,
  sig: string,
  publicKey: string,
  now: string,
): VerifyArtifactResult {
  // Structural validation first — a malformed artifact fails closed regardless
  // of signature bytes.
  if (!isStructurallyValid(wire)) {
    return { ok: false, reason: 'SIGNATURE_INVALID' };
  }

  // §1.5: expiresAt < now → expired (expiresAt === now is still valid).
  if (Date.parse(wire.scope.expiresAt) < Date.parse(now)) {
    return { ok: false, reason: 'ARTIFACT_EXPIRED' };
  }

  if (!verify(wire, sig, publicKey)) {
    return { ok: false, reason: 'SIGNATURE_INVALID' };
  }

  return { ok: true, artifact: artifactFromWire(wire) };
}

// ---------------------------------------------------------------------------
// validation helpers
// ---------------------------------------------------------------------------

function validateScope(scope: IssueDelegationInput['scope']): void {
  if (!Array.isArray(scope.categories) || scope.categories.length === 0) {
    throw new Error('issueDelegation: scope.categories must be a non-empty array');
  }
  for (const c of scope.categories) {
    if (typeof c !== 'string' || c.length === 0) {
      throw new Error('issueDelegation: scope.categories must contain non-empty strings');
    }
  }
  if (typeof scope.maxPerTxnPaise !== 'bigint' || scope.maxPerTxnPaise <= 0n) {
    throw new Error('issueDelegation: scope.maxPerTxnPaise must be a positive bigint (integer paise)');
  }
  if (typeof scope.maxAggregatePaise !== 'bigint' || scope.maxAggregatePaise <= 0n) {
    throw new Error('issueDelegation: scope.maxAggregatePaise must be a positive bigint (integer paise)');
  }
  if (!isValidIsoString(scope.expiresAt)) {
    throw new Error('issueDelegation: scope.expiresAt must be a valid ISO-8601 UTC string');
  }
  if (Date.parse(scope.expiresAt) <= Date.now()) {
    throw new Error('issueDelegation: scope.expiresAt must be strictly after issuedAt (now)');
  }
}

function isStructurallyValid(wire: DelegationArtifactWire): boolean {
  if (
    typeof wire.artifactId !== 'string' ||
    !/^dl_[0-9a-f]{24}$/.test(wire.artifactId) ||
    wire.version !== 1 ||
    typeof wire.merchantId !== 'string' || wire.merchantId.length === 0 ||
    typeof wire.agentId !== 'string' || wire.agentId.length === 0 ||
    typeof wire.principal !== 'string' || wire.principal.length === 0
  ) {
    return false;
  }
  if (!Array.isArray(wire.scope.categories) || wire.scope.categories.length === 0) {
    return false;
  }
  for (const c of wire.scope.categories) {
    if (typeof c !== 'string' || c.length === 0) return false;
  }
  if (!/^\d+$/.test(wire.scope.maxPerTxnPaise) || BigInt(wire.scope.maxPerTxnPaise) <= 0n) return false;
  if (!/^\d+$/.test(wire.scope.maxAggregatePaise) || BigInt(wire.scope.maxAggregatePaise) <= 0n) return false;
  if (!isValidIsoString(wire.scope.expiresAt)) return false;
  if (!isValidIsoString(wire.issuedAt)) return false;
  if (Date.parse(wire.scope.expiresAt) <= Date.parse(wire.issuedAt)) return false;
  if (typeof wire.nonce !== 'string' || !/^[0-9a-f]{32}$/.test(wire.nonce)) return false;
  return true;
}

/** ISO-8601 UTC, millisecond precision (e.g. 2026-09-04T12:00:00.000Z). */
function isValidIsoString(s: string): boolean {
  if (typeof s !== 'string') return false;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(s)) return false;
  return !Number.isNaN(Date.parse(s));
}

/** Normalize to UTC ISO string (keeps Z form intact). */
function toIso(s: string): string {
  if (!isValidIsoString(s)) {
    throw new Error(`issueDelegation: invalid ISO-8601 string: ${s}`);
  }
  return new Date(s).toISOString();
}
