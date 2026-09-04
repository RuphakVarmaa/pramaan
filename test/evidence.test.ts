// Pramaan — evidence pack tests (S3 EVIDENCE, CONTRACTS.md §5).
//
// Scenario: a real ledger built with S1's appendLedgerEvent —
//   issue -> allowed -> captured -> dispute opened
// then generateEvidencePack and assert the dossier reads like a forensic
// report: cover block, Exhibits A–E, computed diff numbers, chain proof,
// sha256 (recomputed over the html string), IST timestamps, latency guard.
//
// Sidecar matrices: artifacts.json present (authoritative scope) vs absent
// (issued-reason fallback vs honest unavailability); disputes.json absent.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { appendLedgerEvent, openLedger, readLedger } from '../src/ledger.js';
import { issueDelegation } from '../src/artifact.js';
import { canonicalize, generateEd25519KeyPair } from '../src/crypto.js';
import { artifactToWire } from '../src/types.js';
import {
  generateEvidencePack,
  parseAttemptCategory,
  recomputeSelfHash,
} from '../src/evidence.js';

const DATA_DIR = join(tmpdir(), `pramaan-evidence-${process.pid}-${Date.now()}`);

let openDb: DatabaseSync | undefined;
afterEach(() => {
  openDb?.close();
  openDb = undefined;
  rmSync(DATA_DIR, { recursive: true, force: true });
});

interface ScenarioOpts {
  artifactSidecar?: boolean;
  disputeSidecar?: boolean;
  category?: string;
}

function freshScenario(opts: ScenarioOpts = {}) {
  mkdirSync(DATA_DIR, { recursive: true });
  const db = openLedger(':memory:');
  openDb = db;

  const kp = generateEd25519KeyPair();
  const category = opts.category ?? 'coffee';
  const { artifact, sig } = issueDelegation(
    {
      merchantId: 'kadai-and-co',
      agentId: 'agent-atlas-01',
      principal: 'ruphak@example.com',
      scope: {
        categories: ['coffee', 'pantry'],
        maxPerTxnPaise: 250000n, // ₹2,500.00
        maxAggregatePaise: 500000n, // ₹5,000.00
        expiresAt: '2026-12-31T23:59:59.000Z',
      },
    },
    { publicKey: kp.publicKey, privateKey: kp.privateKey },
  );

  // DELEGATION_ISSUED — reason carries the structured 'issued' payload
  // (the documented fallback when the artifact sidecar is absent).
  appendLedgerEvent(db, {
    type: 'DELEGATION_ISSUED',
    artifactId: artifact.artifactId,
    verdict: 'ALLOW',
    reason: JSON.stringify({
      scope: {
        categories: [...artifact.scope.categories],
        maxPerTxnPaise: artifact.scope.maxPerTxnPaise.toString(),
        maxAggregatePaise: artifact.scope.maxAggregatePaise.toString(),
        expiresAt: artifact.scope.expiresAt,
      },
      issuedAt: artifact.issuedAt,
    }),
  });

  // ATTEMPT_ALLOWED — ₹1,250.00 with structured category reason.
  appendLedgerEvent(db, {
    type: 'ATTEMPT_ALLOWED',
    artifactId: artifact.artifactId,
    orderId: 'order_test_0001',
    amountPaise: 125000n,
    verdict: 'ALLOW',
    reason: JSON.stringify({ categories: [category], skus: ['KC-COF-CHIK-250'], qty: 2 }),
  });

  // PAYMENT_CAPTURED — ₹1,250.00 actually moved.
  appendLedgerEvent(db, {
    type: 'PAYMENT_CAPTURED',
    artifactId: artifact.artifactId,
    orderId: 'order_test_0001',
    amountPaise: 125000n,
    verdict: 'ALLOW',
    reason: 'capture',
  });

  // DISPUTE_OPENED — chargeback.
  appendLedgerEvent(db, {
    type: 'DISPUTE_OPENED',
    artifactId: artifact.artifactId,
    amountPaise: 125000n,
    verdict: 'DENY',
    reason: 'chargeback_reason_code_41',
  });

  // Sidecars.
  writeFileSync(
    join(DATA_DIR, 'disputes.json'),
    JSON.stringify(
      opts.disputeSidecar
        ? [
            {
              disputeId: 'dp_7f3a91',
              delegationId: artifact.artifactId,
              amountPaise: '125000',
              reason: 'cardholder disputes coffee purchase as unauthorized',
              openedAt: '2026-09-04T09:15:00.000Z',
            },
          ]
        : [],
    ),
  );
  writeFileSync(
    join(DATA_DIR, 'artifacts.json'),
    JSON.stringify(
      opts.artifactSidecar
        ? { [artifact.artifactId]: { artifact: artifactToWire(artifact), sig } }
        : {},
    ),
  );

  return { db, artifact, sig };
}

