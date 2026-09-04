// src/routes/fraud.ts — POST /fraud/evaluate (CONTRACTS.md §4 + §6).
//
// Self-contained Fastify plugin. App wiring is S2's job: S2 registers this
// plugin and either passes `deps` (FraudRouteDeps) explicitly or decorates the
// instance with `pramaanDb` (a node:sqlite DatabaseSync). When neither is
// supplied, the plugin lazily imports S1's ledger/artifact and S2's gate at
// request time (so this file typechecks before those modules land) and opens
// the db from PRAMAAN_DB itself.
//
// Ledger policy (route-side, per mission + §8 invariant 4):
//   - RELEASE / RISK_ENGINE_CLEAR  -> NO ledger row (risk-only path, no
//     interposition happened; nothing to evidence).
//   - RELEASE / PRAMAAN_DELEGATION_PROOF -> AGENT_RELEASED row
//     (verdict 'RELEASE', artifactId, amountPaise, orderId if present).
//   - BLOCK -> ATTEMPT_BLOCKED row (verdict 'DENY', reason 'NO_VALID_DELEGATION').
//     Note: every BLOCK from passthrough carries reason NO_VALID_DELEGATION —
//     including the risk-flagged-no-artifact case — because per §6 the ledger
//     reason must name the delegation outcome, not the risk trigger. The risk
//     signals are visible in the request log, not the money ledger.
//
// Never calls Date.now() for gate decisions — `now` is injected via deps.

