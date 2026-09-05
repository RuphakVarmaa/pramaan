// src/routes/console.ts — the CONSOLE bridge: serves the web/ client's exact
// contract (S6's mock shapes) on /api/* using the REAL backend modules.
//
// The console was built mock-first against this shape; this adapter makes
// "GO LIVE" work against the real Fastify stack without rewriting the client.
//
// Endpoints (all under /api):
//   GET  /api/ledger            → console LedgerEntry[]
//   POST /api/delegations       → issue → console DelegationArtifact
//   POST /api/gate              → checkout/attempt → console GateVerdict
//   POST /api/disputes          → open dispute → { disputeId }
//   POST /api/evidence          → evidence pack HTML { html, sha256 }
//   POST /api/fraud/flags       → console FraudFlag[] (synthetic feed from recent txns)
//   POST /api/fraud/gate        → pass-through → console FraudVerdict
//   GET  /api/ledger/verify     → ChainVerification

import type { FastifyInstance } from 'fastify';
import type { AppDeps, LedgerAppendEvent } from '../app.js';
import { appendLedgerEvent, readLedger, aggregateSpent } from '../ledger.js';
import { verifyArtifact } from '../artifact.js';
import { evaluateGate } from '../gate.js';
import { pramaanFraudGate } from '../passthrough.js';
import { evaluateRisk } from '../../risk-mock/engine.js';
import { generateEvidencePack, appendEvidenceGenerated } from '../evidence.js';
import { newDisputeId } from '../razorpay.js';
import catalogJson from '../../catalog.json' with { type: 'json' };
import type { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  DelegationArtifactWire,
  LedgerRow,
} from '../types.js';

// The catalog wire form carries prices as JSON integers; we widen to bigint
// at load so no downstream code ever holds a float-able money value.
interface ProductWire {
  sku: string;
  name: string;
  category: string;
  description: string;
  [key: string]: string | number; // price arrives as unitPaise (JSON integer)
}
interface Product {
  sku: string;
  name: string;
  category: string;
  unitPaise: bigint;
  description: string;
}
const products: Product[] = (catalogJson as unknown as { products: ProductWire[] }).products.map((p) => ({
  sku: p.sku,
  name: p.name,
  category: p.category,
  description: p.description,
  unitPaise: BigInt(p.unitPaise as number),
}));
const merchant = (catalogJson as { merchant: { id: string; name: string } }).merchant;

// In-memory console session state (serverless: per-warm-container, like the demo)
const g = globalThis as unknown as {
  __consoleArtifacts?: Map<string, { wire: DelegationArtifactWire; sig: string }>;
  __consoleDisputes?: Array<{ disputeId: string; ledgerSeq: number; amountPaise: string; reason: string; openedAt: string }>;
};
g.__consoleArtifacts ??= new Map();
g.__consoleDisputes ??= [];

/** Memory first, then the sidecar — so artifacts survive container swaps. */
function loadArtifact(id: string): { wire: DelegationArtifactWire; sig: string } | undefined {
  const mem = g.__consoleArtifacts!.get(id);
  if (mem) return mem;
  try {
    const artifactsPath = join(DATA_DIR, 'artifacts.json');
    if (existsSync(artifactsPath)) {
      const all = JSON.parse(readFileSync(artifactsPath, 'utf8')) as Record<string, { artifact: DelegationArtifactWire; sig: string }>;
      const hit = all[id];
      if (hit) {
        const restored = { wire: hit.artifact, sig: hit.sig };
        g.__consoleArtifacts!.set(id, restored);
        return restored;
      }
    }
  } catch {
    // sidecar read failure — fall through
  }
  return undefined;
}

const AGENT_PERSONAS: Record<string, { persona: string; model: string }> = {
  'agent-007': { persona: 'Shaheen', model: 'GPT-class assistant' },
  default: { persona: 'Shopping Agent', model: 'assistant' },
};

function consoleLedgerRow(r: LedgerRow) {
  return {
    seq: r.seq,
    ts: r.ts,
    type: r.type,
    amountPaise: r.amountPaise !== undefined && r.amountPaise !== null ? r.amountPaise.toString() : null,
    verdict: r.verdict ?? null,
    reason: r.reason ?? null,
    actor: r.artifactId ?? 'system',
    memo: r.reason ?? r.type,
    prevHash: r.prevHash,
    selfHash: r.selfHash,
  };
}

