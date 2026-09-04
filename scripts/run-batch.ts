// scripts/run-batch.ts — batch runner + metrics report (swarm S5; CONTRACTS.md §9).
//
// Runs the 60-scenario seeded corpus against the REAL modules (artifact,
// gate, ledger, evidence, passthrough) — no shortcuts, no re-implementation.
// Every scenario uses its own in-memory ledger (`:memory:`), real Ed25519
// signing (deterministic signer per scenario via PRAMAAN_SIGNING_SEED-style
// derivation from the corpus seed), and the real Razorpay adapter in stub
// mode (zero network — CI runs this without secrets).
//
// Outputs:
//   metrics/report.json   — full raw numbers, scenario-level details, seed
//   metrics/summary.md    — human summary + the exceptions list (§8.6: honest)
//   metrics/chart.svg     — the before/after false-positive bar pair
//   metrics/generated/    — (gitignored) per-scenario evidence packs
//
// Money: bigint paise; strings only at JSON; ₹ display via Intl en-IN.
// Deterministic: mulberry32-driven corpus (seed in the report); latency is
// wall-clock measurement of the real dispute->dossier path and is reported
// as measured (per-run variance is the honest cost of measuring real work).

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { generateEd25519KeyPair, sign as cryptoSign } from '../src/crypto.js';
import {
  issueDelegation,
  verifyArtifact,
  type Signer,
} from '../src/artifact.js';
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
import {
  generateBatchCorpus,
  repoRoot,
  BATCH_SEED,
  type PurchaseScenario,
  type DisputeScenario,
  type FlaggedScenario,
  type BatchCorpus,
} from './gen-batch.js';

const DAY_MS = 86_400_000;
const runStartMs = Date.now();
const isoAt = (daysFromRunStart: number): string =>
  new Date(runStartMs + daysFromRunStart * DAY_MS).toISOString();
const runStartIso = new Date(runStartMs).toISOString();
import type { DelegationArtifactWire } from '../src/types.js';

const ROOT = repoRoot();
const METRICS_DIR = join(ROOT, 'metrics');
const GENERATED_DIR = join(METRICS_DIR, 'generated');

// ---------------------------------------------------------------------------
// ₹ display — the ONLY place money becomes a string for humans (en-IN).
// ---------------------------------------------------------------------------

const inr = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 2,
});

function rupees(paise: bigint): string {
  return inr.format(Number(paise) / 100); // display-only conversion, never stored
}

// ---------------------------------------------------------------------------
// deterministic per-scenario signer — hash seed+agentId to 32 bytes, wrap as
// Ed25519 (same construction as server.ts's PRAMAAN_SIGNING_SEED path, but
// self-contained so the batch does not depend on server env).
// ---------------------------------------------------------------------------

import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';

function signerFor(seed: number, agentId: string): Signer {
  // Deterministic Ed25519: the seed hashes to a 32-byte private key (wrapped
  // in a PKCS8 DER shell). The PUBLIC key is then DERIVED from that private
  // key (node:crypto does the Ed25519 scalar multiplication) — the raw seed
  // is NOT the public key.
  const raw = createHash('sha256')
    .update(`${seed}:${agentId}`, 'utf8')
    .digest();
  const pkcs8 = Buffer.concat(
    [new Uint8Array([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]), raw],
  );
  const privKey = createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
  const pubKey = createPublicKey(privKey);
  return {
    privateKey: pkcs8.toString('base64'),
    publicKey: pubKey.export({ type: 'spki', format: 'der' }).toString('base64'),
  };
}

/** Materialize the corpus's relative scope into the absolute form the frozen
 *  artifact module requires (expiresAt > issuedAt at mint time). */
function materialize(s: PurchaseScenario | DisputeScenario | FlaggedScenario): {
  categories: string[];
  maxPerTxnPaise: bigint;
  maxAggregatePaise: bigint;
  expiresAt: string;
} {
  return {
    categories: s.scope.categories,
    maxPerTxnPaise: s.scope.maxPerTxnPaise,
    maxAggregatePaise: s.scope.maxAggregatePaise,
    expiresAt: isoAt(s.scope.expiresInDays),
  };
}

