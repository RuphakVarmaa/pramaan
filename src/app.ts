// Pramaan — HTTP app factory (S2 RAILS, CONTRACTS.md §4).
//
// buildApp(deps) wires every route. Business logic stays pure: routes pass an
// explicit `now` (new Date().toISOString()) into pure functions — no hidden
// clock reads inside gate/artifact/ledger logic. Money crosses the JSON
// boundary ONLY as strings.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { evaluateGate } from './gate.js';
import { createRazorpayClient, getMode } from './razorpay.js';
import type { RazorpayClient, RazorpayError } from './razorpay.js';
import { pramaanFraudGate } from './passthrough.js';
import type {
  Cart,
  CartLine,
  DelegationArtifact,
  DelegationArtifactWire,
  GateReason,
  LedgerEventType,
  LedgerRow,
  RiskSignals,
  Verdict,
} from './types.js';
import { artifactToWire } from './types.js';
import type { DatabaseSync } from 'node:sqlite';

// ---------------------------------------------------------------------------
// Ledger seam. S1 owns src/ledger.ts: appendLedgerEvent(db, event) /
// readLedger(db) / aggregateSpent(db, artifactId). app.ts consumes this
// injected port; server.ts wires it to the real functions, tests inject fakes.
// ---------------------------------------------------------------------------

export interface LedgerAppendEvent {
  type: LedgerEventType;
  artifactId?: string | null;
  orderId?: string | null;
  amountPaise?: bigint | null;
  verdict?: Verdict | null;
  reason?: string | null;
}

export interface LedgerPort {
  append(event: LedgerAppendEvent): LedgerRow;
  read(artifactId?: string, limit?: number): LedgerRow[];
  aggregateSpent(artifactId: string): bigint;
}

export interface DisputesPort {
  create(input: { delegationId: string; amountPaise: bigint; reason: string; now: string }): string;
}

export type IssueResult = { artifact: DelegationArtifact; sig: string };

export type VerifyResult =
  | { ok: true; artifact: DelegationArtifact }
  | { ok: false; reason: GateReason };

export interface AppDeps {
  env: Record<string, string | undefined>;
  razorpay: RazorpayClient;
  ledger: LedgerPort;
  disputes: DisputesPort;
  publicKey: string; // Ed25519 public key (base64) — for artifact verifiers
  issueDelegation: (input: {
    merchantId: string;
    agentId: string;
    principal: string;
    scope: { categories: string[]; maxPerTxnPaise: bigint; maxAggregatePaise: bigint; expiresAt: string };
  }) => IssueResult;
  verifyArtifact: (wire: DelegationArtifactWire, sig: string, now: string) => VerifyResult;
  fraudGate: typeof pramaanFraudGate;
  fastify: () => FastifyInstance;
  /** Raw ledger handle + data dir for the evidence generator (S3's module).
   *  Optional so tests that never hit /evidence can omit it. */
  db?: DatabaseSync;
  dataDir?: string;
}

// ---------------------------------------------------------------------------
// serializeRow — paise as strings at the JSON boundary (invariant §8.3).
// ---------------------------------------------------------------------------

export interface SerializedLedgerRow {
  seq: number;
  ts: string;
  type: LedgerEventType;
  artifactId?: string;
  orderId?: string;
  amountPaise?: string;
  verdict?: Verdict;
  reason?: string;
  prevHash: string;
  selfHash: string;
}

export function serializeRow(row: LedgerRow): SerializedLedgerRow {
  const out: SerializedLedgerRow = {
    seq: row.seq,
    ts: row.ts,
    type: row.type,
    prevHash: row.prevHash,
    selfHash: row.selfHash,
  };
  if (row.artifactId !== undefined) out.artifactId = row.artifactId;
  if (row.orderId !== undefined) out.orderId = row.orderId;
  if (row.amountPaise !== undefined) out.amountPaise = row.amountPaise.toString();
  if (row.verdict !== undefined) out.verdict = row.verdict;
  if (row.reason !== undefined) out.reason = row.reason;
  return out;
}

// ---------------------------------------------------------------------------
// Request bodies: paise arrive as strings and are parsed to bigint exactly
// once, at the boundary, before any business logic runs.
// ---------------------------------------------------------------------------

