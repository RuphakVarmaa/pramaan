// scripts/demo.ts — THE DEMO ARC (swarm S5). Plain console.log + unicode
// box-drawing, zero deps, runs on the REAL modules with stub payments.
//
// The four demo moments (JUDGE.md order):
//   1. The issued artifact + signature (trust primitive, live)
//   2. In-scope purchase — the ledger chain landing, hashes visible
//   3. The graceful failure — cap exceeded, reason code, ATTEMPT_BLOCKED
//      (the refusal is a FEATURE: precise, machine-readable, recorded)
//   4. Dispute + evidence pack (sha256 + size) + fraud-flagged legit RELEASE
//      vs malicious BLOCK — ending with the full ledger and verifyChain().
//
// Timestamped, narrative, deterministic (mulberry32-style fixed values, no
// Math.random; wall-clock timestamps shown for narrative, all decisions on a
// fixed demo epoch so the arc is reproducible).
//
// Run: npm run demo   (after npm run build; runs dist/scripts/demo.js)

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

import { generateEd25519KeyPair, sign as cryptoSign } from '../src/crypto.js';
import { issueDelegation, verifyArtifact, type Signer } from '../src/artifact.js';
import {
  openLedger,
  appendLedgerEvent,
  readLedger,
  verifyChain,
  aggregateSpent,
} from '../src/ledger.js';
import { evaluateGate } from '../src/gate.js';
import {
  generateEvidencePack,
  appendEvidenceGenerated,
} from '../src/evidence.js';
import { pramaanFraudGate } from '../src/passthrough.js';
import type { DelegationArtifactWire } from '../src/types.js';

const DEMO_EPOCH = '2026-09-04T12:00:00.000Z'; // fixed decision clock
const inr = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
});
const rupees = (paise: bigint) => inr.format(Number(paise) / 100);

// ---------------------------------------------------------------------------
// console dressing — unicode box-drawing, nothing else
// ---------------------------------------------------------------------------

const W = 76;
let sectionCount = 0;

function banner(): void {
  console.log(`
┌${'─'.repeat(W - 2)}┐
│  PRAMAAN — Proof of Delegation & Dispute-Evidence Layer                        │
│  Agent payments on Razorpay (test mode) · the full arc, live on real modules   │
└${'─'.repeat(W - 2)}┘`);
}

function section(title: string): void {
  sectionCount++;
  const t = ` ${sectionCount}. ${title} `;
  const pad = W - 2 - t.length;
  console.log('');
  console.log(`┌${t}${'─'.repeat(Math.max(0, pad))}┐`);
}

function line(...parts: string[]): void {
  const s = '  ' + parts.join(' ');
  console.log(`│${s.slice(0, W - 2).padEnd(W - 2)}│`);
}

function kv(k: string, v: string): void {
  line(`${k.padEnd(22)} ${v}`);
}

function rule(): void {
  console.log(`├${'─'.repeat(W - 2)}┤`);
}

function close(): void {
  console.log(`└${'─'.repeat(W - 2)}┘`);
}

function nowStamp(): string {
  return new Date().toISOString().replace('T', ' ').replace('Z', ' UTC');
}

function wire(artifact: ReturnType<typeof issueDelegation>['artifact']): DelegationArtifactWire {
  return {
    version: 1,
    artifactId: artifact.artifactId,
    merchantId: artifact.merchantId,
    agentId: artifact.agentId,
    principal: artifact.principal,
    scope: {
      categories: artifact.scope.categories,
      maxPerTxnPaise: artifact.scope.maxPerTxnPaise.toString(),
      maxAggregatePaise: artifact.scope.maxAggregatePaise.toString(),
      expiresAt: artifact.scope.expiresAt,
    },
    issuedAt: artifact.issuedAt,
    nonce: artifact.nonce,
  };
}

// deterministic demo signer (same DER-wrap derivation as run-batch)
function demoSigner(): Signer {
  const raw = createHash('sha256').update('pramaan-demo-signer', 'utf8').digest();
  return {
    privateKey: Buffer.concat(
      Buffer.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]),
      raw,
    ).toString('base64'),
    publicKey: Buffer.concat(
      Buffer.from([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00]),
      raw,
    ).toString('base64'),
  };
}

