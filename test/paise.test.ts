// Pramaan — the paise invariant. (S2 RAILS, CONTRACTS.md §8.3)
//
// 1. Grep-style assertions over src/: no money field is typed `number`.
// 2. Round-trip: catalog price × qty in bigint stays exact for huge values.

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import catalogJson from '../catalog.json' with { type: 'json' };

interface CatalogProduct {
  sku: string;
  name: string;
  category: string;
  unitPaise: number; // integer paise in JSON; converted to bigint on load
  description: string;
}

function loadCatalog(): { merchant: { id: string }; products: CatalogProduct[] } {
  return catalogJson as { merchant: { id: string }; products: CatalogProduct[] };
}

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) acc = walk(p, acc);
    else if (p.endsWith('.ts')) acc.push(p);
  }
  return acc;
}

describe('paise invariant', () => {
  it('src/*.ts never types a money field as number', () => {
    const offenders: string[] = [];
    for (const file of walk(join(import.meta.dirname, '..', 'src'))) {
      const text = readFileSync(file, 'utf8');
      const lines = text.split('\n');
      lines.forEach((line, i) => {
        // Any paise-typed field declared as number is a contract violation.
        if (/[Pp]aise\??:\s*number/.test(line)) {
          offenders.push(`${file}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it('catalog prices are integer paise and multiply exactly for huge values', () => {
    const catalog = loadCatalog();
    expect(catalog.merchant.id).toBe('kadai-and-co');
    // Every catalog price must be an integer (safe to widen into bigint).
    for (const item of catalog.products) {
      expect(Number.isInteger(item.unitPaise)).toBe(true);
      expect(item.unitPaise).toBeGreaterThan(0);
    }
    // Round-trip exactness: huge qty × huge unit price.
    const qty = 999_999_999n;
    const unit = 999_999n;
    const total = qty * unit;
    expect(total).toBe(999_998_999_000_001n);
    expect(Number.isSafeInteger(Number(total))).toBe(true); // this magnitude IS float-safe…
    expect(Number.isSafeInteger(Number(9_999_999_999_999_999n))).toBe(false); // …but bigger money is not — hence bigint discipline
    expect(total.toString()).toBe('999998999000001'); // exact through the string boundary

    // Catalog price × qty stays exact too (uses a real catalog price).
    const item = catalog.products[0];
    if (item) {
      const price = BigInt(item.unitPaise);
      const t = price * 7n;
      expect(t % 7n).toBe(0n);
      expect(t).toBe(price + price + price + price + price + price + price);
    }
  });

  it('999999999999n * 7n is exact', () => {
    expect(999_999_999_999n * 7n).toBe(6_999_999_999_993n);
    expect((999_999_999_999n * 7n).toString()).toBe('6999999999993');
    // The float path loses the low digits — bigint does not.
    expect(999_999_999_999_999n * 7n).toBe(6_999_999_999_999_993n);
  });

  it('JSON boundary: ledger rows serialize paise as strings', async () => {
    const { serializeRow } = await import('../src/ledger.js');
    const row = {
      seq: 1,
      ts: '2026-01-01T00:00:00.000Z',
      type: 'ATTEMPT_ALLOWED',
      artifactId: 'd1',
      amountPaise: 123_456_789_012_345n,
      prevHash: 'a'.repeat(64),
      selfHash: 'b'.repeat(64),
    } as const;
    const s = serializeRow(row);
    expect(s.amountPaise).toBe('123456789012345');
    expect(typeof s.amountPaise).toBe('string');
  });
});