interface WireCartLine { sku: string; qty: number; unitPaise: string; category: string }
interface WireCart { merchantId: string; lines: WireCartLine[] }
interface WireScope { categories: string[]; maxPerTxnPaise: string; maxAggregatePaise: string; expiresAt: string }
interface IssueBody { merchantId: string; agentId: string; principal: string; scope: WireScope }
interface GateOrCheckoutBody { artifactWire: DelegationArtifactWire; sig: string; cart: WireCart }
interface DisputeBody { delegationId: string; amountPaise: string; reason: string }
interface FraudBody {
  transaction: { merchantId: string; agentId: string; amountPaise: string; orderId?: string; category?: string };
  riskSignals: RiskSignals;
  artifactWire?: DelegationArtifactWire;
  sig?: string;
}

function parseCart(w: WireCart): Cart {
  return {
    merchantId: w.merchantId,
    lines: w.lines.map((l): CartLine => ({
      sku: l.sku,
      category: l.category,
      qty: l.qty,
      unitPaise: BigInt(l.unitPaise),
    })),
  };
}

function bigintField(value: string | undefined, name: string): bigint {
  if (value === undefined || value === null || value === '') {
    throw new BadInput(`${name} is required (integer paise as string)`);
  }
  try {
    return BigInt(value);
  } catch {
    throw new BadInput(`${name} must be an integer paise string`);
  }
}

class BadInput extends Error {}

