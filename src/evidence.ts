// Pramaan — evidence pack generator (S3 EVIDENCE, CONTRACTS.md §5).
//
// generateEvidencePack(db, delegationId, disputeId, opts?) pulls the
// delegation's ledger span, the dispute metadata (data/disputes.json
// sidecar, tolerated when absent), and the issuance artifact
// (data/artifacts.json sidecar, tolerated when absent), computes the
// scope-vs-actual diff and the chain proof, renders the dossier, and
// returns { html, sha256, generatedAt }.
//
// Sidecar shapes (REPORTED to the Orchestrator for S2 alignment):
//   data/artifacts.json : { [delegationId]: { artifact: DelegationArtifactWire, sig: string } }
//   data/disputes.json  : [{ disputeId, delegationId, amountPaise (string), reason, openedAt }]
//
// Identifier note: the delegation id IS the artifact id (the artifact is the
// delegation's proof object); ledger rows carry it in the artifactId column.
//
// Digest note (self-reference): a footer cannot display the sha256 of the
// full HTML that contains it (that digest would need to be its own
// preimage). The pack therefore carries TWO well-defined digests:
//   - returned `sha256`: sha256 of the delivered HTML bytes — verifiable by
//     any hashing tool;
//   - the footer seal: sha256 of the document with the seal field
//     neutralized (64 zeroes) — recomputable by anyone from the file alone.
//
// Money invariant: paise stay bigint until fmtPaise() in the template.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { canonicalize } from './crypto.js';
import {
  GENESIS_PREV_HASH,
  aggregateSpent,
  appendLedgerEvent,
  readLedger,
  verifyChain,
} from './ledger.js';
import type { DelegationArtifactWire, LedgerRow } from './types.js';
import { artifactFromWire } from './types.js';
import {
  fmtPaise,
  istTimestamp,
  renderEvidencePack,
  sha256Html,
  utcTimestamp,
  type DiffLine,
  type EvidencePackData,
} from './templates/evidence.js';

export { renderEvidencePack } from './templates/evidence.js';
export type { EvidencePack } from './templates/evidence.js';

export interface GenerateEvidenceOptions {
  /** Generation moment (UTC ISO). Defaults to now. Deterministic in tests. */
  now?: string;
  /** Directory containing disputes.json / artifacts.json sidecars (default "data"). */
  dataDir?: string;
}

export interface EvidencePack {
  html: string;
  /** sha256 of the full delivered HTML string (hex). */
  sha256: string;
  generatedAt: string; // UTC ISO
}

/** Neutralized seal value used when computing the footer digest. */
export const SEAL_NEUTRAL = '0'.repeat(64);

// ---------------------------------------------------------------------------
// sidecar readers (tolerate absence gracefully)
// ---------------------------------------------------------------------------

interface DisputeSidecarEntry {
  disputeId?: unknown;
  delegationId?: unknown;
  amountPaise?: unknown;
  reason?: unknown;
  openedAt?: unknown;
}

interface ArtifactSidecarEntry {
  artifact?: unknown;
  sig?: unknown;
}

/** Read <dataDir>/disputes.json; [] when missing or malformed. */
export function readDisputesSidecar(dataDir: string): DisputeSidecarEntry[] {
  const path = join(dataDir, 'disputes.json');
  if (!existsSync(path)) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return Array.isArray(parsed) ? (parsed as DisputeSidecarEntry[]) : [];
  } catch {
    return []; // a malformed sidecar must never break pack generation
  }
}

/** Read <dataDir>/artifacts.json; {} when missing or malformed. */
export function readArtifactsSidecar(
  dataDir: string,
): Record<string, ArtifactSidecarEntry> {
  const path = join(dataDir, 'artifacts.json');
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, ArtifactSidecarEntry>)
      : {};
  } catch {
    return {};
  }
}

