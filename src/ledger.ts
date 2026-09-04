// Pramaan — append-only hash-chained ledger (CONTRACTS.md §2)
// SQLite via node:sqlite DatabaseSync (zero external packages). The ledger is
// append-only: this module performs exactly one INSERT per event and never
// issues UPDATE/DELETE. Corruption is detected by verifyChain() recomputing
// the full hash chain.
//
// Money invariant: amountPaise is bigint in TS, TEXT in SQLite, string on the
// wire. Never a JS number.

import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { canonicalize } from './crypto.js';
import type { LedgerEventType, LedgerRow } from './types.js';

/** Genesis prevHash — 64 zeros (§2.2). */
export const GENESIS_PREV_HASH = '0'.repeat(64);

/**
 * Event to append. Mirrors the frozen LedgerRow minus seq/ts/prevHash/selfHash.
 * Optional fields are stored as SQL NULL and omitted from the hash input.
 */
export interface LedgerEvent {
  type: LedgerEventType;
  artifactId?: string;
  orderId?: string;
  amountPaise?: bigint;
  verdict?: 'ALLOW' | 'BLOCK' | 'RELEASE' | 'DENY';
  reason?: string;
}

/** Frozen DB schema (CONTRACTS.md §2 "DB schema (frozen)"). */
const LEDGER_SCHEMA = `
CREATE TABLE IF NOT EXISTS ledger (
  seq INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  type TEXT NOT NULL,
  artifactId TEXT,
  orderId TEXT,
  amountPaise TEXT,
  verdict TEXT,
  reason TEXT,
  prevHash TEXT NOT NULL,
  selfHash TEXT NOT NULL
);
`;

// Raw SQLite row shape (amountPaise still TEXT here).
interface RawRow {
  seq: number;
  ts: string;
  type: string;
  artifactId: string | null;
  orderId: string | null;
  amountPaise: string | null;
  verdict: string | null;
  reason: string | null;
  prevHash: string;
  selfHash: string;
}

const COLS = 'seq, ts, type, artifactId, orderId, amountPaise, verdict, reason, prevHash, selfHash';

// ---------------------------------------------------------------------------
// open / init
// ---------------------------------------------------------------------------

/**
 * Open (and initialize) the ledger DB. Path from env PRAMAAN_DB
 * (default "data/pramaan.db"); ":memory:" for tests. The data/ directory is
 * created on demand. `pathOverride` bypasses the env for callers/tests.
 */
export function openLedger(pathOverride?: string): DatabaseSync {
  const path = pathOverride ?? process.env.PRAMAAN_DB ?? 'data/pramaan.db';
  let db: DatabaseSync;
  if (path === ':memory:') {
    db = new DatabaseSync(':memory:');
  } else {
    const dir = dirname(path);
    if (dir && dir !== '.') mkdirSync(dir, { recursive: true });
    db = new DatabaseSync(path);
  }
  db.exec(LEDGER_SCHEMA);
  return db;
}

// ---------------------------------------------------------------------------
// §2.2 append / read
// ---------------------------------------------------------------------------

/**
 * Append an event; assigns seq, ts, and hash-chain fields; returns the stored
 * row. prevHash = previous row's selfHash, or 64 zeros for seq 1.
 * selfHash  = sha256(prevHash || canonical(row minus prevHash/selfHash)),
 * where the canonical row uses the WIRE form (amountPaise as string).
 */
