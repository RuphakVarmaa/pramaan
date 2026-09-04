// Pramaan — tests for the append-only hash-chained ledger (CONTRACTS.md §2)
// Tamper detection is proven via direct SQL UPDATE inside the DB itself.

import { afterEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
  aggregateSpent,
  appendLedgerEvent,
  GENESIS_PREV_HASH,
  openLedger,
  readLedger,
  serializeRow,
  verifyChain,
} from '../src/ledger.js';

let db: DatabaseSync | undefined;

function freshDb(): DatabaseSync {
  db = openLedger(':memory:');
  return db;
}

afterEach(() => {
  db?.close();
  db = undefined;
});

const ART = 'dl_' + 'a'.repeat(24);

function appendCapture(d: DatabaseSync, artifactId: string, paise: bigint) {
  return appendLedgerEvent(d, { type: 'PAYMENT_CAPTURED', artifactId, amountPaise: paise });
}

describe('appendLedgerEvent / readLedger', () => {
  it('seq 1 chains to 64 zeros; each row chains to the previous selfHash', () => {
    const d = freshDb();
    appendCapture(d, ART, 100n);
    appendCapture(d, ART, 250n);
    const rows = readLedger(d);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.seq).toBe(1);
    expect(rows[0]!.prevHash).toBe(GENESIS_PREV_HASH);
    expect(GENESIS_PREV_HASH).toBe('0'.repeat(64));
    expect(rows[1]!.prevHash).toBe(rows[0]!.selfHash);
    expect(rows[0]!.selfHash).not.toBe(rows[1]!.selfHash);
    expect(rows[1]!.selfHash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0]!.amountPaise).toBe(100n);
    expect(rows[1]!.amountPaise).toBe(250n);
  });

  it('stores amountPaise as TEXT and round-trips as bigint (beyond Number.MAX_SAFE_INTEGER)', () => {
    const d = freshDb();
    appendCapture(d, ART, 123456789012345678n);
    const raw = d.prepare('SELECT amountPaise FROM ledger').get() as { amountPaise: unknown };
    expect(typeof raw.amountPaise).toBe('string');
    expect(raw.amountPaise).toBe('123456789012345678');
    expect(readLedger(d)[0]!.amountPaise).toBe(123456789012345678n);
  });

  it('optional fields are stored as NULL and omitted from the hash input', () => {
    const d = freshDb();
    appendLedgerEvent(d, { type: 'DELEGATION_ISSUED', artifactId: ART, amountPaise: 0n });
    appendLedgerEvent(d, { type: 'ATTEMPT_ALLOWED', artifactId: ART, orderId: 'order_1', amountPaise: 500_00n, verdict: 'ALLOW' });
    appendLedgerEvent(d, { type: 'ATTEMPT_BLOCKED', artifactId: ART, amountPaise: 900_00n, verdict: 'BLOCK', reason: 'CAP_EXCEEDED_PER_TXN' });
    const rows = readLedger(d);
    expect(rows[0]!.orderId).toBeUndefined();
    expect(rows[1]!.verdict).toBe('ALLOW');
    expect(rows[2]!.reason).toBe('CAP_EXCEEDED_PER_TXN');
    expect(verifyChain(rows)).toEqual({ valid: true });
  });

  it('rejects negative amounts and empty artifactIds', () => {
    const d = freshDb();
    expect(() => appendCapture(d, ART, -1n)).toThrow();
    expect(() => appendLedgerEvent(d, { type: 'PAYMENT_CAPTURED', artifactId: '', amountPaise: 1n })).toThrow();
  });

  it('serializeRow puts paise on the wire as a string', () => {
    const d = freshDb();
    appendCapture(d, ART, 123_456_789_012_345n);
    const s = serializeRow(readLedger(d)[0]!);
    expect(s.amountPaise).toBe('123456789012345');
    expect(typeof s.amountPaise).toBe('string');
    expect(s.selfHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('verifyChain', () => {
  it('append 3 rows, verifyChain → { valid: true }', () => {
    const d = freshDb();
    appendLedgerEvent(d, { type: 'DELEGATION_ISSUED', artifactId: ART, amountPaise: 0n });
    appendCapture(d, ART, 100n);
    appendLedgerEvent(d, { type: 'DISPUTE_OPENED', artifactId: ART, amountPaise: 100n });
    const rows = readLedger(d);
    expect(rows).toHaveLength(3);
    expect(verifyChain(rows)).toEqual({ valid: true });
  });

  it('TAMPER: direct SQL UPDATE of one row amountPaise is caught, firstBreak points at that seq', () => {
    const d = freshDb();
    appendLedgerEvent(d, { type: 'DELEGATION_ISSUED', artifactId: ART, amountPaise: 0n });
    appendCapture(d, ART, 100n);
    appendLedgerEvent(d, { type: 'DISPUTE_OPENED', artifactId: ART, amountPaise: 100n });
    expect(verifyChain(readLedger(d))).toEqual({ valid: true });

    // CORRUPTION: rewrite history inside SQLite itself — the ledger API never allows this.
    d.prepare("UPDATE ledger SET amountPaise = '999999' WHERE seq = 2").run();

    const rows = readLedger(d);
    expect(rows[1]!.amountPaise).toBe(999999n); // the DB really was tampered
    const result = verifyChain(rows);
    expect(result.valid).toBe(false);
    expect(result.firstBreak).toBe(2);
  });

  it('TAMPER: forging a consistent-looking row still fails (selfHash must match content)', () => {
    const d = freshDb();
    appendCapture(d, ART, 100n);
    appendCapture(d, ART, 200n);
    appendCapture(d, ART, 300n);
    // Attacker rewrites row 3's amount AND "fixes" prevHash to row 2's hash —
    // still caught, because selfHash no longer matches the canonical content.
    const rows = readLedger(d);
    const prev = rows[1]!.selfHash;
    d.prepare("UPDATE ledger SET amountPaise = '1', prevHash = ? WHERE seq = 3").run(prev);
    const result = verifyChain(readLedger(d));
    expect(result.valid).toBe(false);
    expect(result.firstBreak).toBe(3);
  });

  it('TAMPER: deleting a middle row breaks the chain link at the survivor', () => {
    const d = freshDb();
    appendCapture(d, ART, 100n);
    appendCapture(d, ART, 200n);
    appendCapture(d, ART, 300n);
    d.prepare('DELETE FROM ledger WHERE seq = 2').run();
    const result = verifyChain(readLedger(d));
    expect(result.valid).toBe(false);
    expect(result.firstBreak).toBe(3); // row 3 now links to a vanished hash
  });

  it('empty ledger verifies as valid', () => {
    expect(verifyChain([])).toEqual({ valid: true });
  });
});

describe('aggregateSpent', () => {
  it('sums only PAYMENT_CAPTURED rows for the artifact, as bigint paise', () => {
    const d = freshDb();
    const artA = 'dl_' + 'a'.repeat(24);
    const artB = 'dl_' + 'b'.repeat(24);
    appendLedgerEvent(d, { type: 'DELEGATION_ISSUED', artifactId: artA, amountPaise: 0n });
    appendLedgerEvent(d, { type: 'ATTEMPT_ALLOWED', artifactId: artA, amountPaise: 500_00n });
    appendCapture(d, artA, 500_00n);
    appendLedgerEvent(d, { type: 'DISPUTE_OPENED', artifactId: artA, amountPaise: 500_00n });
    appendCapture(d, artA, 250_00n);
    appendCapture(d, artB, 999_99n); // different artifact — must not count

    const total = aggregateSpent(d, artA);
    expect(total).toBe(750_00n);
    expect(typeof total).toBe('bigint');
    expect(aggregateSpent(d, artB)).toBe(999_99n);
    expect(aggregateSpent(d, 'dl_unknown')).toBe(0n);
  });

  it('sums exactly beyond Number.MAX_SAFE_INTEGER', () => {
    const d = freshDb();
    appendCapture(d, ART, 999_999_999_999_999n);
    appendCapture(d, ART, 999_999_999_999_999n);
    expect(aggregateSpent(d, ART)).toBe(1_999_999_999_999_998n);
  });
});

describe('file-backed DB (PRAMAAN_DB path handling)', () => {
  it('creates the data/ directory on demand and persists rows across reopens', () => {
    const path = 'data/test-ledger-tmp.db';
    db = undefined;
    const d1 = openLedger(path);
    appendCapture(d1, ART, 42n);
    d1.close();
    const d2 = openLedger(path);
    const rows = readLedger(d2);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.amountPaise).toBe(42n);
    expect(verifyChain(rows)).toEqual({ valid: true });
    d2.close();
    rmSync(path, { force: true });
    try { rmSync('data', { recursive: true }); } catch { /* non-empty is fine */ }
  });
});
