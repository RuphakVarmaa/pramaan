// scripts/gen-batch.ts — seeded scenario corpus generator (swarm S5; CONTRACTS.md §9).
//
// Generates the 60-scenario held-out batch deterministically with mulberry32
// (seed committed in metrics/report.json; the same seed reproduces the same
// corpus — the runner re-derives everything from this module, no stored
// corpus). Composition is frozen by CONTRACTS.md §9:
//
//   25 in-scope purchase scenarios      -> must end PAYMENT_CAPTURED
//   15 out-of-scope purchase scenarios  -> must end blocked with a reason code
//   10 disputed scenarios               -> dispute -> evidence pack (timed)
//    5 flagged-legit pass-through      -> must end AGENT_RELEASED
//    5 flagged-malicious pass-through   -> must end blocked
//
// Nothing here is tuned to flatter numbers: the PRNG drives carts, caps, and
// expiry windows from the real catalog (catalog.json), and the out-of-scope
// generator picks its violation with a uniform draw — including paths that
// genuinely pass (expired artifacts in the future, cap edges that land
// exactly on the boundary). What comes out is what gets reported.
//
// Money: bigint paise in-process, strings at the JSON boundary (§8.3).

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// PRNG — mulberry32, no Math.random anywhere in the batch path
// ---------------------------------------------------------------------------

/** mulberry32: 32-bit seeded PRNG. Returns floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Default batch seed. Committed; stated in the report; reproducible. */
export const BATCH_SEED = 20260904;

// ---------------------------------------------------------------------------
// catalog
// ---------------------------------------------------------------------------

export interface CatalogProduct {
  sku: string;
  name: string;
  category: string;
  unitPaise: bigint;
}

export interface Catalog {
  merchantId: string;
  categories: string[];
  products: CatalogProduct[];
}

/** Repo root, robust to running from dist/scripts (tsconfig copies nothing,
 *  but build output lives in dist/ — walk up until package.json + catalog.json). */
export function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'catalog.json'))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('repoRoot: could not locate the pramaan repo root (package.json + catalog.json)');
}

export function loadCatalog(from?: string): Catalog {
  const path = from ?? join(repoRoot(), 'catalog.json');
  const raw: {
    merchant: { id: string; categories: string[] };
    products: { sku: string; name: string; category: string; unitPaise: number }[];
  } = JSON.parse(readFileSync(path, 'utf8'));
  return {
    merchantId: raw.merchant.id,
    categories: [...raw.merchant.categories],
    products: raw.products.map((p) => ({
      sku: p.sku,
      name: p.name,
      category: p.category,
      // JSON numbers are safe here: the catalog stores exact integers well
      // below Number.MAX_SAFE_INTEGER; BigInt() keeps the value exact from
      // here on. (Parsing, not arithmetic.)
      unitPaise: BigInt(p.unitPaise),
    })),
  };
}

// ---------------------------------------------------------------------------
// scenario types
// ---------------------------------------------------------------------------

export type OutOfScopeKind =
  | 'CATEGORY_OUT_OF_SCOPE'
  | 'CAP_EXCEEDED_PER_TXN'
  | 'CAP_EXCEEDED_AGGREGATE'
  | 'ARTIFACT_EXPIRED'
  | 'MERCHANT_MISMATCH';

export interface PurchaseScenario {
  kind: 'in-scope' | 'out-of-scope';
  index: number;                       // 1-based within kind
  agentId: string;
  principal: string;
  scope: {
    categories: string[];
    maxPerTxnPaise: bigint;
    maxAggregatePaise: bigint;
    /** Expiry window, days from run start (materialized by the runner as
     *  runStart + days — issueDelegation requires expiresAt > now, so the
     *  corpus stores offsets, never absolute dates). */
    expiresInDays: number;
  };
  cart: {
    merchantId: string;
    lines: { sku: string; qty: number; unitPaise: bigint; category: string }[];
  };
  /** For expired artifacts: the gate is evaluated this many days after run
   *  start (beyond expiresInDays). 0 = at run start. */
  evaluatedInDays: number;
  /** For out-of-scope: the violation the generator planted (informational —
   *  the gate's actual reason is what the runner measures). */
  plantedViolation?: OutOfScopeKind;
}