function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

describe('generateEvidencePack — full purchase -> forensic dossier', () => {
  it('renders all 5 exhibits with computed diff, chain proof, sha256, IST timestamps', () => {
    const { db, artifact } = freshScenario({ artifactSidecar: true, disputeSidecar: true });

    const t0 = performance.now();
    const pack = generateEvidencePack(db, artifact.artifactId, 'dp_7f3a91', {
      now: '2026-09-04T10:00:00.000Z',
      dataDir: DATA_DIR,
    });
    const elapsed = performance.now() - t0;
    const html = pack.html;

    // --- cover block ---
    expect(html).toContain('dp_7f3a91');
    expect(html).toContain(artifact.artifactId);
    expect(html).toContain('kadai-and-co');
    expect(html).toContain('agent-atlas-01');
    expect(html).toContain('ruphak@example.com');
    expect(html).toContain('Delegation Evidence Pack');

    // --- masthead + microcopy ---
    expect(html).toContain('Pramaan');
    expect(html).toContain('Exhibits A');
    expect(html).toContain('Confidential');
    expect(html).toContain('Dispute Representment');

    // --- all five exhibit headings ---
    expect(html).toContain('Exhibit A');
    expect(html).toContain('What was authorized');
    expect(html).toContain('Exhibit B');
    expect(html).toContain('What the agent attempted');
    expect(html).toContain('Exhibit C');
    expect(html).toContain('What actually happened');
    expect(html).toContain('Exhibit D');
    expect(html).toContain('Scope vs. actual');
    expect(html).toContain('Exhibit E');
    expect(html).toContain('Chain of integrity');

    // --- Exhibit A scope table (sidecar-authoritative) ---
    expect(html).toContain('coffee');
    expect(html).toContain('pantry');
    expect(html).toContain('₹2,500.00'); // per-txn cap
    expect(html).toContain('₹5,000.00'); // aggregate cap
    expect(html).toContain('data/artifacts.json sidecar');

    // --- computed verdict sentence (Exhibit D) ---
    expect(html).toContain('All 1 attempted transaction was within scope.');
    expect(html).toContain('Aggregate spend ₹1,250.00 of ₹5,000.00 cap.');

    // --- Exhibit B/C money display ---
    expect(html).toContain('₹1,250.00');
    expect(html).toContain('order_test_0001');

    // --- Exhibit E chain proof ---
    expect(html).toContain('VALID');
    expect(html).toContain('no breaks');

    // --- sha256: returned digest must equal a recompute over the html ---
    expect(pack.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(pack.sha256).toBe(sha256(pack.html));
    // footer carries the integrity seal (64-hex)
    expect(html).toContain('Integrity seal');
    expect(html).toMatch(/Integrity seal[\s\S]{0,160}?[0-9a-f]{64}/);

    // --- IST timestamps + UTC details lines ---
    expect(html).toMatch(/IST|India Standard Time|\+05:30/);
    expect(html).toMatch(/\d{2}:\d{2}:\d{2} UTC/);

    // --- latency guard: string assembly must be fast ---
    expect(elapsed).toBeLessThan(1000);
  });

  it('computes Exhibit D honestly when the category is out of scope', () => {
    const { db, artifact } = freshScenario({
      artifactSidecar: true,
      disputeSidecar: false,
      category: 'electronics',
    });
    const pack = generateEvidencePack(db, artifact.artifactId, null, {
      now: '2026-09-04T10:00:00.000Z',
      dataDir: DATA_DIR,
    });
    expect(pack.html).toContain('OUTSIDE the authorized set');
    expect(pack.html).toContain('electronics');
  });

  it('falls back to the issued-row reason when the sidecar is absent; stays honest when neither exists', () => {
    // fallback: structured issued reason present, sidecar absent
    const { db, artifact } = freshScenario({ artifactSidecar: false });
    const pack = generateEvidencePack(db, artifact.artifactId, null, {
      now: '2026-09-04T10:00:00.000Z',
      dataDir: DATA_DIR,
    });
    expect(pack.html).toContain('reconstructed from the DELEGATION_ISSUED');
    expect(pack.html).toContain('₹5,000.00'); // aggregate cap recovered from reason
    db.close();

    // honest absence: no sidecar, no recoverable reason
    const db2 = openLedger(':memory:');
    openDb = db2;
    appendLedgerEvent(db2, {
      type: 'DELEGATION_ISSUED',
      artifactId: 'dl_noscope',
      verdict: 'ALLOW',
    });
    appendLedgerEvent(db2, {
      type: 'ATTEMPT_ALLOWED',
      artifactId: 'dl_noscope',
      orderId: 'order_x',
      amountPaise: 100n,
      verdict: 'ALLOW',
    });
    const pack2 = generateEvidencePack(db2, 'dl_noscope', null, {
      now: '2026-09-04T10:00:00.000Z',
      dataDir: DATA_DIR,
    });
    expect(pack2.html).toContain('artifact details unavailable');
    expect(pack2.html).toContain('cannot be recomputed');
  });

  it('detects a broken chain in Exhibit E (retroactive edit)', () => {
    const { db, artifact } = freshScenario({ artifactSidecar: true });
    db.exec(`UPDATE ledger SET amountPaise = '999999' WHERE type = 'PAYMENT_CAPTURED'`);
    const pack = generateEvidencePack(db, artifact.artifactId, null, {
      now: '2026-09-04T10:00:00.000Z',
      dataDir: DATA_DIR,
    });
    expect(pack.html).toContain('BROKEN');
    expect(pack.html).toMatch(/first mismatch at ledger row seq \d+/);
  });

  it('recomputes self-hashes exactly like the ledger (Exhibit E independence)', () => {
    const { db } = freshScenario({ artifactSidecar: true });
    for (const row of readLedger(db)) {
      expect(recomputeSelfHash(row)).toBe(row.selfHash);
    }
  });

  it('formats paise at the render boundary with en-IN grouping', async () => {
    const { fmtPaise } = await import('../src/templates/evidence.js');
    expect(fmtPaise(125000n)).toBe('₹1,250.00');
    expect(fmtPaise(500000n)).toBe('₹5,000.00');
    expect(fmtPaise(123456789n)).toBe('₹12,34,567.89'); // en-IN lakh grouping
    expect(fmtPaise(5n)).toBe('₹0.05');
    expect(fmtPaise(0n)).toBe('₹0.00');
  });

  it('parses attempt reasons tolerantly (JSON, bare category, gate codes)', () => {
    expect(parseAttemptCategory('{"categories":["coffee"],"skus":["X"],"qty":2}')).toBe('coffee');
    expect(parseAttemptCategory('pantry')).toBe('pantry');
    expect(parseAttemptCategory('CAP_EXCEEDED_PER_TXN')).toBeNull(); // gate code, not a category
    expect(parseAttemptCategory(undefined)).toBeNull();
    expect(parseAttemptCategory('{"qty":2}')).toBeNull();
  });

  it('interleaves other delegations without breaking span verification', () => {
    // Two delegations interleaved in one ledger: span rows of A link to rows
    // of B globally — span verification must still pass for both.
    const { db, artifact } = freshScenario({ artifactSidecar: true });
    appendLedgerEvent(db, {
      type: 'DELEGATION_ISSUED',
      artifactId: 'dl_other',
      verdict: 'ALLOW',
    });
    appendLedgerEvent(db, {
      type: 'ATTEMPT_ALLOWED',
      artifactId: 'dl_other',
      orderId: 'order_other',
      amountPaise: 50000n,
      verdict: 'ALLOW',
    });
    const pack = generateEvidencePack(db, artifact.artifactId, null, {
      now: '2026-09-04T10:00:00.000Z',
      dataDir: DATA_DIR,
    });
    expect(pack.html).toContain('VALID');
    expect(pack.html).not.toContain('Span verification FAILED');
  });
});