import type { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { pramaanFraudGate } from '../passthrough.js';
import type { PramaanArtifactInput } from '../passthrough.js';
import type {
  DelegationArtifactWire,
  FraudVerdict,
  LedgerEventType,
  Verdict,
} from '../types.js';

const PAISE_RE = /^\d+$/;

export interface FraudRouteDeps {
  verifyArtifact: (
    wire: unknown,
    sig: string,
    now?: string,
  ) => Promise<{ ok: boolean; reason?: string | undefined }> | { ok: boolean; reason?: string | undefined };
  evaluateGate: (
    wire: unknown,
    tx: unknown,
    now: string,
  ) => Promise<{ ok: boolean; reason?: string | undefined }> | { ok: boolean; reason?: string | undefined };
  aggregateSpent: (artifactId: string) => Promise<bigint> | bigint;
  appendLedgerEvent: (event: {
    type: LedgerEventType;
    artifactId?: string;
    orderId?: string;
    amountPaise?: bigint;
    verdict?: Verdict;
    reason?: string;
  }) => Promise<unknown> | unknown;
  now: () => string;
}

export interface FraudRouteOptions extends FastifyPluginOptions {
  /** Explicit dependency wiring (preferred — S2 passes real modules). */
  deps?: FraudRouteDeps;
  /** A node:sqlite DatabaseSync; used with lazy S1/S2 imports when deps omitted. */
  db?: unknown;
}

/** Lazily import S1/S2 modules via computed specifiers: this file must
 *  typecheck (npx tsc --noEmit) before those modules land. Once landed,
 *  these are the exact contract implementations. */
async function buildLazyDeps(db: unknown): Promise<FraudRouteDeps> {
  const ledgerMod = (await import('../ledger' + '.js')) as Record<string, any>;
  const artifactMod = (await import('../artifact' + '.js')) as Record<string, any>;
  const gateMod = (await import('../gate' + '.js')) as Record<string, any>;

  return {
    verifyArtifact: (wire, sig, now) =>
      now
        ? artifactMod.verifyArtifact(wire, sig, now)
        : artifactMod.verifyArtifact(wire, sig),
    // Bridge the single-purchase tx into S2's cart-shaped gate (§3).
    // Category choice (documented in src/passthrough.ts): if the tx carries no
    // category, evaluate on the artifact's first in-scope category so the
    // gate's category step is neutralized for a single unclassified purchase.
    evaluateGate: (wire, tx, now) => {
      const artifact = artifactMod.artifactFromWire(wire);
      const category =
        (tx as { category?: string }).category ??
        artifact.scope.categories[0];
      if (category === undefined) {
        return { ok: false, reason: 'CATEGORY_OUT_OF_SCOPE' };
      }
      return gateMod.evaluateGate(artifact, {
        merchantId: (tx as { merchantId: string }).merchantId,
        lines: [
          {
            sku: 'fraud-evaluate',
            qty: 1,
            unitPaise: (tx as { amountPaise: bigint }).amountPaise,
            category,
          },
        ],
      }, now, 0n);
    },
    aggregateSpent: (artifactId) => ledgerMod.aggregateSpent(db, artifactId),
    appendLedgerEvent: (event) => ledgerMod.appendLedgerEvent(db, event),
    now: () => new Date().toISOString(),
  };
}

/** Widened accessor for the optional `pramaanDb` decoration S2 may install. */
function getPramaanDb(fastify: FastifyInstance): unknown {
  const withDb = fastify as unknown as Record<string, unknown>;
  return withDb['pramaanDb'];
}

async function resolveDeps(
  fastify: FastifyInstance,
  opts: FraudRouteOptions,
): Promise<FraudRouteDeps> {
  if (opts.deps) return opts.deps;
  const db = opts.db ?? getPramaanDb(fastify);
  if (db !== undefined) return buildLazyDeps(db);
  // Last resort: open the db from env ourselves (route-side I/O is allowed;
  // passthrough stays pure regardless).
  const { DatabaseSync } = await import('node:sqlite');
  const path = process.env['PRAMAAN_DB'] ?? 'data/pramaan.db';
  const dbNew = new DatabaseSync(path);
  dbNew.exec(
    'CREATE TABLE IF NOT EXISTS ledger (' +
      'seq INTEGER PRIMARY KEY, ts TEXT NOT NULL, type TEXT NOT NULL, ' +
      'artifactId TEXT, orderId TEXT, amountPaise TEXT, verdict TEXT, ' +
      'reason TEXT, prevHash TEXT NOT NULL, selfHash TEXT NOT NULL)',
  );
  return buildLazyDeps(dbNew);
}

export async function fraudRoutes(
  fastify: FastifyInstance,
  opts: FraudRouteOptions,
): Promise<void> {
  fastify.post('/fraud/evaluate', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;

    const rawTx = body['transaction'] as Record<string, unknown> | undefined;
    const rawSignals = body['riskSignals'] as Record<string, unknown> | undefined;
    if (!rawTx || !rawSignals) {
      return reply.code(400).send({
        error: 'transaction and riskSignals are required',
      });
    }

    const amountRaw = rawTx['amountPaise'];
    if (typeof amountRaw !== 'string' || !PAISE_RE.test(amountRaw)) {
      return reply.code(400).send({
        error: 'amountPaise must be a non-negative integer string (paise)',
      });
    }

    const tx = {
      merchantId: String(rawTx['merchantId'] ?? ''),
      agentId: String(rawTx['agentId'] ?? ''),
      amountPaise: BigInt(amountRaw),
      ...(rawTx['orderId'] !== undefined
        ? { orderId: String(rawTx['orderId']) }
        : {}),
    };

    const signals = {
      velocityPerMin: Number(rawSignals['velocityPerMin'] ?? 0),
      headless: Boolean(rawSignals['headless']),
      accountAgeDays: Number(rawSignals['accountAgeDays'] ?? 0),
    };

    const wire = body['artifactWire'] as DelegationArtifactWire | undefined;
    const sig = body['sig'] as string | undefined;
    const artifactInput: PramaanArtifactInput | null =
      wire !== undefined && sig !== undefined ? { wire, sig } : null;

    const deps = await resolveDeps(fastify, opts);
    const verdict: FraudVerdict = await pramaanFraudGate(
      tx,
      signals,
      artifactInput,
      {
        // Route dep results may carry free-form reason strings; passthrough
        // only consumes `ok`, so normalize the shape at this boundary.
        verifyArtifact: async (w, s, n) => {
          const r = await deps.verifyArtifact(w, s, n);
          return { ok: r.ok, ...(r.reason !== undefined ? { reason: r.reason } : {}) };
        },
        evaluateGate: async (w, t, n) => {
          const r = await deps.evaluateGate(w, t, n);
          return { ok: r.ok, ...(r.reason !== undefined ? { reason: r.reason } : {}) };
        },
        aggregateSpent: (id) => deps.aggregateSpent(id),
        appendLedgerEvent: (event) => deps.appendLedgerEvent(event),
        now: deps.now(),
      },
    );

    // Route-side ledger discipline (passthrough itself writes nothing).
    if (verdict.action === 'RELEASE') {
      if (verdict.reason === 'PRAMAAN_DELEGATION_PROOF') {
        await deps.appendLedgerEvent({
          type: 'AGENT_RELEASED',
          ...(verdict.artifactId !== undefined ? { artifactId: verdict.artifactId } : {}),
          ...(tx.orderId !== undefined ? { orderId: tx.orderId } : {}),
          amountPaise: tx.amountPaise,
          verdict: 'RELEASE',
          reason: 'PRAMAAN_DELEGATION_PROOF',
        });
      }
      // RISK_ENGINE_CLEAR: no interposition, no ledger row.
    } else {
      await deps.appendLedgerEvent({
        ...(verdict.artifactId ? { artifactId: verdict.artifactId } : {}),
        ...(tx.orderId !== undefined ? { orderId: tx.orderId } : {}),
        amountPaise: tx.amountPaise,
        type: 'ATTEMPT_BLOCKED',
        verdict: 'DENY',
        reason: verdict.reason,
      });
    }

    return reply.code(200).send(
      verdict.artifactId !== undefined
        ? { action: verdict.action, reason: verdict.reason, artifactId: verdict.artifactId }
        : { action: verdict.action, reason: verdict.reason },
    );
  });
}

export default fraudRoutes;
