// Pramaan — HTTP server entrypoint. (S2 RAILS, CONTRACTS.md §4.2)
//
// Loads .env with a plain fs parser (no dotenv dependency), builds the app,
// listens on PRAMAAN_PORT (default 3000), and logs one startup line with mode.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { buildApp } from './app.js';
import { createRazorpayClient, getMode } from './razorpay.js';

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
    const [, key, rest] = m;
    let value = rest.trim();
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

async function main(): Promise<void> {
  // .env values do not override real environment variables.
  const fileEnv = loadEnvFile(join(__dirname, '..', '.env'));
  const env: Record<string, string | undefined> = { ...fileEnv, ...process.env };

  const port = Number(env.PRAMAAN_PORT ?? '3000');

  const app = buildApp({
    fastify: () => Fastify({ logger: false }),
    env,
    razorpay: createRazorpayClient({ env }),
  });

  await app.listen({ port, host: '0.0.0.0' });
  const mode = getMode(env);
  console.log(`pramaan up on :${port} (payments: ${mode})`);
}

main().catch((err) => {
  console.error('pramaan failed to start:', err);
  process.exit(1);
});
