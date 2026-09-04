// Pramaan — canonical JSON + Ed25519 signatures (CONTRACTS.md §1.2, §1.3)
// Trust primitive: every signature and every ledger hash is computed over
// canonicalize() output. Zero npm dependencies — node:crypto only.

import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as nodeSign,
  verify as nodeVerify,
} from 'node:crypto';

export interface Ed25519KeyPair {
  publicKey: string; // base64 (SPKI DER)
  privateKey: string; // base64 (PKCS#8 DER)
}

// ---------------------------------------------------------------------------
// §1.3 Canonical JSON
// ---------------------------------------------------------------------------

/**
 * Canonical JSON per CONTRACTS.md §1.3:
 * - objects: keys sorted lexicographically (UTF-16 code-unit order), recursive
 * - no whitespace between tokens
 * - strings: JSON.stringify escaping (same bytes)
 * - arrays preserve order
 * - idempotent
 * Throws on non-JSON-safe values (undefined, functions, bigint, symbols,
 * circular refs). Callers must stringify bigint paise BEFORE canonicalizing.
 */
export function canonicalize(x: unknown): string {
  return canonValue(x, new WeakSet<object>());
}

function canonValue(x: unknown, seen: WeakSet<object>): string {
  if (x === null) return 'null';
  const t = typeof x;
  switch (t) {
    case 'boolean':
      return x ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(x)) {
        throw new TypeError('canonicalize: non-finite number is not JSON-safe');
      }
      return JSON.stringify(x);
    case 'string':
      return JSON.stringify(x);
    case 'bigint':
      throw new TypeError('canonicalize: bigint is not JSON-safe — stringify paise first');
    case 'undefined':
    case 'symbol':
    case 'function':
      throw new TypeError(`canonicalize: ${t} is not JSON-safe`);
    case 'object':
      break;
    default:
      throw new TypeError(`canonicalize: unsupported type ${t}`);
  }

  const obj = x as Record<string, unknown> | unknown[];
  if (Array.isArray(obj)) {
    if (seen.has(obj)) throw new TypeError('canonicalize: circular reference');
    seen.add(obj);
    const parts = obj.map((v) => canonValue(v, seen));
    seen.delete(obj);
    return `[${parts.join(',')}]`;
  }
  if (obj instanceof Date) {
    throw new TypeError('canonicalize: Date is not JSON-safe — use ISO strings');
  }
  if (seen.has(obj)) throw new TypeError('canonicalize: circular reference');
  seen.add(obj);
  const keys = Object.keys(obj).sort(); // lexicographic, UTF-16 code-unit order
  const parts = keys.map(
    (k) => `${JSON.stringify(k)}:${canonValue((obj as Record<string, unknown>)[k], seen)}`,
  );
  seen.delete(obj);
  return `{${parts.join(',')}}`;
}

// ---------------------------------------------------------------------------
// §1.2 Ed25519
// ---------------------------------------------------------------------------

export function generateEd25519KeyPair(): Ed25519KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
  };
}

/** Sign the CANONICAL form of `payload` with an Ed25519 private key; returns base64 signature. */
export function sign(payload: unknown, privateKeyB64: string): string {
  const key = createPrivateKey({ key: Buffer.from(privateKeyB64, 'base64'), format: 'der', type: 'pkcs8' });
  return nodeSign(null, Buffer.from(canonicalize(payload), 'utf8'), key).toString('base64');
}

/** Verify a base64 Ed25519 signature over the CANONICAL form of `payload`. */
export function verify(payload: unknown, sigB64: string, publicKeyB64: string): boolean {
  try {
    const key = createPublicKey({ key: Buffer.from(publicKeyB64, 'base64'), format: 'der', type: 'spki' });
    return nodeVerify(null, Buffer.from(canonicalize(payload), 'utf8'), key, Buffer.from(sigB64, 'base64'));
  } catch {
    return false; // malformed keys/signatures/payloads fail closed
  }
}
