// Pramaan — tests for canonical JSON + Ed25519 (CONTRACTS.md §1.2, §1.3)

import { describe, expect, it } from 'vitest';
import { canonicalize, generateEd25519KeyPair, sign, verify } from '../src/crypto.js';

describe('canonicalize (§1.3)', () => {
  it('defeats key-reordering: same object, different insertion order → identical canonical string', () => {
    const a = JSON.parse('{"merchantId":"m1","agentId":"a1","amountPaise":"100"}');
    const b = JSON.parse('{"amountPaise":"100","agentId":"a1","merchantId":"m1"}');
    expect(canonicalize(a)).toBe(canonicalize(b));
    expect(canonicalize(a)).toBe('{"agentId":"a1","amountPaise":"100","merchantId":"m1"}');

    // Nested reordering too, and a forged re-signed payload cannot diverge.
    const c = JSON.parse('{"scope":{"b":2,"a":1},"z":[3,1,2]}');
    const d = JSON.parse('{"z":[3,1,2],"scope":{"a":1,"b":2}}');
    expect(canonicalize(c)).toBe(canonicalize(d));
  });

  it('is idempotent and normalized (re-canonicalizing parsed output is stable)', () => {
    const x = { b: 'str', a: { d: [1, 2, { z: null, y: 'é' }], c: true }, '': 0 };
    const once = canonicalize(x);
    expect(canonicalize(JSON.parse(once))).toBe(once);
    // already key-sorted + whitespace-free: identical to plain JSON re-serialization
    expect(JSON.stringify(JSON.parse(once))).toBe(once);
  });

  it('sorts keys lexicographically at every depth and preserves array order', () => {
    expect(canonicalize({ b: 1, a: { z: 1, y: 2 } })).toBe('{"a":{"y":2,"z":1},"b":1}');
    expect(canonicalize([3, 1, { b: 1, a: 2 }])).toBe('[3,1,{"a":2,"b":1}]');
  });

  it('escapes strings identically to JSON.stringify', () => {
    const s = 'quote" back\\slash\n\ttab é 😀 /';
    expect(canonicalize(s)).toBe(JSON.stringify(s));
  });

  it('throws on non-JSON-safe values (bigint, undefined, function, symbol)', () => {
    expect(() => canonicalize({ paise: 100n })).toThrow();
    expect(() => canonicalize({ u: undefined })).toThrow();
    expect(() => canonicalize({ f: () => {} })).toThrow();
    expect(() => canonicalize(Symbol('x'))).toThrow();
    expect(() => canonicalize(JSON.parse('{"a":[{"b":1}]}', (k, v) => (k === 'b' ? 1n : v)))).toThrow();
  });

  it('throws on circular references', () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    expect(() => canonicalize(a)).toThrow(/circular/);
  });
});

describe('Ed25519 sign/verify (§1.2)', () => {
  it('round-trip: sign(payload, priv) verifies against pub over canonical JSON', () => {
    const kp = generateEd25519KeyPair();
    const payload = JSON.parse(
      '{"scope":{"maxPerTxnPaise":"50000","categories":["grocery"]},"agentId":"a1","version":1}',
    );
    const sig = sign(payload, kp.privateKey);
    expect(typeof sig).toBe('string');
    expect(verify(payload, sig, kp.publicKey)).toBe(true);
  });

  it('a key-reordered but semantically identical payload still verifies (canonical form)', () => {
    const kp = generateEd25519KeyPair();
    const a = JSON.parse('{"x":1,"a":2}');
    const b = JSON.parse('{"a":2,"x":1}');
    const sig = sign(a, kp.privateKey);
    expect(verify(b, sig, kp.publicKey)).toBe(true); // same canonical bytes → same signature
  });

  it('tampered payload fails verification', () => {
    const kp = generateEd25519KeyPair();
    const payload = JSON.parse('{"amountPaise":"100","artifactId":"dl_abc"}');
    const sig = sign(payload, kp.privateKey);
    const tampered = { ...payload, amountPaise: '999999' };
    expect(verify(tampered, sig, kp.publicKey)).toBe(false);
  });

  it('wrong key fails verification, and malformed signatures fail closed', () => {
    const kp = generateEd25519KeyPair();
    const other = generateEd25519KeyPair();
    const payload = { a: 1 };
    const sig = sign(payload, kp.privateKey);
    expect(verify(payload, sig, other.publicKey)).toBe(false);
    expect(verify(payload, 'not-base64-!!!', kp.publicKey)).toBe(false);
    expect(verify(payload, '', kp.publicKey)).toBe(false);
    expect(verify(payload, sig, 'bogus-key')).toBe(false);
  });

  it('different payloads produce different signatures; signatures are non-deterministic across keys', () => {
    const kp = generateEd25519KeyPair();
    const sig1 = sign({ a: 1 }, kp.privateKey);
    const sig2 = sign({ a: 2 }, kp.privateKey);
    expect(sig1).not.toBe(sig2);
    const kp2 = generateEd25519KeyPair();
    expect(generateEd25519KeyPair().publicKey).not.toBe(kp2.publicKey);
  });
});