export interface DisputeScenario {
  kind: 'disputed';
  index: number;
  agentId: string;
  principal: string;
  scope: PurchaseScenario['scope'];
  cart: PurchaseScenario['cart'];
  disputeReason: string;
  disputeAmountPaise: bigint;
  evaluatedInDays: number;
}

/** A fraud-evaluation scenario: risk engine flags the transaction; the agent
 *  either proves delegation (legit) or cannot (malicious). */
export interface FlaggedScenario {
  kind: 'flagged-legit' | 'flagged-malicious';
  index: number;
  agentId: string;
  principal: string;
  scope: PurchaseScenario['scope'];
  evaluatedInDays: number;
  tx: {
    merchantId: string;
    amountPaise: bigint;
    category: string;
    orderId: string;
  };
  riskSignals: { velocityPerMin: number; headless: boolean; accountAgeDays: number };
  /** legit: the real signed wire + sig. malicious: absent or forged. */
  artifactWire: unknown | null;
  sig: string | null;
}

export interface BatchCorpus {
  seed: number;
  catalog: Catalog;
  inScope: PurchaseScenario[];
  outOfScope: PurchaseScenario[];
  disputed: DisputeScenario[];
  flaggedLegit: FlaggedScenario[];
  flaggedMalicious: FlaggedScenario[];
}

// ---------------------------------------------------------------------------
// generation helpers (all draws go through the seeded PRNG)
// ---------------------------------------------------------------------------

function pick<T>(rng: () => number, arr: T[]): T {
  return arr[Math.floor(rng() * arr.length)] as T;
}

function pickCategories(rng: () => number, all: string[]): string[] {
  // 1–3 distinct categories, PRNG-ordered, never empty.
  const shuffled = [...all];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = shuffled[i] as string;
    shuffled[i] = shuffled[j] as string;
    shuffled[j] = tmp;
  }
  const n = 1 + Math.floor(rng() * Math.min(3, all.length));
  return shuffled.slice(0, n).sort();
}

// The batch clock is relative: the corpus stores expiry offsets in days and
// the runner materializes them as (run start + offset). This keeps the corpus
// reproducible (same offsets from the same seed) while respecting
// issueDelegation's hard rule that expiresAt > issuedAt at mint time.

function line(
  p: CatalogProduct,
  qty: number,
): { sku: string; qty: number; unitPaise: bigint; category: string } {
  return { sku: p.sku, qty, unitPaise: p.unitPaise, category: p.category };
}

function cartTotal(
  lines: { qty: number; unitPaise: bigint }[],
): bigint {
  let t = 0n;
  for (const l of lines) t += BigInt(l.qty) * l.unitPaise;
  return t;
}