let DATA_DIR = '/tmp/pramaan-data';

export function registerConsoleRoutes(app: FastifyInstance, deps: AppDeps, db: DatabaseSync, now: () => string): void {
  DATA_DIR = (deps.env.PRAMAAN_DATA_DIR as string | undefined) ?? (deps.env.PRAMAAN_DB ? dirname(deps.env.PRAMAAN_DB) : undefined) ?? (deps.dataDir as string | undefined) ?? '/tmp/pramaan-data';
  const append = (e: LedgerAppendEvent) =>
    appendLedgerEvent(db, {
      type: e.type,
      ...(e.artifactId != null ? { artifactId: e.artifactId } : {}),
      ...(e.orderId != null ? { orderId: e.orderId } : {}),
      ...(e.amountPaise != null ? { amountPaise: e.amountPaise } : {}),
      ...(e.verdict != null ? { verdict: e.verdict } : {}),
      ...(e.reason != null ? { reason: e.reason } : {}),
    });

  // ---- GET /api/ledger — console rows (newest first, like the mock) ----
  app.get('/api/ledger', async () => {
    const rows = readLedger(db);
    return rows
      .slice()
      .reverse()
      .map(consoleLedgerRow);
  });

  // ---- GET /api/ledger/verify — chain verification ----
  app.get('/api/ledger/verify', async () => {
    const rows = readLedger(db);
    // reuse the ledger's own verifier via dynamic import to avoid cycles
    const { verifyChain } = await import('../ledger.js');
    const v = verifyChain(rows);
    return { valid: v.valid, checkedEntries: rows.length, brokenAtSeq: v.firstBreak ?? null };
  });

  // ---- POST /api/delegations — issue, console shape ----
  app.post('/api/delegations', async (req, reply) => {
    const b = req.body as {
      principalName?: string;
      principalEmail?: string;
      agentId?: string;
      categories?: string[];
      perTxnCapPaise?: string;
      aggregateCapPaise?: string;
      expiryMinutes?: number;
    };
    if (!b?.principalName || !b?.agentId || !b?.categories?.length || !b?.perTxnCapPaise || !b?.aggregateCapPaise) {
      return reply.code(400).send({ error: 'invalid_request', reason: 'principalName, agentId, categories, perTxnCapPaise, aggregateCapPaise required' });
    }
    const mins = b.expiryMinutes && b.expiryMinutes > 0 ? b.expiryMinutes : 30;
    const expiresAt = new Date(Date.now() + mins * 60_000).toISOString();

    const issued = deps.issueDelegation({
      merchantId: merchant.id,
      agentId: b.agentId,
      principal: `${b.principalName} <${b.principalEmail ?? 'unknown@example.in'}>`,
      scope: {
        categories: b.categories,
        maxPerTxnPaise: BigInt(b.perTxnCapPaise),
        maxAggregatePaise: BigInt(b.aggregateCapPaise),
        expiresAt,
      },
    });

    append({
      type: 'DELEGATION_ISSUED',
      artifactId: issued.artifact.artifactId,
      verdict: 'ALLOW',
      reason: JSON.stringify({
        scope: {
          categories: issued.artifact.scope.categories,
          maxPerTxnPaise: issued.artifact.scope.maxPerTxnPaise.toString(),
          maxAggregatePaise: issued.artifact.scope.maxAggregatePaise.toString(),
          expiresAt: issued.artifact.scope.expiresAt,
        },
        issuedAt: issued.artifact.issuedAt,
      }),
    });

    const wire = JSON.parse(
      JSON.stringify(issued.artifact, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
    ) as unknown as DelegationArtifactWire;
    g.__consoleArtifacts!.set(issued.artifact.artifactId, { wire, sig: issued.sig });
    // sidecar = shared storage: survives serverless container swaps
    try {
      const artifactsPath = join(DATA_DIR, 'artifacts.json');
      mkdirSync(dirname(artifactsPath), { recursive: true });
      const existing = existsSync(artifactsPath)
        ? (JSON.parse(readFileSync(artifactsPath, 'utf8')) as Record<string, unknown>)
        : {};
      existing[issued.artifact.artifactId] = { artifact: wire, sig: issued.sig };
      writeFileSync(artifactsPath, JSON.stringify(existing, null, 2) + '\n');
    } catch {
      // sidecar best-effort; in-memory map still serves this container
    }

    const persona = AGENT_PERSONAS[b.agentId] ?? AGENT_PERSONAS.default!;
    return {
      // the EXACT wire form that was signed — the client re-presents these
      // bytes with every attempt so the signature always verifies (§1.2)
      wire: wire,
      sig: issued.sig,
      artifactId: issued.artifact.artifactId,
      version: 1 as const,
      merchant: { id: merchant.id, name: merchant.name },
      principal: { name: b.principalName, email: b.principalEmail ?? '' },
      agent: { id: b.agentId, persona: persona.persona, model: persona.model },
      scope: {
        categories: issued.artifact.scope.categories,
        perTxnCapPaise: issued.artifact.scope.maxPerTxnPaise.toString(),
        aggregateCapPaise: issued.artifact.scope.maxAggregatePaise.toString(),
        expiresAt: issued.artifact.scope.expiresAt,
      },
      issuedAt: issued.artifact.issuedAt,
      signature: issued.sig,
    };
  });

  // ---- POST /api/gate — attempt payment, console shape ----
  app.post('/api/gate', async (req, reply) => {
    const b = req.body as {
      artifactId?: string;
      cart?: Array<{ sku: string; qty: number }>;
      // protocol-correct: the agent PRESENTS its mandate (wire + sig).
      // Server-side lookup is a fallback, not the source of truth.
      artifactWire?: DelegationArtifactWire;
      sig?: string;
    };
    const presented = b?.artifactWire && b?.sig ? { wire: b.artifactWire, sig: b.sig } : undefined;
    const stored = presented ?? (b?.artifactId ? loadArtifact(b.artifactId) : undefined);
    if (!stored || !b?.cart?.length) {
      return reply.code(400).send({ error: 'invalid_request', reason: 'no presented artifact, unknown artifactId, or empty cart' });
    }

    // resolve catalog lines (server-side catalog is authoritative)
    const lines = b.cart.map((l) => {
      const p = products.find((x) => x.sku === l.sku);
      return p ? { sku: l.sku, qty: l.qty, unitPaise: p.unitPaise, category: p.category } : null;
    });
    if (lines.some((l) => l === null)) {
      return reply.code(400).send({ error: 'unknown_sku', reason: 'cart contains unknown sku' });
    }

    const v = verifyArtifact(stored.wire, stored.sig, deps.publicKey, now());
    if (!v.ok) {
      append({ type: 'ATTEMPT_BLOCKED', artifactId: b.artifactId ?? null, verdict: 'BLOCK', reason: v.reason });
      return {
        decision: 'BLOCKED',
        reason: v.reason,
        amountPaise: null,
        orderId: null,
        ledgerSeq: null,
        artifactId: b.artifactId ?? null,
      };
    }

    const spent = aggregateSpent(db, v.artifact.artifactId);
    const verdict = evaluateGate({
      artifact: v.artifact,
      cart: { merchantId: merchant.id, lines: lines as Array<{ sku: string; qty: number; unitPaise: bigint; category: string }> },
      now: now(),
      aggregateSpentPaise: spent,
    });

    if (!verdict.allowed) {
      append({
        type: 'ATTEMPT_BLOCKED',
        artifactId: v.artifact.artifactId,
        amountPaise: verdict.totalPaise,
        verdict: 'BLOCK',
        reason: verdict.reason ?? null,
      });
      const rows = readLedger(db);
      return {
        decision: 'BLOCKED',
        reason: verdict.reason,
        amountPaise: verdict.totalPaise.toString(),
        orderId: null,
        ledgerSeq: rows.length ? rows[rows.length - 1]!.seq : null,
        artifactId: v.artifact.artifactId,
      };
    }

    // ALLOWED → real Razorpay test/stub order
    let order: { orderId: string; amountPaise: bigint; status: string };
    try {
      order = await deps.razorpay.createOrder({
        amountPaise: verdict.totalPaise,
        receipt: v.artifact.artifactId,
        notes: { artifactId: v.artifact.artifactId, agentId: v.artifact.agentId },
      });
    } catch {
      append({ type: 'ATTEMPT_BLOCKED', artifactId: v.artifact.artifactId, amountPaise: verdict.totalPaise, verdict: 'BLOCK', reason: 'PAYMENT_PROVIDER_ERROR' });
      return reply.code(502).send({ error: 'payment_provider_error' });
    }

    append({ type: 'ATTEMPT_ALLOWED', artifactId: v.artifact.artifactId, orderId: order.orderId, amountPaise: verdict.totalPaise, verdict: 'ALLOW', reason: 'within scope' });
    append({ type: 'PAYMENT_CAPTURED', artifactId: v.artifact.artifactId, orderId: order.orderId, amountPaise: order.amountPaise, verdict: 'ALLOW', reason: 'captured' });
    const rows = readLedger(db);
    return {
      decision: 'ALLOWED',
      reason: 'OK' as never,
      amountPaise: order.amountPaise.toString(),
      orderId: order.orderId,
      ledgerSeq: rows.length ? rows[rows.length - 1]!.seq : null,
      artifactId: v.artifact.artifactId,
      lines: b.cart.map((l) => {
        const p = products.find((x) => x.sku === l.sku)!;
        return { sku: l.sku, name: p.name, qty: l.qty, unitPaise: p.unitPaise.toString() };
      }),
    };
  });

  // ---- POST /api/disputes — open dispute on a captured row ----
  app.post('/api/disputes', async (req, reply) => {
    const b = req.body as { ledgerSeq?: number; reason?: string };
    const rows = readLedger(db);
    const target = rows.find((r) => r.seq === b?.ledgerSeq && r.type === 'PAYMENT_CAPTURED');
    if (!target || !b?.reason) {
      return reply.code(400).send({ error: 'invalid_request', reason: 'ledgerSeq (of a captured row) and reason required' });
    }
    const disputeId = newDisputeId();
    g.__consoleDisputes!.push({
      disputeId,
      ledgerSeq: target.seq,
      amountPaise: (target.amountPaise ?? 0n).toString(),
      reason: b.reason,
      openedAt: now(),
    });
    append({
      type: 'DISPUTE_OPENED',
      artifactId: target.artifactId ?? null,
      orderId: target.orderId ?? null,
      amountPaise: target.amountPaise ?? null,
      verdict: 'BLOCK',
      reason: b.reason,
    });
    return { disputeId };
  });

  // ---- POST /api/evidence — evidence pack for the console ----
  app.post('/api/evidence', async (req, reply) => {
    const b = req.body as { ledgerSeq?: number };
    const rows = readLedger(db);
    const target = rows.find((r) => r.seq === b?.ledgerSeq && r.type === 'PAYMENT_CAPTURED');
    if (!target) {
      return reply.code(400).send({ error: 'invalid_request', reason: 'ledgerSeq of a captured row required' });
    }
    const delegationId = target.artifactId;
    if (!delegationId) return reply.code(400).send({ error: 'invalid_request', reason: 'row has no delegation' });
    const dispute = [...g.__consoleDisputes!].reverse().find((d) => d.ledgerSeq === target.seq);
    const pack = generateEvidencePack(db, delegationId, dispute?.disputeId ?? null, { now: now() });
    appendEvidenceGenerated(db, delegationId, pack.sha256);
    return { html: pack.html, sha256: pack.sha256, disputeId: dispute?.disputeId ?? null };
  });

  // ---- POST /api/fraud/flags — synthetic feed derived from recent orders ----
  app.post('/api/fraud/flags', async () => {
    const rows = readLedger(db).filter((r) => r.type === 'PAYMENT_CAPTURED');
    const flags = rows.slice(-6).map((r, i) => ({
      flagId: `flag_${r.seq}_${i}`,
      orderId: r.orderId ?? `order_${r.seq}`,
      actor: r.artifactId ?? 'agent',
      amountPaise: (r.amountPaise ?? 0n).toString(),
      signals: ['HIGH_VELOCITY', 'HEADLESS_BROWSER'],
      flaggedAt: r.ts,
    }));
    return flags;
  });

  // ---- POST /api/fraud/gate — pass-through, console shape ----
  app.post('/api/fraud/gate', async (req, reply) => {
    const b = req.body as { flagId?: string; withArtifact?: boolean; artifactWire?: DelegationArtifactWire; sig?: string };
    const rows = readLedger(db).filter((r) => r.type === 'PAYMENT_CAPTURED');
    const m = b?.flagId?.match(/^flag_(\d+)_/);
    const seq = m ? Number(m[1]) : null;
    const target = rows.find((r) => r.seq === seq) ?? rows[rows.length - 1];
    if (!target) {
      return reply.code(400).send({ error: 'invalid_request', reason: 'no captured transactions to evaluate' });
    }

    const signals = { velocityPerMin: 9, headless: true, accountAgeDays: 400 };
    const risk = evaluateRisk(signals); // flagged by design

    const presentedFraud = (b as { artifactWire?: DelegationArtifactWire; sig?: string }).artifactWire &&
      (b as { sig?: string }).sig
      ? { wire: (b as { artifactWire: DelegationArtifactWire }).artifactWire, sig: (b as { sig: string }).sig }
      : undefined;
    if (presentedFraud || (b?.withArtifact && target.artifactId)) {
      const stored = presentedFraud ?? loadArtifact(target.artifactId!);
      if (stored) {
        const verdict = await pramaanFraudGate(
          {
            merchantId: merchant.id,
            agentId: 'agent-007',
            amountPaise: target.amountPaise ?? 0n,
            ...(target.orderId ? { orderId: target.orderId } : {}),
          },
          signals,
          { wire: stored.wire, sig: stored.sig },
          {
            now: now(),
            verifyArtifact: (w, s) => {
              const r = verifyArtifact(w, s, deps.publicKey, now());
              return r.ok ? { ok: true } : { ok: false, reason: r.reason };
            },
            evaluateGate: (w, tx) => {
              const art = JSON.parse(
                JSON.stringify(w, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
              ) as unknown as DelegationArtifactWire;
              void art;
              // amount+merchant scope-check via the real gate on a synthetic line
              const verdict2 = evaluateGate({
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
                cart: { merchantId: merchant.id, lines: [{ sku: 'fraud-eval', category: w.scope.categories[0] ?? 'coffee', qty: 1, unitPaise: tx.amountPaise }] },
                now: now(),
                aggregateSpentPaise: aggregateSpent(db, w.artifactId),
              });
              return verdict2.allowed ? { ok: true } : { ok: false, reason: verdict2.reason ?? 'SCOPE_REFUSED' };
            },
            aggregateSpent: (artifactId) => aggregateSpent(db, artifactId),
            appendLedgerEvent: (event) => void append(event),
          },
        );
        const rowsAfter = readLedger(db);
        return {
          decision: verdict.action,
          proof: verdict.reason === 'PRAMAAN_DELEGATION_PROOF' ? 'PRAMAAN_DELEGATION_PROOF' : 'NO_VALID_DELEGATION',
          orderId: target.orderId ?? '',
          artifactId: verdict.artifactId ?? null,
          ledgerSeq: rowsAfter.length ? rowsAfter[rowsAfter.length - 1]!.seq : null,
        };
      }
    }
    // no artifact → blocked
    append({
      type: 'ATTEMPT_BLOCKED',
      artifactId: target.artifactId ?? null,
      orderId: target.orderId ?? null,
      amountPaise: target.amountPaise ?? null,
      verdict: 'BLOCK',
      reason: 'NO_VALID_DELEGATION',
    });
    const rowsAfter = readLedger(db);
    return {
      decision: 'BLOCK' as const,
      proof: 'NO_VALID_DELEGATION' as const,
      orderId: target.orderId ?? '',
      artifactId: null,
      ledgerSeq: rowsAfter.length ? rowsAfter[rowsAfter.length - 1]!.seq : null,
    };
  });
}