function parsePaiseField(v: unknown): bigint | null {
  if (v === undefined || v === null) return null;
  try {
    const b = BigInt(String(v));
    return b >= 0n ? b : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// span hashing (mirrors ledger.ts rowToHashable + the §2.2 sha256 rule)
// ---------------------------------------------------------------------------

interface HashableRow {
  seq: number;
  ts: string;
  type: string;
  artifactId?: string;
  orderId?: string;
  amountPaise?: bigint;
  verdict?: string;
  reason?: string;
}

function rowToHashable(row: HashableRow): Record<string, string | number> {
  const h: Record<string, string | number> = {
    seq: row.seq,
    ts: row.ts,
    type: row.type,
  };
  if (row.artifactId !== undefined) h.artifactId = row.artifactId;
  if (row.orderId !== undefined) h.orderId = row.orderId;
  if (row.amountPaise !== undefined) h.amountPaise = row.amountPaise.toString();
  if (row.verdict !== undefined) h.verdict = row.verdict;
  if (row.reason !== undefined) h.reason = row.reason;
  return h;
}

/**
 * Re-derive a row's selfHash: sha256(prevHash || canonical(wire row)).
 * Mirrors ledger.ts exactly — an independent recomputation for Exhibit E.
 */
export function recomputeSelfHash(row: LedgerRow): string {
  return createHash('sha256')
    .update(row.prevHash + canonicalize(rowToHashable(row)), 'utf8')
    .digest('hex');
}

// ---------------------------------------------------------------------------
// attempt-reason parsing (Exhibit D category data)
// ---------------------------------------------------------------------------

/**
 * Category carried on an ATTEMPT_ALLOWED row's reason field. Tolerated shapes:
 *   '{"categories":["coffee"],"skus":["KC-COF-CHIK-250"],"qty":1}'  (compact JSON —
 *    the shape S2's /checkout is asked to write, per the §5.1 sidecar pattern)
 *   'coffee'                                                       (bare category)
 *   anything else (incl. gate-reason codes like CAP_EXCEEDED_PER_TXN on BLOCKED
 *   rows) -> null (not a category)
 */
export function parseAttemptCategory(reason: string | undefined): string | null {
  if (!reason) return null;
  const trimmed = reason.trim();
  if (trimmed.startsWith('{')) {
    try {
      const j = JSON.parse(trimmed) as Record<string, unknown>;
      const cats = j['categories'];
      if (Array.isArray(cats)) {
        const first = cats[0];
        if (typeof first === 'string') return first;
      }
      if (typeof j['category'] === 'string') return j['category'];
      return null;
    } catch {
      return null;
    }
  }
  if (/^[a-z][a-z0-9-]*$/.test(trimmed)) return trimmed; // bare category token
  return null;
}

// ---------------------------------------------------------------------------
// scope recovery: artifacts sidecar > issued-row reason fallback > honest absence
// ---------------------------------------------------------------------------

interface RecoveredScope {
  categories: string[];
  maxPerTxnPaise: bigint;
  maxAggregatePaise: bigint;
  expiresAt: string;
  issuedAt: string;
}

function recoverScopeFromArtifactWire(wire: DelegationArtifactWire): RecoveredScope {
  const a = artifactFromWire(wire);
  return {
    categories: [...a.scope.categories],
    maxPerTxnPaise: a.scope.maxPerTxnPaise,
    maxAggregatePaise: a.scope.maxAggregatePaise,
    expiresAt: a.scope.expiresAt,
    issuedAt: a.issuedAt,
  };
}

function isArtifactWireShape(v: unknown): v is DelegationArtifactWire {
  if (v === null || typeof v !== 'object') return false;
  const w = v as Record<string, unknown>;
  const s = w['scope'];
  return (
    typeof w['artifactId'] === 'string' &&
    s !== null &&
    typeof s === 'object' &&
    Array.isArray((s as Record<string, unknown>)['categories'])
  );
}

/**
 * Fallback: derive a scope display from the DELEGATION_ISSUED row's reason
 * field when it carries compact JSON ({"scope":{...}} or a bare scope object).
 */
function recoverScopeFromIssuedReason(reason: string | undefined): RecoveredScope | null {
  if (!reason) return null;
  const trimmed = reason.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const j = JSON.parse(trimmed) as Record<string, unknown>;
    const s = (j['scope'] ?? j) as Record<string, unknown>;
    const categories = Array.isArray(s['categories'])
      ? s['categories'].filter((c): c is string => typeof c === 'string')
      : [];
    const perTxn = parsePaiseField(s['maxPerTxnPaise']);
    const agg = parsePaiseField(s['maxAggregatePaise']);
    if (categories.length === 0 || perTxn === null || agg === null) return null;
    return {
      categories,
      maxPerTxnPaise: perTxn,
      maxAggregatePaise: agg,
      expiresAt: typeof s['expiresAt'] === 'string' ? s['expiresAt'] : '',
      issuedAt: typeof j['issuedAt'] === 'string' ? j['issuedAt'] : '',
    };
  } catch {
    return null;
  }
}

/** Format for display only if the string parses as a date; else show raw. */
function safeIst(iso: string): string {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso : istTimestamp(iso);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

export function generateEvidencePack(
  db: DatabaseSync,
  delegationId: string,
  disputeId: string | null,
  opts?: GenerateEvidenceOptions,
): EvidencePack {
  const generatedAt = opts?.now ?? new Date().toISOString();
  const dataDir = opts?.dataDir ?? 'data';

  // ---- ledger span (delegationId == artifactId on every row) ----
  const allRows = readLedger(db);
  const span = allRows.filter((r) => r.artifactId === delegationId);
  const issued = span.find((r) => r.type === 'DELEGATION_ISSUED');
  const attempts = span.filter(
    (r) => r.type === 'ATTEMPT_ALLOWED' || r.type === 'ATTEMPT_BLOCKED',
  );
  const captures = span.filter((r) => r.type === 'PAYMENT_CAPTURED');
  const disputeRow = span.find((r) => r.type === 'DISPUTE_OPENED');

  // ---- dispute metadata: sidecar first (contract §5.1), ledger row fallback ----
  const disputes = readDisputesSidecar(dataDir);
  const disputeEntry =
    disputes.find(
      (d) => disputeId !== null && d.disputeId === disputeId,
    ) ?? disputes.find((d) => d.delegationId === delegationId);
  const disputeIdFinal =
    disputeId ??
    (typeof disputeEntry?.disputeId === 'string' ? disputeEntry.disputeId : null);
  const disputeAmountPaise =
    (disputeEntry ? parsePaiseField(disputeEntry.amountPaise) : null) ??
    disputeRow?.amountPaise ??
    null;
  const disputeReason =
    (typeof disputeEntry?.reason === 'string' ? disputeEntry.reason : null) ??
    disputeRow?.reason ??
    null;
  const disputeOpenedAtIso =
    (typeof disputeEntry?.openedAt === 'string' ? disputeEntry.openedAt : null) ??
    disputeRow?.ts ??
    null;

  // ---- scope: artifacts sidecar > issued-row reason > honest absence ----
  const artifacts = readArtifactsSidecar(dataDir);
  const sidecarEntry = artifacts[delegationId];
  let scope: RecoveredScope | null = null;
  let artifactSourceNote = 'no artifact sidecar and no recoverable scope in the issuance row';
  if (sidecarEntry !== undefined && isArtifactWireShape(sidecarEntry.artifact)) {
    try {
      scope = recoverScopeFromArtifactWire(sidecarEntry.artifact);
      artifactSourceNote =
        'signed artifact JSON stored at issuance (data/artifacts.json sidecar)';
    } catch {
      scope = null;
    }
  }
  if (scope === null) {
    const fallback = recoverScopeFromIssuedReason(issued?.reason);
    if (fallback) {
      scope = fallback;
      artifactSourceNote =
        'reconstructed from the DELEGATION_ISSUED ledger row reason field (artifact sidecar absent) — the authoritative artifact JSON was not retained';
    }
  }

  // ---- merchant / agent / principal from the sidecar artifact ----
  const wire = isArtifactWireShape(sidecarEntry?.artifact) ? sidecarEntry.artifact : null;
  const merchantId = wire?.merchantId ?? 'unknown (artifact details unavailable)';
  const agentId = wire?.agentId ?? merchantId;
  const principal = wire?.principal ?? merchantId;

  // ---- Exhibit D computation (from data, never asserted) ----
  const capturedTotal = aggregateSpent(db, delegationId);
  const diffLines: DiffLine[] = attempts.map((r) => {
    const category = parseAttemptCategory(r.reason);
    const amount = r.amountPaise ?? null;
    let inScopeCategories: boolean | null = null;
    let withinPerTxnCap: boolean | null = null;
    const notes: string[] = [];
    if (r.type === 'ATTEMPT_BLOCKED') {
      notes.push(`Refused by the gate: ${r.reason ?? 'unspecified reason'}. No money moved.`);
    } else {
      if (scope !== null && category !== null) {
        inScopeCategories = scope.categories.includes(category);
        notes.push(
          inScopeCategories
            ? `Category "${category}" is within the authorized set.`
            : `Category "${category}" is OUTSIDE the authorized set.`,
        );
      } else {
        notes.push(
          scope === null
            ? 'Artifact details unavailable; category scope cannot be recomputed for this line.'
            : 'Category not recorded on the attempt row; category scope cannot be recomputed for this line.',
        );
      }
      if (scope !== null && amount !== null) {
        withinPerTxnCap = amount <= scope.maxPerTxnPaise;
        notes.push(
          withinPerTxnCap
            ? `Amount ${fmtPaise(amount)} is within the ${fmtPaise(scope.maxPerTxnPaise)} per-transaction cap.`
            : `Amount ${fmtPaise(amount)} EXCEEDS the ${fmtPaise(scope.maxPerTxnPaise)} per-transaction cap.`,
        );
      }
    }
    return {
      seq: r.seq,
      ts: istTimestamp(r.ts),
      tsUtc: utcTimestamp(r.ts),
      amountPaise: amount,
      category,
      inScopeCategories,
      withinPerTxnCap,
      note: notes.join(' '),
    };
  });

  const attemptedTxnCount = attempts.filter(
    (r) => r.type === 'ATTEMPT_ALLOWED' && r.amountPaise !== undefined,
  ).length;
  const allWithinScope = diffLines.every(
    (l) =>
      (l.inScopeCategories === null || l.inScopeCategories === true) &&
      (l.withinPerTxnCap === null || l.withinPerTxnCap === true),
  );
  const aggregateWithinCap: boolean | null =
    scope === null ? null : capturedTotal <= scope.maxAggregatePaise;
  const verdictSentence = buildVerdictSentence({
    attemptedAny: attempts.length > 0,
    attemptedTxnCount,
    allWithinScope,
    aggregateSpentPaise: capturedTotal,
    aggregateCapPaise: scope?.maxAggregatePaise ?? null,
    aggregateWithinCap,
  });

  // ---- Exhibit E: chain of integrity ----
  const fullChain = verifyChain(allRows);
  let spanLinksValid = true;
  let spanFirstBreak: number | undefined;
  const bySeq = new Map(allRows.map((r) => [r.seq, r]));
  for (const r of span) {
    if (recomputeSelfHash(r) !== r.selfHash) {
      spanLinksValid = false;
      spanFirstBreak ??= r.seq;
      continue;
    }
    const pred = bySeq.get(r.seq - 1);
    const expectedPrev = pred !== undefined ? pred.selfHash : GENESIS_PREV_HASH;
    if (r.prevHash !== expectedPrev) {
      spanLinksValid = false;
      spanFirstBreak ??= r.seq;
    }
  }
  const seqValues = span.map((r) => r.seq);

  // ---- assemble template data ----
  const data: EvidencePackData = {
    disputeId: disputeIdFinal,
    disputeAmountPaise,
    disputeReason,
    disputeOpenedAt: disputeOpenedAtIso === null ? null : safeIst(disputeOpenedAtIso),
    delegationId,
    generatedAtIso: generatedAt,
    generatedAtIst: istTimestamp(generatedAt),
    generatedAtUtc: utcTimestamp(generatedAt),
    merchantId,
    agentId,
    principal,
    scope:
      scope === null
        ? null
        : {
            categories: scope.categories,
            maxPerTxnPaise: scope.maxPerTxnPaise,
            maxAggregatePaise: scope.maxAggregatePaise,
            expiresAt: safeIst(scope.expiresAt),
            issuedAt: safeIst(scope.issuedAt),
          },
    artifactSourceNote,
    attempts: attempts.map((r) => ({
      seq: r.seq,
      ts: istTimestamp(r.ts),
      tsUtc: utcTimestamp(r.ts),
      type: r.type,
      amountPaise: r.amountPaise ?? null,
      verdict: r.verdict ?? null,
      reason: r.reason ?? null,
      orderId: r.orderId ?? null,
      hash8: r.selfHash.slice(0, 8),
    })),
    captures: captures.map((r) => ({
      seq: r.seq,
      ts: istTimestamp(r.ts),
      tsUtc: utcTimestamp(r.ts),
      amountPaise: r.amountPaise ?? 0n,
      orderId: r.orderId ?? null,
      hash8: r.selfHash.slice(0, 8),
    })),
    capturedTotalPaise: capturedTotal,
    diff: {
      lines: diffLines,
      attemptedTxnCount,
      capturedTxnCount: captures.length,
      aggregateSpentPaise: capturedTotal,
      aggregateCapPaise: scope?.maxAggregatePaise ?? null,
      aggregateWithinCap,
      allWithinScope,
      verdictSentence,
    },
    chain: {
      valid: fullChain.valid,
      ...(fullChain.firstBreak !== undefined ? { firstBreak: fullChain.firstBreak } : {}),
      rowCount: span.length,
      ...(seqValues.length > 0
        ? { seqMin: Math.min(...seqValues), seqMax: Math.max(...seqValues) }
        : {}),
      fullChainRowCount: allRows.length,
      spanLinksValid,
      ...(spanFirstBreak !== undefined ? { spanFirstBreak } : {}),
      methodNote:
        'Every row\u2019s self-hash was independently recomputed as sha256(prevHash \u2016 canonical(wire row)), and each of this delegation\u2019s rows was checked against its true global predecessor in the full ledger.',
    },
    packSha256: SEAL_NEUTRAL,
  };

  // ---- render + digests ----
  // The returned sha256 covers the delivered bytes; the footer seal covers
  // the document with the seal field neutralized (see header comment).
  const neutralHtml = renderEvidencePack(data);
  const seal = sha256Html(neutralHtml);
  const html = renderEvidencePack({ ...data, packSha256: seal });
  return { html, sha256: sha256Html(html), generatedAt };
}

// ---------------------------------------------------------------------------
// verdict sentence (computed, not asserted)
// ---------------------------------------------------------------------------

function buildVerdictSentence(input: {
  attemptedAny: boolean;
  attemptedTxnCount: number;
  allWithinScope: boolean;
  aggregateSpentPaise: bigint;
  aggregateCapPaise: bigint | null;
  aggregateWithinCap: boolean | null;
}): string {
  const {
    attemptedAny,
    attemptedTxnCount,
    allWithinScope,
    aggregateSpentPaise,
    aggregateCapPaise,
    aggregateWithinCap,
  } = input;
  if (!attemptedAny) return 'No transactions were attempted under this delegation.';
  const parts: string[] = [];
  if (attemptedTxnCount === 0) {
    parts.push('All attempted transactions were refused by the gate; none proceeded to payment.');
  } else if (allWithinScope) {
    parts.push(
      `All ${attemptedTxnCount} attempted transaction${attemptedTxnCount === 1 ? ' was' : 's were'} within scope.`,
    );
  } else {
    parts.push(
      `${attemptedTxnCount} attempted transaction${attemptedTxnCount === 1 ? ' was not' : 's were NOT'} within scope.`,
    );
  }
  if (aggregateCapPaise !== null) {
    parts.push(
      `Aggregate spend ${fmtPaise(aggregateSpentPaise)} of ${fmtPaise(aggregateCapPaise)} cap.`,
    );
    if (aggregateWithinCap === false) parts.push('The aggregate cap was EXCEEDED.');
  } else {
    parts.push(`Aggregate spend ${fmtPaise(aggregateSpentPaise)}.`);
  }
  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// convenience for S2's route wiring (app.ts import point)
// ---------------------------------------------------------------------------

/**
 * Persist an EVIDENCE_GENERATED ledger row after rendering (the route's
 * choice — generation itself never mutates the ledger it just verified).
 */
export function appendEvidenceGenerated(
  db: DatabaseSync,
  delegationId: string,
  sha256: string,
): void {
  appendLedgerEvent(db, {
    type: 'EVIDENCE_GENERATED',
    artifactId: delegationId,
    reason: `evidence pack sha256:${sha256}`,
  });
}