// ---------------------------------------------------------------------------
// the arc
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'pramaan-demo-'));
  const dataDir = join(dir, 'data');
  mkdirSync(dataDir, { recursive: true });
  const db = openLedger(':memory:');
  const signer = demoSigner();

  banner();
  console.log(`  demo epoch (decision clock): ${DEMO_EPOCH}`);
  console.log(`  run at:                     ${nowStamp()}`);
  console.log(`  payments:                   stub mode (documented fallback — zero network)`);

  // =========================================================================
  // 1. THE ARTIFACT — the principal delegates, Pramaan signs
  // =========================================================================
  section('THE DELEGATION — Rupa authorizes her shopping agent');

  line('Rupa gives her agent a bounded, signed mandate — not a blank cheque.');
  line('Scope: coffee + equipment · per-txn cap ₹5,000 · lifetime cap ₹20,000.');
  line('');
  const { artifact, sig } = issueDelegation(
    {
      merchantId: 'kadai-and-co',
      agentId: 'agent:shopping-assistant-v3',
      principal: 'human:rupa@upi',
      scope: {
        categories: ['coffee', 'equipment'],
        maxPerTxnPaise: 500_000n,
        maxAggregatePaise: 2_000_000n,
        expiresAt: '2027-09-04T00:00:00.000Z',
      },
    },
    signer,
  );
  appendLedgerEvent(db, {
    type: 'DELEGATION_ISSUED',
    artifactId: artifact.artifactId,
    verdict: 'ALLOW',
    reason: 'demo issuance',
  });

  kv('artifactId', artifact.artifactId);
  kv('principal', artifact.principal);
  kv('agent', artifact.agentId);
  kv('merchant', artifact.merchantId);
  kv('categories', artifact.scope.categories.join(', '));
  kv('per-txn cap', rupees(artifact.scope.maxPerTxnPaise));
  kv('lifetime cap', rupees(artifact.scope.maxAggregatePaise));
  kv('expires', artifact.scope.expiresAt.slice(0, 10));
  kv('nonce', artifact.nonce);
  kv('signature (Ed25519)', sig.slice(0, 28) + '…');
  kv('public key (b64)', signer.publicKey.slice(0, 28) + '…');
  line('');
  const w = wire(artifact);
  const check = verifyArtifact(w, sig, signer.publicKey, DEMO_EPOCH);
  line(`verifyArtifact() → ${check.ok ? 'VALID — signature checks out against the canonical form' : 'INVALID: ' + (check as { reason: string }).reason}`);
  close();

  // =========================================================================
  // 2. IN-SCOPE PURCHASE — gate allows, ledger chain lands
  // =========================================================================
  section('THE PURCHASE — agent buys coffee, gate allows, chain lands');

  const cart = {
    merchantId: 'kadai-and-co',
    lines: [
      { sku: 'KC-COF-CHIK-250', qty: 1, unitPaise: 52_000n, category: 'coffee' },
      { sku: 'KC-COF-MALB-250', qty: 2, unitPaise: 48_000n, category: 'coffee' },
    ],
  };
  const total = cart.lines.reduce((t, l) => t + BigInt(l.qty) * l.unitPaise, 0n);
  line(`Cart: 1× Chikmagalur Peaberry 250g + 2× Malabar Monsoon 250g  =  ${rupees(total)}`);
  line('');
  const verdict = evaluateGate({
    artifact,
    cart,
    now: DEMO_EPOCH,
    aggregateSpentPaise: aggregateSpent(db, artifact.artifactId),
  });
  line(`evaluateGate() → allowed=${verdict.allowed}  total=${rupees(verdict.totalPaise)}  aggregate-after=${rupees(verdict.aggregateAfterPaise)}`);
  line('');
  const orderId =
    'order_stub_' + createHash('sha256').update(artifact.artifactId + '1').digest('hex').slice(0, 12);
  const allowedRow = appendLedgerEvent(db, {
    type: 'ATTEMPT_ALLOWED',
    artifactId: artifact.artifactId,
    orderId,
    amountPaise: total,
    verdict: 'ALLOW',
  });
  const capturedRow = appendLedgerEvent(db, {
    type: 'PAYMENT_CAPTURED',
    artifactId: artifact.artifactId,
    orderId,
    amountPaise: total,
    verdict: 'ALLOW',
    reason: 'captured (stub)',
  });
  line(`Razorpay stub order ${orderId} captured. The ledger chain grows:`);
  line('');
  for (const r of [allowedRow, capturedRow]) {
    line(`seq ${String(r.seq).padStart(2)}  ${r.type.padEnd(16)} ${r.amountPaise !== undefined ? rupees(r.amountPaise).padStart(10) + '  ' : ''.padEnd(11)}prev ${r.prevHash.slice(0, 8)}… self ${r.selfHash.slice(0, 8)}…`);
  }
  line('');
  line(`each row: selfHash = sha256(prevHash ‖ canonical(row)) — the spine is append-only.`);
  close();

  // =========================================================================
  // 3. THE GRACEFUL FAILURE — cap exceeded, precise, recorded
  // =========================================================================
  section('THE REFUSAL — the agent tries to exceed its cap, gate says no');

  line('Same agent now tries a ₹2,390 brew scale — over the ₹5,000 per-txn cap.');
  line('This is the product working, not the product failing:');
  line('the refusal is precise, machine-readable, and on the record.');
  line('');
  const bigCart = {
    merchantId: 'kadai-and-co',
    lines: [
      { sku: 'KC-EQP-SCLE-01', qty: 1, unitPaise: 239_000n, category: 'equipment' },
      { sku: 'KC-EQP-TAM-53', qty: 15, unitPaise: 118_000n, category: 'equipment' },
    ],
  };
  const bigTotal = bigCart.lines.reduce((t, l) => t + BigInt(l.qty) * l.unitPaise, 0n);
  const refusal = evaluateGate({
    artifact,
    cart: bigCart,
    now: DEMO_EPOCH,
    aggregateSpentPaise: aggregateSpent(db, artifact.artifactId),
  });
  kv('cart total', rupees(bigTotal));
  kv('per-txn cap', rupees(artifact.scope.maxPerTxnPaise));
  kv('gate verdict', `allowed=${refusal.allowed}`);
  kv('reason code', String(refusal.reason));
  line('');
  const blockedRow = appendLedgerEvent(db, {
    type: 'ATTEMPT_BLOCKED',
    artifactId: artifact.artifactId,
    verdict: 'BLOCK',
    reason: refusal.reason ?? 'UNKNOWN',
  });
  line(`ATTEMPT_BLOCKED lands on the ledger (seq ${blockedRow.seq}) — no payment, no`);
  line(`order, no ambiguity. The reason code is the API: the agent can self-correct.`);
  close();

  // =========================================================================
  // 4. DISPUTE + EVIDENCE + FRAUD PASS-THROUGH
  // =========================================================================
  section('THE DISPUTE — Rupa disputes the charge; the dossier answers');

  line('Six weeks later the card statement shows the coffee charge.');
  line('Rupa disputes it. The bank needs proof of delegation — now, not in a week.');
  line('');
  const disputeId = 'dsp_demo_0001';
  const disputeRow = appendLedgerEvent(db, {
    type: 'DISPUTE_OPENED',
    artifactId: artifact.artifactId,
    verdict: 'DENY',
    reason: 'cardholder disputes this charge — not recognized',
  });
  line(`DISPUTE_OPENED (seq ${disputeRow.seq}, ${disputeId})`);
  line('');
  const t0 = performance.now();
  const pack = generateEvidencePack(db, artifact.artifactId, disputeId, {
    now: DEMO_EPOCH,
    dataDir,
  });
  const t1 = performance.now();
  appendEvidenceGenerated(db, artifact.artifactId, pack.sha256);
  writeFileSync(join(dataDir, 'evidence-pack-demo.html'), pack.html, 'utf8');
  kv('dossier', 'Exhibits A–E: scope, attempts, captures, computed diff, chain proof');
  kv('evidence sha256', pack.sha256);
  kv('dossier size', `${Buffer.byteLength(pack.html, 'utf8').toLocaleString('en-IN')} bytes, self-contained HTML`);
  kv('generation time', `${(t1 - t0).toFixed(1)} ms — dispute to dossier`);
  close();

  section('THE FRAUD FLAG — flagged-legit freed on proof, impostor blocked');

  line('A different payment gets flagged by the risk engine (velocity 8/min).');
  line('');
  // flagged-legit: same artifact, proves delegation → RELEASE
  const legit = await pramaanFraudGate(
    {
      merchantId: 'kadai-and-co',
      agentId: 'agent:shopping-assistant-v3',
      amountPaise: 48_000n,
      orderId: 'order_flagged_legit_01',
      category: 'coffee',
    },
    { velocityPerMin: 8, headless: false, accountAgeDays: 400 },
    { wire: w, sig },
    {
      now: DEMO_EPOCH,
      verifyArtifact: (wi, s, n) => verifyArtifact(wi, s, signer.publicKey, n),
      evaluateGate: (wi, tx, n) => {
        const g = evaluateGate({
          artifact: {
            version: 1,
            artifactId: wi.artifactId,
            merchantId: wi.merchantId,
            agentId: wi.agentId,
            principal: wi.principal,
            scope: {
              categories: wi.scope.categories,
              maxPerTxnPaise: BigInt(wi.scope.maxPerTxnPaise),
              maxAggregatePaise: BigInt(wi.scope.maxAggregatePaise),
              expiresAt: wi.scope.expiresAt,
            },
            issuedAt: wi.issuedAt,
            nonce: wi.nonce,
          },
          cart: {
            merchantId: tx.merchantId,
            lines: [{ sku: 'demo-tx', qty: 1, unitPaise: tx.amountPaise, category: tx.category ?? '' }],
          },
          now: n,
          aggregateSpentPaise: aggregateSpent(db, wi.artifactId),
        });
        return g.allowed ? { ok: true } : { ok: false, reason: g.reason ?? 'SCOPE_REFUSED' };
      },
      aggregateSpent: (id) => aggregateSpent(db, id),
    },
  );
  appendLedgerEvent(db, {
    type: 'AGENT_RELEASED',
    artifactId: artifact.artifactId,
    orderId: 'order_flagged_legit_01',
    amountPaise: 48_000n,
    verdict: 'RELEASE',
    reason: legit.reason,
  });
  kv('flagged-legit', `→ ${legit.action} (${legit.reason}) — sale saved, false positive avoided`);
  line('');
  // flagged-malicious: impostor, no proof → BLOCK
  const mal = await pramaanFraudGate(
    {
      merchantId: 'kadai-and-co',
      agentId: 'agent:impostor-01',
      amountPaise: 48_000n,
      orderId: 'order_flagged_mal_01',
      category: 'coffee',
    },
    { velocityPerMin: 9, headless: true, accountAgeDays: 3 },
    null,
    {
      now: DEMO_EPOCH,
      verifyArtifact: (wi, s, n) => verifyArtifact(wi, s, signer.publicKey, n),
      evaluateGate: () => ({ ok: false, reason: 'NO_PROOF' }),
      aggregateSpent: () => 0n,
    },
  );
  appendLedgerEvent(db, {
    type: 'ATTEMPT_BLOCKED',
    artifactId: null,
    orderId: 'order_flagged_mal_01',
    amountPaise: 48_000n,
    verdict: 'BLOCK',
    reason: mal.reason,
  });
  kv('flagged-malicious', `→ ${mal.action} (${mal.reason}) — no proof, no payment`);
  close();

  // =========================================================================
  // FINALE — the full ledger, verified
  // =========================================================================
  section('THE LEDGER — every money action, hash-chained, verified');

  const rows = readLedger(db);
  for (const r of rows) {
    const amt = r.amountPaise !== undefined ? rupees(r.amountPaise).padStart(10) : ''.padEnd(10);
    const why = r.reason !== undefined ? `  ${r.reason.slice(0, 26)}` : '';
    line(`seq ${String(r.seq).padStart(2)}  ${r.type.padEnd(16)} ${amt} ${r.prevHash.slice(0, 6)}→${r.selfHash.slice(0, 6)}${why}`);
  }
  line('');
  const chain = verifyChain(rows);
  line(`verifyChain() → ${chain.valid ? `VALID — all ${rows.length} rows re-hash from genesis, zero tampering` : `BROKEN at seq ${chain.firstBreak}`}`);
  close();

  console.log(`
  That is Pramaan: the agent proves what it was allowed to do, the ledger
  proves what it actually did, and the dossier proves it to a bank in one file.

  Demo artifacts (this run): ${join(dataDir, 'evidence-pack-demo.html')}
  Ledger: in-memory (fresh every run) · Payments: stub mode (test only)

  Reproduce the measured version: npm run batch  →  metrics/summary.md
`);
  console.log(`demo complete — ${rows.length} ledger rows, chain ${chain.valid ? 'valid' : 'BROKEN'}, arc green`);

  rmSync(dir, { recursive: true, force: true });
}

main().catch((err) => {
  console.error('demo failed:', err);
  process.exit(1);
});
