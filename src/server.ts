// Pramaan — HTTP server entrypoint. (Orchestrator, on behalf of S2 RAILS; CONTRACTS.md §4)
//
// Loads .env with a plain fs parser (no dotenv dependency), builds the app,
// listens on PRAMAAN_PORT (default 3000), and logs one startup line with mode.

import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, createPrivateKey, createPublicKey, randomBytes } from 'node:crypto';
import Fastify from 'fastify';
import { buildApp } from './app.js';
import { pramaanFraudGate } from './passthrough.js';
import { createRazorpayClient, getMode, newDisputeId } from './razorpay.js';
import { openLedger, appendLedgerEvent, readLedger, aggregateSpent } from './ledger.js';
import { issueDelegation, verifyArtifact } from './artifact.js';
import type { Signer } from './artifact.js';
import type { DatabaseSync } from 'node:sqlite';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Parse .env content: KEY="value" / KEY='value' / KEY=value lines.
 * Comments (#) and blank lines are skipped. ~20 lines, zero deps.
 */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1] as string;
    let value = (m[2] ?? '').trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function loadEnvFile(path: string): Record<string, string> {
  try {
    return parseEnvFile(readFileSync(path, 'utf8'));
  } catch {
    return {}; // no .env — fine, real env vars may still be set
  }
}

/**
 * Deterministic demo signer from PRAMAAN_SIGNING_SEED, else crypto-random.
 * The seeded path hashes the seed to 32 bytes and wraps them as an Ed25519
 * PKCS8 key (RFC 8410 DER prefix), so the same seed always yields the same
 * identity — reproducible demos, no KMS dependency (documented limitation).
 */
function makeSigner(seed: string | undefined): Signer {
  const raw =
    seed && seed.length > 0
      ? createHash('sha256').update(seed, 'utf8').digest()
      : randomBytes(32);
  const pkcs8 = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), raw]);
  const privateKeyObj = createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
  const publicKeyB64 = createPublicKey(privateKeyObj)
    .export({ format: 'der', type: 'spki' })
    .toString('base64');
  const privateKeyB64 = pkcs8.toString('base64');
  void privateKeyB64; // kept for future export needs; Signer only needs publicKey
  return { publicKey: publicKeyB64, privateKey: pkcs8.toString('base64'), _keyObject: privateKeyObj } as unknown as Signer;
}

async function main(): Promise<void> {
  // .env values do not override real environment variables.
  const fileEnv = loadEnvFile(join(__dirname, '..', '.env'));
  const env: Record<string, string | undefined> = { ...fileEnv, ...process.env };

  const port = Number(env.PRAMAAN_PORT ?? '3000');
  const dbPath = env.PRAMAAN_DB ?? join(__dirname, '..', 'data', 'pramaan.db');
  mkdirSync(dirname(dbPath), { recursive: true });
  const db: DatabaseSync = openLedger(dbPath);

  const signer = makeSigner(env.PRAMAAN_SIGNING_SEED);

  const app = buildApp({
    env,
    db,
    dataDir: dirname(dbPath),
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
      create: (input) => {
        const disputesPath = join(__dirname, '..', 'data', 'disputes.json');
        const rows: unknown[] = existsSync(disputesPath)
          ? (JSON.parse(readFileSync(disputesPath, 'utf8')) as unknown[])
          : [];
        const id = newDisputeId();
        rows.push({
          disputeId: id,
          delegationId: input.delegationId,
          amountPaise: input.amountPaise.toString(),
          reason: input.reason,
          openedAt: input.now,
        });
        mkdirSync(dirname(disputesPath), { recursive: true });
        writeFileSync(disputesPath, JSON.stringify(rows, null, 2) + '\n');
        return id;
      },
    },
    publicKey: signer.publicKey,
    issueDelegation: (input) => issueDelegation(input, signer),
    verifyArtifact: (wire, sig, now) => verifyArtifact(wire, sig, signer.publicKey, now),
    fraudGate: pramaanFraudGate,
    fastify: () => Fastify({ logger: false }),
  });

  await app.listen({ port, host: '0.0.0.0' });
  const mode = getMode(env);
  console.log(`pramaan up on :${port} (payments: ${mode})`);
}

main().catch((err) => {
  console.error('pramaan failed to start:', err);
  process.exit(1);
});