function newAgent(index: number, kind: string): string {
  return `agent:${kind}-batch-v1-${String(index).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// in-scope (25): carts built from in-scope categories; caps drawn generously
// around the cart total so the gate should allow every one. Honest note: a
// boundary draw can still land exactly at the cap (allowed — the gate treats
// equality as within cap) but never above it for in-scope scenarios.
// ---------------------------------------------------------------------------

function genInScope(
  rng: () => number,
  catalog: Catalog,
  count: number,
): PurchaseScenario[] {
  const out: PurchaseScenario[] = [];
  for (let i = 1; i <= count; i++) {
    const categories = pickCategories(rng, catalog.categories);
    const eligible = catalog.products.filter((p) => categories.includes(p.category));
    const lineCount = 1 + Math.floor(rng() * 3); // 1..3 lines
    const lines: ReturnType<typeof line>[] = [];
    for (let l = 0; l < lineCount; l++) {
      const p = pick(rng, eligible);
      lines.push(line(p, 1 + Math.floor(rng() * 2))); // qty 1..2
    }
    const total = cartTotal(lines);
    // per-txn cap: total .. total * 2 (>= total, so per-txn passes)
    const perTxn = total * (1n + BigInt(Math.floor(rng() * 100)) / 100n);
    // aggregate cap: at least perTxn, up to 4x — room for this and later spend
    const agg = perTxn * (2n + BigInt(Math.floor(rng() * 3)));
    out.push({
      kind: 'in-scope',
      index: i,
      agentId: newAgent(i, 'shopper'),
      principal: 'human:rupa@upi',
      scope: {
        categories,
        maxPerTxnPaise: perTxn,
        maxAggregatePaise: agg,
        expiresInDays: 30 + Math.floor(rng() * 336), // 30..365
      },
      evaluatedInDays: 0,
      cart: { merchantId: catalog.merchantId, lines },
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// out-of-scope (15): each plants ONE of the five gate violations, chosen by
// uniform draw. Not every planted violation is guaranteed to trip the gate
// first (e.g. an expired artifact whose cap would also have blocked) — the
// runner measures the gate's actual verdict, and anything that unexpectedly
// passes lands in the exceptions list, not on the cutting-room floor.
// ---------------------------------------------------------------------------

function genOutOfScope(
  rng: () => number,
  catalog: Catalog,
  count: number,
): PurchaseScenario[] {
  const kinds: OutOfScopeKind[] = [
    'CATEGORY_OUT_OF_SCOPE',
    'CAP_EXCEEDED_PER_TXN',
    'CAP_EXCEEDED_AGGREGATE',
    'ARTIFACT_EXPIRED',
    'MERCHANT_MISMATCH',
  ];
  const out: PurchaseScenario[] = [];
  for (let i = 1; i <= count; i++) {
    // Round-robin through kinds so all five are exercised, PRNG for the rest.
    const planted = kinds[(i - 1) % kinds.length] as OutOfScopeKind;
    const categories = pickCategories(rng, catalog.categories);
    const eligible = catalog.products.filter((p) => categories.includes(p.category));
    const p = pick(rng, eligible);
    const qty = 1 + Math.floor(rng() * 2);
    const lines = [line(p, qty)];
    const total = cartTotal(lines);

    let maxPerTxnPaise = total * 2n;
    let maxAggregatePaise = total * 4n;
    let expiresInDays = 30 + Math.floor(rng() * 336);
    let evaluatedInDays = 0;
    let cartMerchant = catalog.merchantId;

    switch (planted) {
      case 'CATEGORY_OUT_OF_SCOPE': {
        // one line outside the delegated categories
        const outside = catalog.products.filter((x) => !categories.includes(x.category));
        const bad = pick(rng, outside);
        lines.push(line(bad, 1));
        break;
      }
      case 'CAP_EXCEEDED_PER_TXN':
        maxPerTxnPaise = total - 1n; // strictly below the cart total
        break;
      case 'CAP_EXCEEDED_AGGREGATE':
        maxPerTxnPaise = total * 2n;
        maxAggregatePaise = total - 1n; // any spend breaks the lifetime cap
        break;
      case 'ARTIFACT_EXPIRED':
        // issueDelegation cannot mint an already-expired artifact (by
        // design), so the corpus plants a SHORT window and evaluates the
        // gate after it lapses: valid at mint, expired at purchase.
        expiresInDays = 1 + Math.floor(rng() * 3); // 1..3 days
        evaluatedInDays = expiresInDays + 1 + Math.floor(rng() * 30); // strictly after
        break;
      case 'MERCHANT_MISMATCH':
        cartMerchant = 'somebody-else-commerce';
        break;
    }

    out.push({
      kind: 'out-of-scope',
      index: i,
      agentId: newAgent(i, 'rogue'),
      principal: 'human:rupa@upi',
      scope: {
        categories,
        maxPerTxnPaise,
        maxAggregatePaise,
        expiresInDays,
      },
      evaluatedInDays,
      cart: { merchantId: cartMerchant, lines },
      plantedViolation: planted,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// disputed (10): in-scope purchases that later get disputed; the runner times
// dispute -> dossier.
// ---------------------------------------------------------------------------

const DISPUTE_REASONS = [
  'cardholder disputes this charge — not recognized',
  'principal says the agent bought the wrong item',
  'agent exceeded what the principal remembers approving',
  'item never delivered',
  'duplicate charge alleged on this order',
  'principal claims the amount differs from the quote',
  'agent bought for itself, not the principal',
  'refund promised but not received',
  'subscription auto-renewal disputed',
  'chargeback filed by issuing bank, reason: fraud unspecified',
];

function genDisputed(
  rng: () => number,
  catalog: Catalog,
  count: number,
): DisputeScenario[] {
  const out: DisputeScenario[] = [];
  for (let i = 1; i <= count; i++) {
    const categories = pickCategories(rng, catalog.categories);
    const eligible = catalog.products.filter((p) => categories.includes(p.category));
    const p = pick(rng, eligible);
    const qty = 1 + Math.floor(rng() * 2);
    const lines = [line(p, qty)];
    const total = cartTotal(lines);
    out.push({
      kind: 'disputed',
      index: i,
      agentId: newAgent(i, 'disputed'),
      principal: 'human:rupa@upi',
      scope: {
        categories,
        maxPerTxnPaise: total * 2n,
        maxAggregatePaise: total * 4n,
        expiresInDays: 30 + Math.floor(rng() * 336),
      },
      evaluatedInDays: 0,
      cart: { merchantId: catalog.merchantId, lines },
      disputeReason: DISPUTE_REASONS[(i - 1) % DISPUTE_REASONS.length] as string,
      disputeAmountPaise: total,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// flagged pass-through (5 legit + 5 malicious): risk engine BLOCKs (score
// >= 2); the question is whether the agent can prove delegation.
// ---------------------------------------------------------------------------

function flaggingSignals(rng: () => number): {
  velocityPerMin: number;
  headless: boolean;
  accountAgeDays: number;
} {
  // every combination here trips >= 2 triggers in risk-mock/engine.ts
  const r = rng();
  if (r < 0.34) {
    return { velocityPerMin: 6 + Math.floor(rng() * 4), headless: false, accountAgeDays: 365 };
  }
  if (r < 0.67) {
    return { velocityPerMin: 1, headless: true, accountAgeDays: 7 };
  }
  return { velocityPerMin: 1, headless: false, accountAgeDays: 10 };
}

function genFlagged(
  rng: () => number,
  catalog: Catalog,
  count: number,
  legit: boolean,
): FlaggedScenario[] {
  const out: FlaggedScenario[] = [];
  for (let i = 1; i <= count; i++) {
    const categories = pickCategories(rng, catalog.categories);
    const eligible = catalog.products.filter((p) => categories.includes(p.category));
    const p = pick(rng, eligible);
    const amount = p.unitPaise * BigInt(1 + Math.floor(rng() * 2));
    out.push({
      kind: legit ? 'flagged-legit' : 'flagged-malicious',
      index: i,
      agentId: legit
        ? newAgent(i, 'flagged-legit')
        : `agent:impostor-${String(i).padStart(2, '0')}`,
      principal: 'human:rupa@upi',
      scope: {
        categories,
        maxPerTxnPaise: amount * 2n,
        maxAggregatePaise: amount * 4n,
        expiresInDays: 30 + Math.floor(rng() * 336),
      },
      evaluatedInDays: 0,
      tx: {
        merchantId: catalog.merchantId,
        amountPaise: amount,
        category: p.category,
        orderId: `order_flagged_${legit ? 'legit' : 'mal'}_${String(i).padStart(2, '0')}`,
      },
      riskSignals: flaggingSignals(rng),
      // Runner fills artifactWire/sig for legit scenarios by issuing a real
      // delegation; malicious stay null (no proof) — set in run-batch.ts.
      artifactWire: null,
      sig: null,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// entry
// ---------------------------------------------------------------------------

export function generateBatchCorpus(seed: number = BATCH_SEED): BatchCorpus {
  const rng = mulberry32(seed);
  const catalog = loadCatalog();
  return {
    seed,
    catalog,
    inScope: genInScope(rng, catalog, 25),
    outOfScope: genOutOfScope(rng, catalog, 15),
    disputed: genDisputed(rng, catalog, 10),
    flaggedLegit: genFlagged(rng, catalog, 5, true),
    flaggedMalicious: genFlagged(rng, catalog, 5, false),
  };
}
