// Pramaan — HTTP app factory. (S2 RAILS, CONTRACTS.md §4)
//
// buildApp(deps) wires every route. Business logic stays pure: routes pass an
// explicit `now` (new Date().toISOString()) into pure functions — no hidden
// clock reads inside gate/artifact/ledger logic.
//
// Money crosses the JSON boundary ONLY as strings (serializeRow / bigintsToStr).

import type { FastifyInstance } from 'fastify';
import { evaluateGate } from './gate.js';
import { createRazorpayClient, getMode, isStubMode } from './razorpay.js';
import type { RazorpayClient, RazorpayError } from './razorpay.js';
import type { AppDeps, LedgerRow, LedgerDeps, SignerDeps } from './types.js';

export { serializeRow } from './ledger.js';

// ---------------------------------------------------------------------------
// /evidence and /fraud/evaluate delegate to S3/S4 modules. Import points are
// kept here, clearly marked. Until those land, routes answer 501.
// ---------------------------------------------------------------------------
// import { renderEvidencePack } from './evidence.js';        // S3
// import { evaluateFraud } from './passthrough.js';          // S4

export interface AppEnv {
  env: Record<string, string | undefined>;
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = deps.fastify();

  const paymentsMode = getMode(deps.env ?? {});
  const razorpay: RazorpayClient =
    deps.razorpay ?? createRazorpayClient({ env: deps.env ?? {} });

  // -------------------------------------------------------------------------
  // GET /health
  // -------------------------------------------------------------------------
  app.get('/health', async () => {
    return { ok: true, service: 'pramaan', ts: new Date().toISOString(), paymentsMode };
  });

  // -------------------------------------------------------------------------
  // GET /keys — Ed25519 public key (base64) of the signer
  // -------------------------------------------------------------------------
  app.get('/keys', async () => {
    const publicKey = deps.signer.getPublicKeyBase64();
    return { publicKey };
  });

  // -------------------------------------------------------------------------
  // GET /catalog — verbatim catalog.json contents
  // -------------------------------------------------------------------------
  app.get('/catalog', async () => deps.catalog);

  // -------------------------------------------------------------------------
  // POST /delegations — issue artifact + DELEGATION_ISSUED row. 201.
  // -------------------------------------------------------------------------
  app.post('/delegations', async (req, reply) => {
    const now = new Date().toISOString();
    const body = req.body as IssueDelegationBody;
    // Minimal input validation: agent + principal identity strings.
    if (!body || typeof body.agentId !== 'string' || typeof body.principalId !== 'string') {
      return reply.code(400).send({ error: 'invalid_request', reason: 'agentId and principalId required' });
    }
    const artifact = deps.artifact.issueArtifact({
      agentId: body.agentId,
      principalId: body.principalId,
      scope: body.scope,
      now,
    });
    const row = deps.ledger.append({
      type: 'DELEGATION_ISSUED',
      delegationId: artifact.delegationId,
      now,
      artifactJson: JSON.stringify(artifact),
    });
    return reply.code(201).send(serializeArtifactResponse(artifact));
  });

  // -------------------------------------------------------------------------
  // POST /gate — verify artifact signature + evaluate. 200, no side effects.
  // -------------------------------------------------------------------------
  app.post('/gate', async (req, reply) => {
    const now = new Date().toISOString();
    const body = req.body as GateRequestBody;
    if (!body || typeof body.artifactJson !== 'string' || !body.cart) {
      return reply.code(400).send({ error: 'invalid_request', reason: 'artifactJson and cart required' });
    }
    let artifact;
    try {
      artifact = JSON.parse(body.artifactJson) as unknown;
    } catch {
      return reply.code(400).send({ error: 'invalid_artifact', reason: 'artifactJson is not valid JSON' });
    }
    const verified = deps.artifact.verifyArtifact(artifact, now);
    if (!verified.ok) {
      return reply.code(403).send({ error: 'invalid_artifact', reason: verified.reason });
    }
    const a = verified.artifact;
    const aggregateSpentPaise = deps.ledger.getAggregateSpentPaise(a.delegationId);
    const verdict = evaluateGate({
      artifact: a,
      cart: parseCart(body.cart),
      now,
      aggregateSpentPaise,
    });
    return reply
      .code(200)
      .send({
        allowed: verdict.allowed,
        ...(verdict.allowed ? {} : { reason: verdict.reason }),
        totalPaise: verdict.totalPaise.toString(),
        aggregateAfterPaise: verdict.aggregateAfterPaise.toString(),
      });
  });