export function appendLedgerEvent(db: DatabaseSync, event: LedgerEvent): LedgerRow {
  validateEvent(event);

  const last = db
    .prepare(`SELECT seq, selfHash FROM ledger ORDER BY seq DESC LIMIT 1`)
    .get() as unknown as { seq: number; selfHash: string } | undefined;
  const seq = (last ? Number(last.seq) : 0) + 1;
  const prevHash = last ? last.selfHash : GENESIS_PREV_HASH;

  const ts = new Date().toISOString();
  const amountStr = event.amountPaise === undefined ? null : event.amountPaise.toString();

  // Hash over the canonical WIRE form of the row (minus prevHash/selfHash),
  // with absent optional fields omitted deterministically.
  const hashable = rowToHashable({
    seq,
    ts,
    type: event.type,
    artifactId: event.artifactId,
    orderId: event.orderId,
    amountPaise: event.amountPaise,
    verdict: event.verdict,
    reason: event.reason,
  });
  const selfHash = sha256Hex(prevHash + canonicalize(hashable));

  db.prepare(
    `INSERT INTO ledger (${COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    seq,
    ts,
    event.type,
    event.artifactId ?? null,
    event.orderId ?? null,
    amountStr,
    event.verdict ?? null,
    event.reason ?? null,
    prevHash,
    selfHash,
  );

  const stored = db
    .prepare(`SELECT ${COLS} FROM ledger WHERE seq = ?`)
    .get(seq) as unknown as RawRow;
  return rowToRow(stored);
}

/** Read the full ledger in seq order; amountPaise parsed back to bigint. */
export function readLedger(db: DatabaseSync): LedgerRow[] {
  const raw = db
    .prepare(`SELECT ${COLS} FROM ledger ORDER BY seq ASC`)
    .all() as unknown as RawRow[];
  return raw.map(rowToRow);
}

/** LedgerRow → JSON-safe wire form (paise as string, absent fields omitted). */
export function serializeRow(row: LedgerRow): Record<string, unknown> {
  const out: Record<string, unknown> = {
    seq: row.seq,
    ts: row.ts,
    type: row.type,
  };
  if (row.artifactId !== undefined) out.artifactId = row.artifactId;
  if (row.orderId !== undefined) out.orderId = row.orderId;
  if (row.amountPaise !== undefined) out.amountPaise = row.amountPaise.toString();
  if (row.verdict !== undefined) out.verdict = row.verdict;
  if (row.reason !== undefined) out.reason = row.reason;
  out.prevHash = row.prevHash;
  out.selfHash = row.selfHash;
  return out;
}

// ---------------------------------------------------------------------------
// §2.3 verifyChain
// ---------------------------------------------------------------------------

export interface ChainVerification {
  valid: boolean;
  /** seq of the first row whose prevHash link or recomputed selfHash mismatches. */
  firstBreak?: number;
}

/**
 * Recompute every row's selfHash and every prevHash link from genesis.
 * Returns { valid: false, firstBreak: seq } at the first corrupt row.
 */
export function verifyChain(rows: LedgerRow[]): ChainVerification {
  let expectedPrev = GENESIS_PREV_HASH;
  for (const row of rows) {
    if (row.prevHash !== expectedPrev) {
      return { valid: false, firstBreak: row.seq };
    }
    const recomputed = sha256Hex(row.prevHash + canonicalize(rowToHashable(row)));
    if (recomputed !== row.selfHash) {
      return { valid: false, firstBreak: row.seq };
    }
    expectedPrev = row.selfHash;
  }
  return { valid: true };
}

// ---------------------------------------------------------------------------
// §2.4 aggregateSpent
// ---------------------------------------------------------------------------

/**
 * Sum of amountPaise over PAYMENT_CAPTURED rows for the artifact, as bigint.
 * Summed in JS with BigInt (not SQL SUM) so arbitrarily large totals stay exact.
 */
export function aggregateSpent(db: DatabaseSync, artifactId: string): bigint {
  const rows = db
    .prepare(
      `SELECT amountPaise FROM ledger WHERE artifactId = ? AND type = 'PAYMENT_CAPTURED'`,
    )
    .all(artifactId) as unknown as { amountPaise: string | null }[];
  let total = 0n;
  for (const r of rows) {
    if (r.amountPaise !== null) total += BigInt(r.amountPaise);
  }
  return total;
}

// ---------------------------------------------------------------------------
// internal helpers
// ---------------------------------------------------------------------------

function validateEvent(event: LedgerEvent): void {
  if (event.amountPaise !== undefined) {
    if (typeof event.amountPaise !== 'bigint' || event.amountPaise < 0n) {
      throw new Error('appendLedgerEvent: amountPaise must be a non-negative bigint (integer paise)');
    }
  }
  if (event.artifactId !== undefined && event.artifactId.length === 0) {
    throw new Error('appendLedgerEvent: artifactId must be a non-empty string when present');
  }
}

function rowToRow(r: RawRow): LedgerRow {
  const row: LedgerRow = {
    seq: Number(r.seq),
    ts: r.ts,
    type: r.type as LedgerEventType,
    prevHash: r.prevHash,
    selfHash: r.selfHash,
  };
  if (r.artifactId !== null) row.artifactId = r.artifactId;
  if (r.orderId !== null) row.orderId = r.orderId;
  if (r.amountPaise !== null) row.amountPaise = BigInt(r.amountPaise);
  if (r.verdict !== null) row.verdict = r.verdict as NonNullable<LedgerRow['verdict']>;
  if (r.reason !== null) row.reason = r.reason;
  return row;
}

/**
 * The canonical row-for-hashing (§2.2): the row minus prevHash/selfHash, with
 * bigint fields as strings (WIRE form). Absent optional fields are omitted so
 * the hashed object is fully deterministic.
 */
/** Input shape for hashing: the row minus prevHash/selfHash, optionals explicitly undefined-able. */
type HashableRow = {
  seq: number;
  ts: string;
  type: LedgerEventType;
  artifactId?: string | undefined;
  orderId?: string | undefined;
  amountPaise?: bigint | undefined;
  verdict?: LedgerRow['verdict'] | undefined;
  reason?: string | undefined;
};

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

function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}