const CATALOG_JSON = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'catalog.json'),
  'utf8',
);

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = deps.fastify();
  const paymentsMode = getMode(deps.env);

  // The ONLY clock read in the app, at the route layer — handed to pure fns.
  const now = () => new Date().toISOString();

  app.get('/health', async () => ({
    ok: true,
    service: 'pramaan',
    ts: now(),
    paymentsMode,
  }));

  app.get('/keys', async () => ({ publicKey: deps.publicKey }));

  app.get('/catalog', async (_req, reply) => {
    reply.header('content-type', 'application/json');
    return reply.send(CATALOG_JSON);
  });

  // POST /delegations — 201 { artifactId, artifact, sig } + DELEGATION_ISSUED row
  app.post('/delegations', async (req, reply) => {
    const body = req.body as IssueBody;
    if (!body?.merchantId || !body?.agentId || !body?.principal || !body?.scope) {
      return reply.code(400).send({ error: 'invalid_request', reason: 'merchantId, agentId, principal, scope required' });
    }
    let issued: IssueResult;
    try {
      issued = deps.issueDelegation({
        merchantId: body.merchantId,
        agentId: body.agentId,
        principal: body.principal,
        scope: {
          categories: body.scope.categories,
          maxPerTxnPaise: bigintField(body.scope.maxPerTxnPaise, 'scope.maxPerTxnPaise'),
          maxAggregatePaise: bigintField(body.scope.maxAggregatePaise, 'scope.maxAggregatePaise'),
          expiresAt: body.scope.expiresAt,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'invalid scope';
      return reply.code(400).send({ error: 'invalid_scope', reason: message });
    }
    deps.ledger.append({
      type: 'DELEGATION_ISSUED',
      artifactId: issued.artifact.artifactId,
      verdict: 'ALLOW',
      reason: null,
    });
    return reply.code(201).send({
      artifactId: issued.artifact.artifactId,
      artifact: artifactToWire(issued.artifact),
      sig: issued.sig,
    });
  });

  // POST /gate — pure evaluation, 200, NO side effects
  app.post('/gate', async (req, reply) => {
    const body = req.body as GateOrCheckoutBody;
    if (!body?.artifactWire || !body?.sig || !body?.cart) {
      return reply.code(400).send({ error: 'invalid_request', reason: 'artifactWire, sig, cart required' });
    }
    const t = now();
    const v = deps.verifyArtifact(body.artifactWire, body.sig, t);
    if (!v.ok) {
      return reply.code(403).send({ error: 'invalid_artifact', reason: v.reason });
    }
    const verdict = evaluateGate({
      artifact: v.artifact,
      cart: parseCart(body.cart),
      now: t,
      aggregateSpentPaise: deps.ledger.aggregateSpent(body.artifactWire.artifactId),
    });
    return reply.code(200).send({
      allowed: verdict.allowed,
      ...(verdict.reason !== undefined ? { reason: verdict.reason } : {}),
      totalPaise: verdict.totalPaise.toString(),
      aggregateAfterPaise: verdict.aggregateAfterPaise.toString(),
    });
  });

  // POST /checkout — verify -> gate -> createOrder -> ATTEMPT_ALLOWED
  app.post('/checkout', async (req, reply) => {
    const body = req.body as GateOrCheckoutBody;
    if (!body?.artifactWire || !body?.sig || !body?.cart) {
      return reply.code(400).send({ error: 'invalid_request', reason: 'artifactWire, sig, cart required' });
    }
    const t = now();
    const v = deps.verifyArtifact(body.artifactWire, body.sig, t);
    if (!v.ok) {
      // NO payment without a valid artifact: no order, no ATTEMPT_ALLOWED row.
      deps.ledger.append({
        type: 'ATTEMPT_BLOCKED',
        artifactId: body.artifactWire?.artifactId ?? null,
        verdict: 'BLOCK',
        reason: v.reason,
      });
      return reply.code(403).send({ error: 'invalid_artifact', reason: v.reason });
    }
    const artifact = v.artifact;
    const spent = deps.ledger.aggregateSpent(artifact.artifactId);
    const verdict = evaluateGate({
      artifact,
      cart: parseCart(body.cart),
      now: t,
      aggregateSpentPaise: spent,
    });

    if (!verdict.allowed) {
      deps.ledger.append({
        type: 'ATTEMPT_BLOCKED',
        artifactId: artifact.artifactId,
        verdict: 'BLOCK',
        reason: verdict.reason ?? null,
      });
      return reply.code(403).send({
        error: 'gate_blocked',
        reason: verdict.reason,
        totalPaise: verdict.totalPaise.toString(),
      });
    }

    // Gate passed — attempt the provider order (paise never become floats).
    try {
      const order = await deps.razorpay.createOrder({
        amountPaise: verdict.totalPaise,
        receipt: artifact.artifactId,
        notes: {
          artifactId: artifact.artifactId,
          agentId: artifact.agentId,
          merchantId: artifact.merchantId,
        },
      });
      deps.ledger.append({
        type: 'ATTEMPT_ALLOWED',
        artifactId: artifact.artifactId,
        orderId: order.orderId,
        amountPaise: verdict.totalPaise,
        verdict: 'ALLOW',
        reason: null,
      });
      // Capture is recorded with the payment mode named in the reason — in
      // stub mode the order IS the capture (no webhook); in live test mode a
      // production build would land here from the payment.captured webhook
      // instead (documented limitation in README).
      deps.ledger.append({
        type: 'PAYMENT_CAPTURED',
        artifactId: artifact.artifactId,
        orderId: order.orderId,
        amountPaise: order.amountPaise,
        verdict: 'ALLOW',
        reason: `captured (${paymentsMode})`,
      });
      return reply.code(200).send({
        orderId: order.orderId,
        amountPaise: order.amountPaise.toString(),
        receipt: artifact.artifactId,
        status: order.status,
      });
    } catch (err) {
      deps.ledger.append({
        type: 'ATTEMPT_BLOCKED',
        artifactId: artifact.artifactId,
        verdict: 'BLOCK',
        reason: 'PAYMENT_PROVIDER_ERROR',
      });
      const rzp = err as Partial<RazorpayError>;
      return reply.code(502).send({
        error: 'payment_provider_error',
        reason: 'PAYMENT_PROVIDER_ERROR',
        ...(rzp.status !== undefined ? { providerStatus: rzp.status } : {}),
      });
    }
  });

  // POST /disputes — data/disputes.json sidecar + DISPUTE_OPENED row; 201
  app.post('/disputes', async (req, reply) => {
    const body = req.body as DisputeBody;
    if (!body?.delegationId || body?.amountPaise === undefined || !body?.reason) {
      return reply.code(400).send({ error: 'invalid_request', reason: 'delegationId, amountPaise, reason required' });
    }
    let amountPaise: bigint;
    try {
      amountPaise = bigintField(body.amountPaise, 'amountPaise');
    } catch (err) {
      return reply.code(400).send({ error: 'invalid_request', reason: (err as Error).message });
    }
    const t = now();
    const disputeId = deps.disputes.create({
      delegationId: body.delegationId,
      amountPaise,
      reason: body.reason,
      now: t,
    });
    deps.ledger.append({
      type: 'DISPUTE_OPENED',
      artifactId: body.delegationId,
      amountPaise,
      verdict: null,
      reason: body.reason,
    });
    return reply.code(201).send({ disputeId });
  });

  // GET /evidence/:delegationId?disputeId= — S3's forensic dossier, wired.
  app.get('/evidence/:delegationId', async (req, reply) => {
    const params = req.params as { delegationId: string };
    const query = req.query as { disputeId?: string };
    if (!deps.db) {
      return reply.code(501).send({
        error: 'not_configured',
        reason: 'evidence generator needs the raw db handle (AppDeps.db) — see src/app.ts',
      });
    }
    const { generateEvidencePack, appendEvidenceGenerated } = await import('./evidence.js');
    const pack = generateEvidencePack(deps.db, params.delegationId, query.disputeId ?? null, {
      ...(deps.dataDir !== undefined ? { dataDir: deps.dataDir } : {}),
      now: now(),
    });
    appendEvidenceGenerated(deps.db, params.delegationId, pack.sha256);
    reply.header('content-type', 'text/html; charset=utf-8');
    return reply.send(pack.html);
  });

  // POST /fraud/evaluate — S4's src/passthrough.ts (landed; wired for real).
  app.post('/fraud/evaluate', async (req, reply) => {
    const body = req.body as FraudBody;
    if (!body?.transaction || !body?.riskSignals) {
      return reply.code(400).send({ error: 'invalid_request', reason: 'transaction and riskSignals required' });
    }
    let amountPaise: bigint;
    try {
      amountPaise = bigintField(body.transaction.amountPaise, 'transaction.amountPaise');
    } catch (err) {
      return reply.code(400).send({ error: 'invalid_request', reason: (err as Error).message });
    }
    const t = now();
    const wire = body.artifactWire;
    const sig = body.sig;
    const tx = {
      merchantId: body.transaction.merchantId,
      agentId: body.transaction.agentId,
      amountPaise,
      ...(body.transaction.orderId !== undefined ? { orderId: body.transaction.orderId } : {}),
      ...(body.transaction.category !== undefined ? { category: body.transaction.category } : {}),
    };
    const verdict = await deps.fraudGate(
      tx,
      body.riskSignals,
      wire && sig ? { wire, sig } : null,
      {
        now: t,
        verifyArtifact: (w, s, n) => {
          const r = deps.verifyArtifact(w, s, n ?? t);
          return r.ok ? { ok: true } : { ok: false, reason: r.reason };
        },
        evaluateGate: (w, transaction, n) => {
          // Bridge S4's single-tx shape to the cart gate. A tx without a
          // category is evaluated on a synthetic line whose category is
          // trivially in-scope — see passthrough.ts header note (the
          // documented choice: an absent category must not manufacture a
          // denial the issuer never expressed).
          const syntheticCategory =
            transaction.category !== undefined ? transaction.category : '__in_scope__';
          const g = evaluateGate({
            artifact: {
              version: 1,
              artifactId: w.artifactId,
              merchantId: w.merchantId,
              agentId: w.agentId,
              principal: w.principal,
              scope: {
                categories:
                  transaction.category !== undefined
                    ? [...w.scope.categories]
                    : [...w.scope.categories, syntheticCategory],
                maxPerTxnPaise: BigInt(w.scope.maxPerTxnPaise),
                maxAggregatePaise: BigInt(w.scope.maxAggregatePaise),
                expiresAt: w.scope.expiresAt,
              },
              issuedAt: w.issuedAt,
              nonce: w.nonce,
            },
            cart: {
              merchantId: transaction.merchantId,
              lines: [{ sku: 'fraud-eval', category: syntheticCategory, qty: 1, unitPaise: transaction.amountPaise }],
            },
            now: n,
            // aggregate is enforced upstream at (c4) with the real spend sum
            aggregateSpentPaise: 0n,
          });
          return g.allowed
            ? { ok: true as const }
            : { ok: false as const, reason: g.reason ?? 'GATE_UNSPECIFIED' };
        },
        aggregateSpent: (artifactId) => deps.ledger.aggregateSpent(artifactId),
        appendLedgerEvent: (event) =>
          deps.ledger.append({
            type: event.type,
            artifactId: event.artifactId ?? null,
            orderId: event.orderId ?? null,
            amountPaise: event.amountPaise ?? null,
            verdict: event.verdict ?? null,
            reason: event.reason ?? null,
          }),
      },
    );
    if (verdict.action === 'RELEASE' && verdict.reason === 'PRAMAAN_DELEGATION_PROOF') {
      deps.ledger.append({
        type: 'AGENT_RELEASED',
        artifactId: verdict.artifactId ?? null,
        amountPaise,
        verdict: 'RELEASE',
        reason: 'PRAMAAN_DELEGATION_PROOF',
      });
    }
    return reply.code(200).send({
      action: verdict.action,
      reason: verdict.reason,
      ...(verdict.artifactId !== undefined ? { artifactId: verdict.artifactId } : {}),
    });
  });

  // GET /ledger?limit=&artifactId= — rows in seq order, paise as strings
  app.get('/ledger', async (req) => {
    const q = req.query as { limit?: string; artifactId?: string };
    const limit = q.limit !== undefined && q.limit !== '' ? Number(q.limit) : undefined;
    const rows = deps.ledger.read(q.artifactId, limit);
    return { rows: rows.map(serializeRow) };
  });

  return app;
}