interface PurchaseOutcome {
  scenario: string;
  planted: string | null;
  captured: boolean;
  blocked: boolean;
  reason: string | null;
  amountPaise: bigint | null;
  orderId: string | null;
  chainValid: boolean;
}

function runPurchase(
  s: PurchaseScenario,
  signer: Signer,
): PurchaseOutcome {
  const db = openLedger(':memory:');
  // Merchant mismatch: the artifact is issued for the CATALOG merchant (a
  // valid, correctly-signed artifact) and the cart names a DIFFERENT merchant
  // — so only the cart is wrong, the signature is real.
  const { artifact, sig } = issueDelegation(
    {
      merchantId: 'kadai-and-co',
      agentId: s.agentId,
      principal: s.principal,
      scope: materialize(s),
    },
    signer,
  );
  const wire: DelegationArtifactWire = {
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

  appendLedgerEvent(db, {
    type: 'DELEGATION_ISSUED',
    artifactId: artifact.artifactId,
    verdict: 'ALLOW',
    reason: 'batch issuance',
  });

  const decisionClock = isoAt(s.evaluatedInDays);
  const v = verifyArtifact(wire, sig, signer.publicKey, decisionClock);
  if (!v.ok) {
    appendLedgerEvent(db, {
      type: 'ATTEMPT_BLOCKED',
      artifactId: wire.artifactId,
      verdict: 'BLOCK',
      reason: v.reason, // gate reasons are always present on !ok
    });
    const rows = readLedger(db);
    return {
      scenario: `${s.kind}#${s.index}`,
      planted: s.plantedViolation ?? null,
      captured: false,
      blocked: true,
      reason: v.reason,
      amountPaise: null,
      orderId: null,
      chainValid: verifyChain(rows).valid,
    };
  }

  const verdict = evaluateGate({
    artifact: v.artifact,
    cart: s.cart,
    now: decisionClock,
    aggregateSpentPaise: aggregateSpent(db, v.artifact.artifactId),
  });

  if (!verdict.allowed) {
    appendLedgerEvent(db, {
      type: 'ATTEMPT_BLOCKED',
      artifactId: v.artifact.artifactId,
      verdict: 'BLOCK',
      reason: verdict.reason ?? 'GATE_UNSPECIFIED',
    });
    const rows = readLedger(db);
    return {
      scenario: `${s.kind}#${s.index}`,
      planted: s.plantedViolation ?? null,
      captured: false,
      blocked: true,
      reason: verdict.reason ?? null,
      amountPaise: null,
      orderId: null,
      chainValid: verifyChain(rows).valid,
    };
  }

  // allowed -> Razorpay stub order -> capture (stub mode: the order IS the
  // capture — documented in CONTRACTS §4.1 / app.ts; zero network).
  const orderId =
    'order_stub_' +
    createHash('sha256').update(v.artifact.artifactId).digest('hex').slice(0, 12);
  appendLedgerEvent(db, {
    type: 'ATTEMPT_ALLOWED',
    artifactId: v.artifact.artifactId,
    orderId,
    amountPaise: verdict.totalPaise,
    verdict: 'ALLOW',
  });
  appendLedgerEvent(db, {
    type: 'PAYMENT_CAPTURED',
    artifactId: v.artifact.artifactId,
    orderId,
    amountPaise: verdict.totalPaise,
    verdict: 'ALLOW',
    reason: 'captured (batch stub)',
  });
  const rows = readLedger(db);
  return {
    scenario: `${s.kind}#${s.index}`,
    planted: s.plantedViolation ?? null,
    captured: true,
    blocked: false,
    reason: null,
    amountPaise: verdict.totalPaise,
    orderId,
    chainValid: verifyChain(rows).valid,
  };
}

// ---------------------------------------------------------------------------
// dispute path (timed): capture, open dispute (sidecar row), generate pack
// ---------------------------------------------------------------------------

interface DisputeOutcome {
  scenario: string;
  disputeId: string;
  latencyMs: number;
  packSha256: string;
  packBytes: number;
  chainValid: boolean;
}

function runDispute(s: DisputeScenario, signer: Signer, dataDir: string): DisputeOutcome {
  const db = openLedger(':memory:');
  const { artifact, sig } = issueDelegation(
    {
      merchantId: 'kadai-and-co',
      agentId: s.agentId,
      principal: s.principal,
      scope: materialize(s),
    },
    signer,
  );
  const wire: DelegationArtifactWire = {
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
  appendLedgerEvent(db, {
    type: 'DELEGATION_ISSUED',
    artifactId: artifact.artifactId,
    verdict: 'ALLOW',
    reason: 'batch issuance',
  });
  const decisionClock = isoAt(s.evaluatedInDays);
  const v = verifyArtifact(wire, sig, signer.publicKey, decisionClock);
  if (!v.ok) throw new Error(`disputed scenario ${s.index}: artifact invalid — ${v.reason}`);
  const verdict = evaluateGate({
    artifact: v.artifact,
    cart: s.cart,
    now: decisionClock,
    aggregateSpentPaise: aggregateSpent(db, artifact.artifactId),
  });
  if (v.ok && verdict.allowed) {
    const orderId =
      'order_stub_' +
      createHash('sha256').update(artifact.artifactId).digest('hex').slice(0, 12);
    appendLedgerEvent(db, {
      type: 'ATTEMPT_ALLOWED',
      artifactId: artifact.artifactId,
      orderId,
      amountPaise: verdict.totalPaise,
      verdict: 'ALLOW',
    });
    appendLedgerEvent(db, {
      type: 'PAYMENT_CAPTURED',
      artifactId: artifact.artifactId,
      orderId,
      amountPaise: verdict.totalPaise,
      verdict: 'ALLOW',
      reason: 'captured (batch stub)',
    });
  } else {
    appendLedgerEvent(db, {
      type: 'ATTEMPT_BLOCKED',
      artifactId: artifact.artifactId,
      verdict: 'BLOCK',
      reason: verdict.reason ?? 'GATE_UNSPECIFIED',
    });
  }

  // dispute opened (sidecar row + ledger row) — then the timed window:
  // generateEvidencePack over the real ledger + sidecars.
  const disputeId = `dsp_batch_${String(s.index).padStart(2, '0')}`;
  appendLedgerEvent(db, {
    type: 'DISPUTE_OPENED',
    artifactId: artifact.artifactId,
    verdict: 'DENY',
    reason: s.disputeReason,
  });

  const t0 = performance.now();
  const pack = generateEvidencePack(db, artifact.artifactId, disputeId, {
    now: decisionClock,
    dataDir,
  });
  const t1 = performance.now();
  appendEvidenceGenerated(db, artifact.artifactId, pack.sha256);

  // persist the pack for inspection (gitignored dir)
  writeFileSync(
    join(GENERATED_DIR, `evidence-${disputeId}.html`),
    pack.html,
    'utf8',
  );

  return {
    scenario: `disputed#${s.index}`,
    disputeId,
    latencyMs: t1 - t0,
    packSha256: pack.sha256,
    packBytes: Buffer.byteLength(pack.html, 'utf8'),
    chainValid: verifyChain(readLedger(db)).valid,
  };
}

// ---------------------------------------------------------------------------
// flagged pass-through path — pramaanFraudGate is async, so the runner is
// async too: pramaanFraudGateRunner below stands in for the route layer
// (app.ts POST /fraud/evaluate) and appends the AGENT_RELEASED / ATTEMPT_BLOCKED
// row, exactly as the route does.
// ---------------------------------------------------------------------------

interface FlaggedOutcome {
  scenario: string;
  action: 'RELEASE' | 'BLOCK';
  reason: string;
  amountPaise: bigint;
}

// ---------------------------------------------------------------------------
// median
// ---------------------------------------------------------------------------

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

// ---------------------------------------------------------------------------
// chart.svg — false-positive cost, before vs after (hand-authored SVG, no deps)
// ---------------------------------------------------------------------------

function renderChart(beforePaise: bigint, afterPaise: bigint): string {
  const before = Number(beforePaise) / 100;
  const after = Number(afterPaise) / 100;
  const max = Math.max(before, after, 1);
  const W = 560;
  const H = 320;
  const plotW = W - 160;
  const plotH = H - 110;
  const x0 = 90;
  const y0 = 40;
  const barW = 110;
  const gap = 170;
  const bhB = (before / max) * plotH;
  const bhA = (after / max) * plotH;
  const fmt = (v: number) =>
    v >= 1000 ? `₹${(v / 1000).toFixed(1)}k` : `₹${v.toFixed(0)}`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="False-positive cost before vs after Pramaan">
  <rect width="${W}" height="${H}" fill="#ffffff"/>
  <style>
    .title { font: 600 15px -apple-system, 'Segoe UI', sans-serif; fill: #1d1d1f; }
    .sub   { font: 400 11px -apple-system, 'Segoe UI', sans-serif; fill: #6e6e73; }
    .axis  { stroke: #d2d2d7; stroke-width: 1; }
    .lbl   { font: 500 12px -apple-system, 'Segoe UI', sans-serif; fill: #1d1d1f; }
    .val   { font: 600 13px -apple-system, 'Segoe UI', sans-serif; fill: #1d1d1f; }
    .tick  { font: 400 10px -apple-system, 'Segoe UI', sans-serif; fill: #86868b; }
  </style>
  <text x="${W / 2}" y="24" text-anchor="middle" class="title">False-positive cost — risk engine only vs Pramaan pass-through</text>
  <text x="${W / 2}" y="40" text-anchor="middle" class="sub">Σ blocked-but-legit amountPaise over the 5 flagged-legit batch scenarios</text>
  <line x1="${x0}" y1="${y0 + plotH}" x2="${x0 + plotW + 20}" y2="${y0 + plotH}" class="axis"/>
  <line x1="${x0}" y1="${y0}" x2="${x0}" y2="${y0 + plotH}" class="axis"/>
  <line x1="${x0}" y1="${y0}" x2="${x0 + plotW + 20}" y2="${y0}" class="axis" stroke-dasharray="3 4"/>
  <text x="${x0 - 8}" y="${y0 + 4}" text-anchor="end" class="tick">${fmt(max)}</text>
  <text x="${x0 - 8}" y="${y0 + plotH + 4}" text-anchor="end" class="tick">₹0</text>
  <rect x="${x0 + 30}" y="${y0 + plotH - bhB}" width="${barW}" height="${bhB}" rx="4" fill="#c14953"/>
  <rect x="${x0 + 30 + gap}" y="${y0 + plotH - bhA}" width="${barW}" height="${bhA}" rx="4" fill="#2e6f40"/>
  <text x="${x0 + 30 + barW / 2}" y="${y0 + plotH - bhB - 10}" text-anchor="middle" class="val">${inr.format(before)}</text>
  <text x="${x0 + 30 + gap + barW / 2}" y="${y0 + plotH - Math.max(bhA, 18) - 8}" text-anchor="middle" class="val">${inr.format(after)}</text>
  <text x="${x0 + 30 + barW / 2}" y="${y0 + plotH + 20}" text-anchor="middle" class="lbl">Before (risk engine only)</text>
  <text x="${x0 + 30 + gap + barW / 2}" y="${y0 + plotH + 20}" text-anchor="middle" class="lbl">After (Pramaan)</text>
  <text x="${W / 2}" y="${H - 18}" text-anchor="middle" class="sub">Generated by scripts/run-batch.ts — seed ${BATCH_SEED} · metrics are real measurements, not mock data</text>
</svg>
`;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function run(): Promise<void> {
  mkdirSync(GENERATED_DIR, { recursive: true });

  // sidecars for the dispute path: empty disputes sidecar is tolerated by
  // generateEvidencePack (dataDir with no disputes.json). We point dataDir at
  // the generated dir so batch runs never touch the live data/ sidecars.
  const corpus: BatchCorpus = generateBatchCorpus(BATCH_SEED);

  const inScopeOutcomes = corpus.inScope.map((s) =>
    runPurchase(s, signerFor(BATCH_SEED, s.agentId)),
  );
  const outOfScopeOutcomes = corpus.outOfScope.map((s) =>
    runPurchase(s, signerFor(BATCH_SEED, s.agentId)),
  );
  const disputeOutcomes = corpus.disputed.map((s) =>
    runDispute(s, signerFor(BATCH_SEED, s.agentId), GENERATED_DIR),
  );
  // pass-through is async (passthrough deps may be async) — sequential, in order
  const flaggedLegitOutcomes: FlaggedOutcome[] = [];
  for (const s of corpus.flaggedLegit) {
    flaggedLegitOutcomes.push(
      await pramaanFraudGateRunner(s, signerFor(BATCH_SEED, s.agentId)),
    );
  }
  const flaggedMaliciousOutcomes: FlaggedOutcome[] = [];
  for (const s of corpus.flaggedMalicious) {
    flaggedMaliciousOutcomes.push(
      await pramaanFraudGateRunner(s, signerFor(BATCH_SEED, s.agentId)),
    );
  }

  // ---- metrics (CONTRACTS.md §9, verbatim definitions) ----
  const inScopePassed = inScopeOutcomes.filter((o) => o.captured).length;
  const outOfScopeBlocked = outOfScopeOutcomes.filter((o) => o.blocked && o.reason).length;
  const latencies = disputeOutcomes.map((o) => o.latencyMs);
  const legitReleased = flaggedLegitOutcomes.filter((o) => o.action === 'RELEASE').length;
  const maliciousBlocked = flaggedMaliciousOutcomes.filter((o) => o.action === 'BLOCK').length;

  // false-positive cost, before: risk-engine-only blocks ALL flagged-legit.
  const fpBefore = corpus.flaggedLegit.reduce((t, s) => t + s.tx.amountPaise, 0n);
  // after: only the flagged-legit scenarios Pramaan actually blocked.
  const fpAfter = flaggedLegitOutcomes
    .filter((o) => o.action === 'BLOCK')
    .reduce((t, o) => t + o.amountPaise, 0n);

  // ---- exceptions (honest reporting, §8.6) ----
  const exceptions: string[] = [];
  for (const o of inScopeOutcomes) {
    if (!o.captured) exceptions.push(`${o.scenario}: expected PAYMENT_CAPTURED, got ${o.reason ?? 'unknown'}`);
  }
  for (const o of outOfScopeOutcomes) {
    if (!o.blocked) exceptions.push(`${o.scenario}: planted ${o.planted}, gate ALLOWED (amount ${o.amountPaise !== null ? rupees(o.amountPaise) : 'unknown'})`);
    else if (o.planted !== undefined && o.reason !== o.planted) {
      exceptions.push(`${o.scenario}: planted ${o.planted}, gate blocked with ${o.reason} (multiple violations present — first-match ordering)`);
    }
  }
  for (const o of disputeOutcomes) {
    if (!o.chainValid) exceptions.push(`${o.scenario}: chain verification FAILED after dispute`);
  }
  for (const o of flaggedLegitOutcomes) {
    if (o.action !== 'RELEASE') exceptions.push(`${o.scenario}: flagged-legit NOT released (${o.reason})`);
  }
  for (const o of flaggedMaliciousOutcomes) {
    if (o.action !== 'BLOCK') exceptions.push(`${o.scenario}: flagged-malicious NOT blocked (${o.reason})`);
  }
  for (const o of [...inScopeOutcomes, ...outOfScopeOutcomes]) {
    if (!o.chainValid) exceptions.push(`${o.scenario}: ledger chain verification FAILED`);
  }

  // ---- report.json ----
  const report = {
    schema: 'pramaan-batch-report/1',
    seed: BATCH_SEED,
    runStartedAt: runStartIso,
    paymentsMode: 'stub', // PRAMAAN_STUB_PAYMENTS semantics; no network
    reproducibility:
      'Scenario corpus generated by scripts/gen-batch.ts with mulberry32(seed). The same seed reproduces the same corpus (carts, caps, expiry offsets, risk signals); the runner materializes expiry offsets against the real clock because issueDelegation requires expiresAt > issuedAt at mint time. Wall-clock evidence latency is measured, not simulated.',
    totals: {
      scenarios: 60,
      inScope: 25,
      outOfScope: 15,
      disputed: 10,
      flaggedLegit: 5,
      flaggedMalicious: 5,
    },
    metrics: {
      inScopePassRate: { numerator: inScopePassed, denominator: 25, value: inScopePassed / 25 },
      outOfScopeBlockRate: { numerator: outOfScopeBlocked, denominator: 15, value: outOfScopeBlocked / 15 },
      evidenceLatencyMs: {
        median: median(latencies),
        min: Math.min(...latencies),
        max: Math.max(...latencies),
        samples: latencies,
      },
      legitReleaseRate: { numerator: legitReleased, denominator: 5, value: legitReleased / 5 },
      maliciousBlockRate: { numerator: maliciousBlocked, denominator: 5, value: maliciousBlocked / 5 },
      falsePositiveCostBeforePaise: fpBefore.toString(),
      falsePositiveCostAfterPaise: fpAfter.toString(),
    },
    exceptions,
    detail: {
      inScope: inScopeOutcomes.map((o) => ({
        scenario: o.scenario,
        captured: o.captured,
        reason: o.reason ?? null,
        amountPaise: o.amountPaise !== null ? o.amountPaise.toString() : null,
        orderId: o.orderId ?? null,
        chainValid: o.chainValid,
      })),
      outOfScope: outOfScopeOutcomes.map((o) => ({
        scenario: o.scenario,
        planted: o.planted ?? null,
        blocked: o.blocked,
        reason: o.reason ?? null,
        chainValid: o.chainValid,
      })),
      disputed: disputeOutcomes.map((o) => ({
        scenario: o.scenario,
        disputeId: o.disputeId,
        latencyMs: o.latencyMs,
        packSha256: o.packSha256,
        packBytes: o.packBytes,
        chainValid: o.chainValid,
      })),
      flaggedLegit: flaggedLegitOutcomes.map((o) => ({
        scenario: o.scenario,
        action: o.action,
        reason: o.reason,
        amountPaise: o.amountPaise.toString(),
      })),
      flaggedMalicious: flaggedMaliciousOutcomes.map((o) => ({
        scenario: o.scenario,
        action: o.action,
        reason: o.reason,
        amountPaise: o.amountPaise.toString(),
      })),
    },
  };
  writeFileSync(join(METRICS_DIR, 'report.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');

  // ---- chart.svg ----
  writeFileSync(join(METRICS_DIR, 'chart.svg'), renderChart(fpBefore, fpAfter), 'utf8');

  // ---- summary.md ----
  const pct = (n: number, d: number) => `${((n / d) * 100).toFixed(1)}% (${n}/${d})`;
  const lines: string[] = [];
  lines.push('# Pramaan — Batch Metrics Summary');
  lines.push('');
  lines.push(`Generated by \`npm run batch\` (scripts/run-batch.ts) against the real modules — artifact, gate, ledger, evidence, passthrough — with stub payments (zero network). Seed **${BATCH_SEED}**, run start ${runStartIso}. The same seed reproduces this batch exactly (except wall-clock latency, which is measured, not simulated).`);
  lines.push('');
  lines.push('| Metric (CONTRACTS.md §9) | Value |');
  lines.push('|---|---|');
  lines.push(`| In-scope pass rate | ${pct(inScopePassed, 25)} |`);
  lines.push(`| Out-of-scope block rate | ${pct(outOfScopeBlocked, 15)} |`);
  lines.push(`| Evidence latency (median) | ${median(latencies).toFixed(1)} ms |`);
  lines.push(`| Legit release rate | ${pct(legitReleased, 5)} |`);
  lines.push(`| Malicious block rate | ${pct(maliciousBlocked, 5)} |`);
  lines.push(`| False-positive cost before | ${rupees(fpBefore)} |`);
  lines.push(`| False-positive cost after | ${rupees(fpAfter)} |`);
  lines.push('');
  lines.push('## How each number is produced');
  lines.push('');
  lines.push('- **In-scope pass rate** — 25 seeded carts (from `catalog.json`) run through issuance → verification → gate → stub capture; the metric counts scenarios whose ledger ends `PAYMENT_CAPTURED`.');
  lines.push('- **Out-of-scope block rate** — 15 seeded carts each plant one of the five violations (out-of-category line, per-txn cap −1 paise, aggregate cap −1 paise, expired artifact, merchant mismatch); the metric counts scenarios blocked with a machine-readable reason code.');
  lines.push(`- **Evidence latency** — median of 10 real dispute→dossier timings: \`performance.now()\` around \`generateEvidencePack(db, delegationId, disputeId)\` (full span read, diff computation, chain verification, HTML render). Range this run: ${Math.min(...latencies).toFixed(1)}–${Math.max(...latencies).toFixed(1)} ms.`);
  lines.push('- **Legit release rate** — 5 transactions the risk engine flags (score ≥ 2) where the agent presents a valid signed delegation; passthrough must return `RELEASE / PRAMAAN_DELEGATION_PROOF`.');
  lines.push('- **Malicious block rate** — 5 flagged transactions with no (or invalid) delegation proof; passthrough must return `BLOCK / NO_VALID_DELEGATION`.');
  lines.push('- **False-positive cost before/after** — Σ blocked-but-legit amountPaise. “Before” is the risk-engine-only policy (every flagged-legit blocked); “after” is what Pramaan actually blocked among flagged-legit.');
  lines.push('');
  lines.push('## Exceptions');
  lines.push('');
  if (exceptions.length === 0) {
    lines.push('None. Every scenario landed as its kind expects: all 25 in-scope purchases captured, all 15 out-of-scope carts blocked with reason codes, all 10 evidence packs generated with valid chains, all 5 flagged-legit released on delegation proof, all 5 flagged-malicious blocked. No number was tuned, dropped, or rounded in either direction.');
  } else {
    lines.push(`**${exceptions.length}** (reported verbatim — none suppressed):`);
    lines.push('');
    for (const e of exceptions) lines.push(`- ${e}`);
  }
  lines.push('');
  lines.push('## Artifacts');
  lines.push('');
  lines.push('- `metrics/report.json` — raw numbers, per-scenario detail, seed, samples.');
  lines.push('- `metrics/chart.svg` — the false-positive before/after pair.');
  lines.push('- `metrics/generated/` — the 10 evidence packs produced this run (gitignored; regenerated by every batch).');
  lines.push('');
  writeFileSync(join(METRICS_DIR, 'summary.md'), lines.join('\n'), 'utf8');

  // ---- console summary ----
  console.log('pramaan batch — 60 scenarios, seed', BATCH_SEED, '· run start', runStartIso);
  console.log('  in-scope pass rate        ', pct(inScopePassed, 25));
  console.log('  out-of-scope block rate  ', pct(outOfScopeBlocked, 15));
  console.log('  evidence latency median  ', median(latencies).toFixed(1), 'ms');
  console.log('  legit release rate       ', pct(legitReleased, 5));
  console.log('  malicious block rate     ', pct(maliciousBlocked, 5));
  console.log('  false-positive cost      ', rupees(fpBefore), '->', rupees(fpAfter));
  console.log('  exceptions               ', exceptions.length);
  console.log('  wrote metrics/report.json, metrics/summary.md, metrics/chart.svg');
}

// async wrapper for the flagged paths (pramaanFraudGate is async)
async function pramaanFraudGateRunner(s: FlaggedScenario, signer: Signer): Promise<FlaggedOutcome> {
  const db = openLedger(':memory:');
  let artifactWire: DelegationArtifactWire | null = null;
  let sig: string | null = null;

  if (s.kind === 'flagged-legit') {
    const issued = issueDelegation(
      {
        merchantId: 'kadai-and-co',
        agentId: s.agentId,
        principal: s.principal,
        scope: materialize(s),
      },
      signer,
    );
    artifactWire = {
      version: 1,
      artifactId: issued.artifact.artifactId,
      merchantId: issued.artifact.merchantId,
      agentId: issued.artifact.agentId,
      principal: issued.artifact.principal,
      scope: {
        categories: issued.artifact.scope.categories,
        maxPerTxnPaise: issued.artifact.scope.maxPerTxnPaise.toString(),
        maxAggregatePaise: issued.artifact.scope.maxAggregatePaise.toString(),
        expiresAt: issued.artifact.scope.expiresAt,
      },
      issuedAt: issued.artifact.issuedAt,
      nonce: issued.artifact.nonce,
    };
    sig = issued.sig;
    appendLedgerEvent(db, {
      type: 'DELEGATION_ISSUED',
      artifactId: issued.artifact.artifactId,
      verdict: 'ALLOW',
      reason: 'batch issuance',
    });
  }

  const verdict = await pramaanFraudGate(
    {
      merchantId: s.tx.merchantId,
      agentId: s.agentId,
      amountPaise: s.tx.amountPaise,
      orderId: s.tx.orderId,
      category: s.tx.category,
    },
    s.riskSignals,
    artifactWire && sig ? { wire: artifactWire, sig } : null,
    {
      now: runStartIso,
      verifyArtifact: (w, s2, n) => verifyArtifact(w, s2, signer.publicKey, n ?? runStartIso),
      evaluateGate: (w, tx, n) => {
        // passthrough already verified the signature; here we evaluate scope
        // for THIS transaction via the real gate with a single-line cart.
        const spent = aggregateSpent(db, w.artifactId);
        const g = evaluateGate({
          artifact: {
            version: 1,
            artifactId: w.artifactId,
            merchantId: w.merchantId,
            agentId: w.agentId,
            principal: w.principal,
            scope: {
              categories: w.scope.categories,
              maxPerTxnPaise: BigInt(w.scope.maxPerTxnPaise),
              maxAggregatePaise: BigInt(w.scope.maxAggregatePaise),
              expiresAt: w.scope.expiresAt,
            },
            issuedAt: w.issuedAt,
            nonce: w.nonce,
          },
          cart: {
            merchantId: tx.merchantId,
            lines: [
              {
                sku: 'batch-tx',
                qty: 1,
                unitPaise: tx.amountPaise,
                category: tx.category ?? '',
              },
            ],
          },
          now: n,
          aggregateSpentPaise: spent,
        });
        return g.allowed ? { ok: true } : { ok: false, reason: g.reason ?? 'SCOPE_REFUSED' };
      },
      aggregateSpent: (artifactId) => aggregateSpent(db, artifactId),
      appendLedgerEvent: (event) => appendLedgerEvent(db, event),
    },
  );

  appendLedgerEvent(db, {
    type: verdict.action === 'RELEASE' ? 'AGENT_RELEASED' : 'ATTEMPT_BLOCKED',
    ...(artifactWire !== null ? { artifactId: artifactWire.artifactId } : {}),
    orderId: s.tx.orderId,
    amountPaise: s.tx.amountPaise,
    verdict: verdict.action === 'RELEASE' ? 'RELEASE' : 'BLOCK',
    reason: verdict.reason,
  });

  return {
    scenario: `${s.kind}#${s.index}`,
    action: verdict.action,
    reason: verdict.reason,
    amountPaise: s.tx.amountPaise,
  };
}

run().catch((err) => {
  console.error('run-batch failed:', err);
  process.exit(1);
});
