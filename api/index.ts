// Pramaan — Vercel serverless entry (Node runtime).
//
// Vercel functions are stateless and ephemeral: no persistent disk. Pramaan's
// ledger is an append-only SQLite file — for the live demo deployment we run
// it on a per-warm-container in-memory ledger (`:memory:`) so the full arc
// (issue → gate → checkout → dispute → evidence → fraud) works exactly as in
// `npm run demo`, while every container cold-start begins a fresh, verifiable
// chain. The hash-chain, the gate, the evidence pack, and the pass-through
// are all pure code paths — identical behavior to the local server.
//
// This is the documented demo deployment mode; the persistent-LEDGER
// production deployment is the Dockerfile (any container host, volume-mounted).

import { buildApp } from '../src/app.js';
import type { AppDeps } from '../src/app.js';
import { generateEd25519KeyPair } from '../src/crypto.js';
import { openLedger, appendLedgerEvent, readLedger, aggregateSpent } from '../src/ledger.js';
import { issueDelegation, verifyArtifact } from '../src/artifact.js';
import { pramaanFraudGate } from '../src/passthrough.js';
import { createRazorpayClient } from '../src/razorpay.js';
import Fastify from 'fastify';
import type { DatabaseSync } from 'node:sqlite';

let cachedApp: ReturnType<typeof buildApp> | null = null;

// Per-warm-container state: one keypair, one in-memory ledger. Cold starts
// mint fresh ones — the demo console re-issues its delegation each session,
// so this matches how the product is actually demonstrated.
const g = globalThis as unknown as {
  __pramaanDb?: DatabaseSync;
  __pramaanKeys?: ReturnType<typeof generateEd25519KeyPair>;
};

function getApp() {
  if (cachedApp) return cachedApp;

  g.__pramaanDb ??= openLedger(':memory:');
  g.__pramaanKeys ??= generateEd25519KeyPair();

  const db = g.__pramaanDb;
  const kp = g.__pramaanKeys;
  const env: Record<string, string | undefined> = {
    ...process.env,
    // Demo deployment: stub payments unless real test keys were set at deploy
    // time (Vercel env vars). The /health endpoint always names the mode.
    PRAMAAN_STUB_PAYMENTS: process.env.RAZORPAY_KEY_ID ? '' : '1',
  };

  const deps: AppDeps = {
    env,
    db,
    dataDir: '/tmp/pramaan-data',
    razorpay: createRazorpayClient({ env }),
    ledger: {
      append: (event) =>
        appendLedgerEvent(db, {
          type: event.type,
          ...(event.artifactId != null ? { artifactId: event.artifactId } : {}),
          ...(event.orderId != null ? { orderId: event.orderId } : {}),
          ...(event.amountPaise != null ? { amountPaise: event.amountPaise } : {}),
          ...(event.verdict != null ? { verdict: event.verdict } : {}),
          ...(event.reason != null ? { reason: event.reason } : {}),
        }),
      read: (artifactId?: string, limit?: number) => {
        let rows = readLedger(db);
        if (artifactId) rows = rows.filter((r) => r.artifactId === artifactId);
        if (typeof limit === 'number' && Number.isInteger(limit) && limit >= 0) rows = rows.slice(-limit);
        return rows;
      },
      aggregateSpent: (artifactId: string) => aggregateSpent(db, artifactId),
    },
    disputes: {
      // /tmp sidecar survives within a warm container; a cold start loses it —
      // the evidence generator's ledger fallback covers that (documented).
      create: (input) => 'dsp_' + Math.random().toString(36).slice(2, 12) + '_' + input.now.replace(/\W/g, '').slice(-6),
    },
    publicKey: kp.publicKey,
    issueDelegation: (input) => issueDelegation(input, kp),
    verifyArtifact: (wire, sig, now) => verifyArtifact(wire, sig, kp.publicKey, now),
    fraudGate: pramaanFraudGate,
    fastify: () => Fastify({ logger: false }),
  };

  cachedApp = buildApp(deps);
  return cachedApp;
}

export default async function handler(req: Request, res: unknown) {
  const app = getApp();
  // Bridge Vercel's Node req/res into Fastify via its built-in handler.
  await app.ready();
  // Vercel Node functions expose the raw IncomingMessage/ServerResponse.
  app.server.emit('request', req, res);
}