  // -------------------------------------------------------------------------
  // POST /checkout — verify -> gate -> createOrder -> ATTEMPT_ALLOWED
  //                    blocked -> 403 + ATTEMPT_BLOCKED
  //                    provider error -> 502 + ATTEMPT_BLOCKED 'PAYMENT_PROVIDER_ERROR'
  // -------------------------------------------------------------------------
  app.post('/checkout', async (req, reply) => {
    const now = new Date().toISOString();
    const body = req.body as GateRequestBody;
    if (!body || typeof body.artifactJson !== 'string' || !body.cart) {
      return reply.code(400).send({ error: 'invalid_request', reason: 'artifactJson and cart required' });
    }
    let artifact;
    try {
      artifact = JSON.parse(body.artifactJson) as unknown;
    } catch {
      return reply.code(400).send({ error: 'invalid_artifact', reason: 'artifactJson is not valid JSON' });
    }
    const verified = deps.artifact.verifyArtifact(artifact, now);
    if (!verified.ok) {
      // No payment without a valid artifact. No order, no ATTEMPT_ALLOWED row.
      deps.ledger.append({
        type: 'ATTEMPT_BLOCKED',
        delegationId: verified.delegationId ?? null,
        now,
        reason: verified.reason,
      });
      return reply.code(403).send({ error: 'invalid_artifact', reason: verified.reason });
    }
    const a = verified.artifact;
    const cart = parseCart(body.cart);
    const aggregateSpentPaise = deps.ledger.getAggregateSpentPaise(a.delegationId);
    const verdict = evaluateGate({ artifact: a, cart, now, aggregateSpentPaise });

    if (!verdict.allowed) {
      deps.ledger.append({
        type: 'ATTEMPT_BLOCKED',
        delegationId: a.delegationId,
        now,
        reason: verdict.reason,
      });
      return reply.code(403).send({
        error: 'gate_blocked',
        reason: verdict.reason,
        totalPaise: verdict.totalPaise.toString(),
      });
    }

    // Gate passed — attempt the provider order.
    const receipt = `pramaan:${a.delegationId}:${now}`;
    try {
      const order = await razorpay.createOrder({
        amountPaise: verdict.totalPaise,
        receipt,
        notes: { delegationId: a.delegationId, agentId: a.agentId, merchantId: a.merchantId },
      });
      deps.ledger.append({
        type: 'ATTEMPT_ALLOWED',
        delegationId: a.delegationId,
        now,
        reason: null,
        orderId: order.id,
        amountPaise: verdict.totalPaise,
      });
      return reply.code(200).send({
        ok: true,
        order: {
          id: order.id,
          amountPaise: BigInt(order.amount).toString(),
          currency: order.currency,
          receipt: order.receipt,
          status: order.status,
        },
        delegationId: a.delegationId,
        totalPaise: verdict.totalPaise.toString(),
      });
    } catch (err) {
      deps.ledger.append({
        type: 'ATTEMPT_BLOCKED',
        delegationId: a.delegationId,
        now,
        reason: 'PAYMENT_PROVIDER_ERROR',
      });
      const rerr = err as Partial<RazorpayError>;
      return reply.code(502).send({
        error: 'payment_provider_error',
        reason: 'PAYMENT_PROVIDER_ERROR',
        ...(rerr?.status !== undefined ? { providerStatus: rerr.status } : {}),
      });
    }
  });

  // -------------------------------------------------------------------------
  // POST /disputes — data/disputes.json sidecar + DISPUTE_OPENED row. 201.
  // -------------------------------------------------------------------------
  app.post('/disputes', async (req, reply) => {
    const now = new Date().toISOString();
    const body = req.body as DisputeBody;
    if (!body || typeof body.delegationId !== 'string' || !body.claim) {
      return reply.code(400).send({ error: 'invalid_request', reason: 'delegationId and claim required' });
    }
    const disputeId = deps.disputes.create({
      delegationId: body.delegationId,
      claim: body.claim,
      now,
    });
    deps.ledger.append({
      type: 'DISPUTE_OPENED',
      delegationId: body.delegationId,
      now,
      disputeId,
    });
    return reply.code(201).send({ disputeId });
  });

  // -------------------------------------------------------------------------
  // GET /evidence/:delegationId?disputeId= — S3's src/evidence.ts.
  // -------------------------------------------------------------------------
  app.get('/evidence/:delegationId', async (req, reply) => {
    const params = req.params as { delegationId: string };
    const query = req.query as { disputeId?: string };
    // TODO(S3): delegate to src/evidence.ts renderEvidencePack once it lands.
    void params;
    void query;
    return reply.code(501).send({ error: 'not_implemented', reason: 'evidence module not yet landed (S3)' });
  });

  // -------------------------------------------------------------------------
  // POST /fraud/evaluate — S4's src/passthrough.ts.
  // -------------------------------------------------------------------------
  app.post('/fraud/evaluate', async (_req, reply) => {
    // TODO(S4): delegate to src/passthrough.ts evaluateFraud once it lands.
    return reply.code(501).send({ error: 'not_implemented', reason: 'fraud module not yet landed (S4)' });
  });

  // -------------------------------------------------------------------------
  // GET /ledger?limit=&artifactId= — rows in seq order, paise as strings.
  // -------------------------------------------------------------------------
  app.get('/ledger', async (req) => {
    const q = req.query as { limit?: string; artifactId?: string };
    const limit = q.limit ? Math.max(0, Number(q.limit)) : undefined;
    if (q.limit !== undefined && (!Number.isFinite(limit) || limit < 0)) {
      return { rows: [], error: 'invalid limit' };
    }
    const rows = deps.ledger.query({
      limit,
      artifactId: q.artifactId,
    });
    return { rows: rows.map(serializeRow) };
  });

  return app;
}

function parseCart(c: CartBody): Cart {
  return {
    merchantId: c.merchantId,
    lines: c.lines.map((l) => ({
      sku: l.sku,
      category: l.category,
      qty: l.qty,
      unitPaise: BigInt(l.unitPaise),
    })),
  };
}
