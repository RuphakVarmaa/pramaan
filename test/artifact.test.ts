// Pramaan — tests for delegation artifact issue/verify (CONTRACTS.md §1)

import { describe, expect, it } from 'vitest';
import { issueDelegation, verifyArtifact } from '../src/artifact.js';
import { generateEd25519KeyPair } from '../src/crypto.js';
import type { DelegationArtifactWire, LedgerRow } from '../src/types.js';
import { artifactToWire } from '../src/types.js';

const signer = generateEd25519KeyPair();

const VALID_SCOPE = {
  categories: ['grocery', 'pharmacy'],
  maxPerTxnPaise: 500_00n,
  maxAggregatePaise: 5_000_00n,
  expiresAt: '2030-01-01T00:00:00.000Z',
};

const NOW = '2026-09-04T12:00:00.000Z';

describe('issueDelegation', () => {
  it('mints a spec-shaped artifact and a verifiable signature', () => {
    const { artifact, sig } = issueDelegation(
      { merchantId: 'm1', agentId: 'a1', principal: 'user-42', scope: VALID_SCOPE },
      signer,
    );
    expect(artifact.artifactId).toMatch(/^dl_[0-9a-f]{24}$/);
    expect(artifact.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(artifact.version).toBe(1);
    expect(artifact.scope.maxPerTxnPaise).toBe(500_00n);
    expect(artifact.issuedAt).toBeTruthy();
    expect(typeof sig).toBe('string');

    const res = verifyArtifact(artifactToWire(artifact), sig, signer.publicKey, NOW);
    expect(res).toMatchObject({ ok: true, artifact: { artifactId: artifact.artifactId } });
  });

  it('mints unique artifactIds and nonces', () => {
    const input = { merchantId: 'm1', agentId: 'a1', principal: 'u', scope: VALID_SCOPE };
    const r1 = issueDelegation(input, signer);
    const r2 = issueDelegation(input, signer);
    expect(r1.artifact.artifactId).not.toBe(r2.artifact.artifactId);
    expect(r1.artifact.nonce).not.toBe(r2.artifact.nonce);
  });

  it('rejects invalid inputs (empty categories, non-positive caps, bad ISO, past expiry)', () => {
    const base = { merchantId: 'm1', agentId: 'a1', principal: 'u' };
    expect(() =>
      issueDelegation({ ...base, scope: { ...VALID_SCOPE, categories: [] } }, signer),
    ).toThrow();
    expect(() =>
      issueDelegation({ ...base, scope: { ...VALID_SCOPE, maxPerTxnPaise: 0n } }, signer),
    ).toThrow();
    expect(() =>
      issueDelegation({ ...base, scope: { ...VALID_SCOPE, maxAggregatePaise: -1n } }, signer),
    ).toThrow();
    expect(() =>
      issueDelegation({ ...base, scope: { ...VALID_SCOPE, expiresAt: 'not-a-date' } }, signer),
    ).toThrow();
    expect(() =>
      issueDelegation(
        { ...base, scope: { ...VALID_SCOPE, expiresAt: '2020-01-01T00:00:00.000Z' } },
        signer,
      ),
    ).toThrow(); // expiresAt must be > issuedAt(now)
  });
});

describe('verifyArtifact', () => {
  it('issue → verify round-trip succeeds', () => {
    const { artifact, sig } = issueDelegation(
      { merchantId: 'm1', agentId: 'a1', principal: 'user-42', scope: VALID_SCOPE },
      signer,
    );
    const res = verifyArtifact(artifactToWire(artifact), sig, signer.publicKey, NOW);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.artifact.artifactId).toBe(artifact.artifactId);
      expect(res.artifact.scope.maxAggregatePaise).toBe(VALID_SCOPE.maxAggregatePaise);
      expect(res.artifact.scope.categories).toEqual(VALID_SCOPE.categories);
    }
  });

  it('expired artifact → { ok: false, reason: ARTIFACT_EXPIRED }', () => {
    const { artifact, sig } = issueDelegation(
      { merchantId: 'm1', agentId: 'a1', principal: 'u', scope: { ...VALID_SCOPE, expiresAt: '2026-09-05T00:00:00.000Z' } },
      signer,
    );
    const later = '2026-09-06T00:00:00.000Z';
    const res = verifyArtifact(artifactToWire(artifact), sig, signer.publicKey, later);
    expect(res).toEqual({ ok: false, reason: 'ARTIFACT_EXPIRED' });
  });

  it('bad signature → { ok: false, reason: SIGNATURE_INVALID }', () => {
    const { artifact, sig } = issueDelegation(
      { merchantId: 'm1', agentId: 'a1', principal: 'u', scope: VALID_SCOPE },
      signer,
    );
    const wire = artifactToWire(artifact);

    // Corrupted signature bytes
    const flipped = sig.slice(0, -2) + (sig.endsWith('AA') ? 'BB' : 'AA');
    expect(verifyArtifact(wire, flipped, signer.publicKey, NOW)).toEqual({
      ok: false,
      reason: 'SIGNATURE_INVALID',
    });

    // Signature from a different key
    const other = generateEd25519KeyPair();
    expect(verifyArtifact(wire, sig, other.publicKey, NOW)).toEqual({
      ok: false,
      reason: 'SIGNATURE_INVALID',
    });

    // Tampered payload (cap raised after signing)
    const forged: DelegationArtifactWire = {
      ...wire,
      scope: { ...wire.scope, maxAggregatePaise: '99999999999' },
    };
    expect(verifyArtifact(forged, sig, signer.publicKey, NOW)).toEqual({
      ok: false,
      reason: 'SIGNATURE_INVALID',
    });
  });

  it('structurally invalid wires fail closed with SIGNATURE_INVALID', () => {
    const { artifact, sig } = issueDelegation(
      { merchantId: 'm1', agentId: 'a1', principal: 'u', scope: VALID_SCOPE },
      signer,
    );
    const wire = artifactToWire(artifact);
    const cases: DelegationArtifactWire[] = [
      { ...wire, artifactId: 'not-dl-id' },
      { ...wire, scope: { ...wire.scope, categories: [] } },
      { ...wire, scope: { ...wire.scope, maxPerTxnPaise: '0' } },
      { ...wire, scope: { ...wire.scope, maxAggregatePaise: '-5' } },
      { ...wire, scope: { ...wire.scope, expiresAt: 'yesterday' } },
      { ...wire, nonce: 'deadbeef' }, // wrong length
    ];
    for (const bad of cases) {
      expect(verifyArtifact(bad, sig, signer.publicKey, NOW)).toEqual({
        ok: false,
        reason: 'SIGNATURE_INVALID',
      });
    }
  });

  it('expiry boundary: expiresAt == now is still valid (strict < per §1.5)', () => {
    // expiresAt in the future relative to real now (so issuance validates),
    // verified at a `now` exactly equal to expiresAt → still valid.
    const future = new Date(Date.now() + 60_000).toISOString();
    const { artifact, sig } = issueDelegation(
      { merchantId: 'm1', agentId: 'a1', principal: 'u', scope: { ...VALID_SCOPE, expiresAt: future } },
      signer,
    );
    const res = verifyArtifact(artifactToWire(artifact), sig, signer.publicKey, future);
    expect(res.ok).toBe(true);
    // one ms later it is expired
    const later = new Date(Date.parse(future) + 1).toISOString();
    expect(verifyArtifact(artifactToWire(artifact), sig, signer.publicKey, later)).toEqual({
      ok: false,
      reason: 'ARTIFACT_EXPIRED',
    });
  });
});

// keep type imports referenced (artifact wire vs ledger row shapes stay distinct)
export type _WireShapeGuard = DelegationArtifactWire & { __row?: LedgerRow };
