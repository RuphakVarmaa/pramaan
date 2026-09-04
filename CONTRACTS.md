# CONTRACTS.md — Pramaan Swarm Law (v1.0, FROZEN 2026-09-04)

> This file is the single source of truth for all swarms. Interfaces defined here are frozen.
> If a swarm discovers a genuine contract defect, it reports it to the Orchestrator — it does not
> unilaterally change a contract. The Orchestrator version-bumps this file and notifies all live swarms.

---

## 0. Project Identity

- **Name:** Pramaan (प्रमाण — proof/authority)
- **What it is:** Proof-of-Delegation & Dispute-Evidence Layer for AI-agent payments on Razorpay **test mode**
- **Stack:** Node 22+ · TypeScript (strict) · Fastify · `node:sqlite` (DatabaseSync — NO external SQLite dep) · Ed25519 via `node:crypto` · Vitest · GitHub Actions
- **Money invariant:** all amounts are **integer paise** (`bigint`). Never `number`, never float.

---

## 1. Delegation Artifact (Layer 1) — `src/artifact.ts`

### 1.1 Schema (TypeScript type, authoritative)

```ts
interface DelegationArtifact {
  version: 1;
  artifactId: string;            // "dl_" + 24 hex chars
  merchantId: string;            // e.g. "kadai-and-co"
  agentId: string;               // e.g. "agent:shopping-assistant-v3"
  principal: string;             // the human, e.g. "human:rupa@upi"
  scope: {
    categories: string[];        // subset of catalog categories
    maxPerTxnPaise: bigint;      // per-transaction cap
    maxAggregatePaise: bigint;   // lifetime aggregate cap
    expiresAt: string;          // ISO-8601 UTC
  };
  issuedAt: string;              // ISO-8601 UTC
  nonce: string;                 // 32 hex chars, single-use
}
```

### 1.2 Wire format (transit)

The artifact travels as JSON where **bigint paise fields are encoded as strings** (JSON has no bigint).
Two reserved envelope keys: `"artifact"` (the artifact object, paise as strings) and `"sig"` (base64 Ed25519 signature over the canonical form). The signature is computed over the **canonical JSON of the artifact with paise as strings** — i.e., exactly the bytes a verifier receives.

### 1.3 Canonical JSON rules (authoritative, `src/crypto.ts`)

1. Recursively sort object keys lexicographically (UTF-16 code-unit order).
2. No whitespace between tokens.
3. Strings: minimal JSON escaping (as `JSON.stringify` does — same bytes).
4. Numbers: JSON.stringify default. Paise fields are strings in transit, so no number-precision issue ever arises.
5. Arrays preserve order.
6. `canonicalize(x)` must be idempotent: `canonicalize(canonicalize(x)) === canonicalize(x)`.

### 1.4 Issuance & verification (`src/artifact.ts`)

- `issueDelegation(input): { artifact, sig }` — mints artifactId + nonce (crypto-random), sets `issuedAt`, signs.
- `verifyArtifact(artifactWire, sig): { ok: true, artifact } | { ok: false, reason: GateReason }` — checks signature, expiry (against a caller-supplied `now`), and structural validity (non-empty categories, positive caps, expiresAt > issuedAt).
- Signing keys: merchant-side Ed25519 keypair. For this build, a single demo keypair generated at server start (seeded from env `PRAMAAN_SIGNING_SEED` if present, else crypto-random) and exposed at `GET /keys` for verifiers. Document this as a limitation (production: merchant-held keys, KMS).

### 1.5 Expiry semantics

`expiresAt < now` → expired. Expired artifacts fail with `ARTIFACT_EXPIRED`. Verification time is caller-supplied (never `Date.now()` buried in the library) to keep functions pure and testable.

---

## 2. Ledger (the spine) — `src/ledger.ts`

### 2.1 Row schema

```ts
type LedgerEventType =
  | 'DELEGATION_ISSUED' | 'ATTEMPT_ALLOWED' | 'ATTEMPT_BLOCKED'
  | 'PAYMENT_CAPTURED' | 'AGENT_RELEASED' | 'DISPUTE_OPENED' | 'EVIDENCE_GENERATED';

interface LedgerRow {
  seq: number;            // 1-based, monotonically increasing
  ts: string;             // ISO-8601 UTC
  type: LedgerEventType;
  artifactId?: string;    // present when the event relates to a delegation
  orderId?: string;       // present for payment events
  amountPaise?: bigint;   // present when the event involves an amount
  verdict?: string;       // 'ALLOW' | 'BLOCK' | 'RELEASE' | 'DENY'
  reason?: string;        // gate reason code or human note
  prevHash: string;        // hex sha256 of previous row's selfHash ('0'.repeat(64) for seq 1)
  selfHash: string;        // hex sha256 of (prevHash ‖ canonical(row minus hash fields))
}
```

### 2.2 Hash rule (authoritative)

`selfHash = sha256( prevHash || canonicalJSON(rowWithout { prevHash, selfHash }) )` — both as utf8 strings, concatenated.

### 2.3 API (`src/ledger.ts`)

- `appendLedgerEvent(db, event): LedgerRow` — assigns seq/ts, computes hashes, INSERTs. **Only path to write.**
- `readLedger(db): LedgerRow[]`
- `verifyChain(rows): { valid: boolean; firstBreak?: number }` — recomputes every selfHash; returns seq of first mismatch.
- `aggregateSpent(db, artifactId): bigint` — sum of `amountPaise` over `PAYMENT_CAPTURED` rows for the artifact (the aggregate-cap source of truth).
- Storage: `node:sqlite` `DatabaseSync`, file `data/pramaan.db` (gitignored, created on demand; `data/` is created if missing).
- **Backwards-compat rule for swarms building against JSON arrays: a row whose `payloadHash` field is present (old shape) is read tolerantly (no crash), but new writes use `selfHash` only.**

### 2.4 Where the ledger lives per swarm

Each swarm that runs code with a ledger uses its OWN SQLite file via `PRAMAAN_DB` env (default `data/pramaan.db`). Tests use `:memory:`. Scripts (smoke/batch/demo) use a temp file per run unless told otherwise.

---

## DB schema (frozen):

```sql
CREATE TABLE IF NOT EXISTS ledger (
  seq INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  type TEXT NOT NULL,
  artifactId TEXT,
  orderId TEXT,
  amountPaise TEXT,          -- integer paise stored as TEXT (SQLite lacks bigint) — parse with BigInt() on read
  verdict TEXT,
  reason TEXT,
  prevHash TEXT NOT NULL,
  selfHash TEXT NOT NULL
);
```

---

## 3. Gate — `src/gate.ts` (pure function)

```ts
type GateReason =
  | 'CAP_EXCEEDED_PER_TXN' | 'CAP_EXCEEDED_AGGREGATE' | 'CATEGORY_OUT_OF_SCOPE'
  | 'ARTIFACT_EXPIRED' | 'MERCHANT_MISMATCH' | 'SIGNATURE_INVALID' | 'ARTIFACT_UNKNOWN';

interface CartLine { sku: string; qty: number; unitPaise: bigint; category: string; }
interface Cart { merchantId: string; lines: CartLine[]; }

interface GateInput {
  artifact: DelegationArtifact;     // already signature-verified by caller
  cart: Cart;
  now: string;                       // ISO-8601
  aggregateSpentPaise: bigint;       // captured total so far for this artifact
}
interface GateVerdict {
  allowed: boolean;
  reason?: GateReason;              // exactly one when blocked
  totalPaise: bigint;
  aggregateAfterPaise: bigint;
}
```

Evaluation order (first violation wins, deterministic):
1. `cart.merchantId === artifact.merchantId` → else `MERCHANT_MISMATCH`
2. `now <= expiresAt` → else `ARTIFACT_EXPIRED`
3. total = Σ line.qty × line.unitPaise (bigint) → `total <= maxPerTxnPaise` → else `CAP_EXCEEDED_PER_TXN`
4. `aggregateSpent + total <= maxAggregatePaise` → else `CAP_EXCEEDED_AGGREGATE`
5. every line.category ∈ artifact.scope.categories → else `CATEGORY_OUT_OF_SCOPE`

Signature/expiry validity are the caller's concern at the artifact layer; the gate assumes a verified artifact but still re-checks expiry (defense in depth).

### 3.1 The catalog — `catalog.json` (repo root)

Authored merchant: **Kadai & Co.** (specialty coffee + kitchen goods, Indiranagar, Bengaluru). ~12 real products, each with `sku`, `name`, `description` (authored copy, 1–2 sentences, no lorem), `category` (one of `coffee`, `equipment`, `pantry`, `merch`), `unitPaise` (integer, realistic Indian retail). The catalog is the agent-readable surface — it IS the "agent-readable catalog" direction from the track brief.

---

## 4. API Surface — `src/routes/*` (Fastify)

All bodies JSON. All money in integer paise (strings in JSON).

| Method | Path | Body / Params | Response |
|---|---|---|---|
| GET | `/health` | — | `{ ok: true, service: 'pramaan', ts }` |
| GET | `/keys` | — | `{ publicKey: string }` (Ed25519 public key, base64) — for artifact verifiers |
| POST | `/delegations` | `{ merchantId, agentId, principal, scope: { categories, maxPerTxnPaise, maxAggregatePaise, expiresAt } }` | 201 `{ artifactId, artifact, sig }` (paise as strings) + `DELEGATION_ISSUED` ledger row |
| POST | `/gate` | `{ artifactWire, sig, cart }` | 200 `{ allowed, reason?, totalPaise, aggregateAfterPaise }` — no payment side effect |
| POST | `/checkout` | `{ artifactWire, sig, cart }` | 200 `{ orderId, amountPaise, receipt: delegationId }` via gate → Razorpay order creation → ledger `ATTEMPT_ALLOWED`/`ATTEMPT_BLOCKED`; blocked → HTTP 403 `{ error, reason }` |
| GET | `/evidence/:delegationId?disputeId=x` | — | HTML dossier (self-contained) |
| POST | `/disputes` | `{ delegationId, amountPaise, reason }` | 201 `{ disputeId }` + `DISPUTE_OPENED` ledger row |
| POST | `/fraud/evaluate` | `{ transaction: { merchantId, agentId, amountPaise, orderId? }, riskSignals: { velocityPerMin, headless: boolean, accountAgeDays } }` | 200 `{ action: 'RELEASE' \| 'BLOCK', reason, artifactId? }` + ledger `AGENT_RELEASED` on release |
| GET | `/ledger` | query `?limit=&artifactId=` | `{ rows: [...] }` (paise as strings, seq order) |
| GET | `/catalog` | — | the catalog JSON |

Note: `POST /gate` is the pure evaluation (used by console Panel B and tests); `POST /checkout` performs the payment path. Routes must never call `Date.now()` for gate decisions — they pass server `now` explicitly.

## 4.1 Razorpay adapter — `src/razorpay.ts`

- Env: `RAZORPAY_KEY_ID` (starts `rzp_test_`), `RAZORPAY_KEY_SECRET`, optional `PRAMAAN_STUB_PAYMENTS=1` to force the stub (used when test rails are unavailable; must be visible in /health and honestly documented).
- `createOrder({ amountPaise, receipt, notes })` → `{ orderId, amountPaise, status }`. Uses `fetch` against `https://api.razorpay.com/v1/orders` with Basic auth. Stub mode: deterministic fake `order_stub_<hash>` ids.
- `fetchPayment(paymentId)` → minimal fields. Stub mode: fake.
- **No Razorpay SDK dependency — plain fetch.** Paise integers end to end. On non-2xx, throws `RazorpayError` with status + body; routes catch and surface as 502 with the ledger recording `ATTEMPT_BLOCKED` reason `PAYMENT_PROVIDER_ERROR` (note: this is a route-level reason string, not a gate reason code — the gate's contract stays pure).
- Test keys are read **only** from env at runtime. Never hardcoded. Never in git.

---

## 5. Evidence Pack — `src/evidence.ts` + `templates/evidence-pack.html`

- Input: `delegationId` + `disputeId` (+ optional `now`). Pulls from ledger: the `DELEGATION_ISSUED` row (+ stored artifact JSON), all attempts, the capture, the dispute row.
- Renders self-contained HTML (inline CSS, no external fetches) with:
  1. **Cover block** — dispute id, delegation id, generated-at (IST), merchant, agent, principal
  2. **Exhibit A — What was authorized** (scope table: categories, caps, expiry)
  3. **Exhibit B — What the agent attempted** (every ledger line, reasons included)
  4. **Exhibit C — What actually happened** (capture(s))
  5. **Exhibit D — Scope-vs-actual diff** (computed, not asserted: per-line category/cap checks, aggregate position, verdict)
  D's verdict line must be computed from the data (e.g., "All 2 attempted transactions were within scope. Aggregate spend ₹1,250.00 of ₹5,000.00 cap.")
  6. **Exhibit E — Chain of integrity** (verifyChain over the span, firstBreak if any)
  7. **Footer** — SHA-256 of the full rendered HTML (hex), generation timestamp, "Pramaan — proof of delegation"
- The template lives at `templates/evidence-pack.html` as a **function-based template** (TS function `renderEvidencePack(data): string` returning full HTML) — no template engine dependency. Serif-forward document design (self-hosted fonts in `web/public/fonts/`, referenced with relative paths that also work when the HTML is saved standalone). Timestamps rendered in IST (`Asia/Kolkata`).
- Latency budget: rendering is local string assembly — must be < 1s. The ≤30s claim covers dispute-to-dossier including human navigation.

### 5.1 Disputes sidecar file

`data/disputes.json` — `[ { disputeId, delegationId, amountPaise, reason, openedAt } ]` — managed by the disputes route; read by evidence generator. (Sidecar keeps the ledger pure-money-events-only.)

---

## 6. Fraud Pass-Through — `src/passthrough.ts` + `src/routes/fraud.ts`

`POST /fraud/evaluate` flow:

1. Mock risk engine (`risk-mock/engine.ts` — deliberately legible, no ML): score = f(velocityPerMin > 5, headless === true, accountAgeDays < 30). Any two of three → BLOCK else ALLOW. Thresholds visible in code, judge-readable in 20 seconds.
2. If risk engine says ALLOW → `{ action: 'BLOCK', reason: 'RISK_ENGINE_DENY' }` is NOT the output — re-read: risk engine ALLOW means proceed normally (no Pramaan interposition needed): return `{ action: 'RELEASE', reason: 'RISK_ENGINE_CLEAR' }`.
3. If risk engine says BLOCK → Pramaan asks the one question: can the requester present a valid, unexpired, in-scope artifact **for this exact transaction** (merchant, amount within caps, category in scope)? Yes → `{ action: 'RELEASE', reason: 'PRAMAAN_DELEGATION_PROOF' }` + `AGENT_RELEASED` ledger row. No → `{ action: 'BLOCK', reason: 'NO_VALID_DELEGATION' }`.
4. The route takes the artifact wire + sig in the request body (field `artifactWire`, `sig`) exactly like `/gate` and `/checkout`.

**Route contract detail:** `AGENT_RELEASED` rows must carry the `artifactId` so the ledger is queryable per-delegation.

---

## 7. Module Ownership Map (frozen)

| Swarm | Owns (exclusively) | May read (any) |
|---|---|---|
| S1 CORE | `src/crypto.ts`, `src/artifact.ts`, `src/ledger.ts`, `test/crypto.test.ts`, `test/artifact.test.ts`, `test/ledger.test.ts` | everything |
| S2 RAILS | `src/gate.ts`, `src/razorpay.ts`, `src/routes/*.ts`, `src/server.ts`, `src/app.ts`, `catalog.json`, `test/gate.test.ts`, `test/routes.test.ts`, `test/paise.test.ts` | everything |
| S3 EVIDENCE | `src/evidence.ts`, `templates/evidence-pack.html` (as `src/templates/evidence.ts` or `templates/` — S3's choice, single location), `test/evidence.test.ts`, `data/disputes.json` shape | everything |
| S4 RISK | `src/passthrough.ts`, `src/routes/fraud.ts` (if separate file), `risk-mock/engine.ts`, `test/passthrough.test.ts` | everything |
| S5 BATCH | `scripts/gen-batch.ts`, `scripts/run-batch.ts`, `metrics/` outputs | everything |
| S6 CONSOLE | `web/` (all of it) | everything |
| S7 REPO-ARTIFACTS | `README.md`, `JUDGE.md`, `ARCHITECTURE.md`, `llms.txt`, `AGENTS.md`, `ENGINEERING_LOG.md`, `PAPER.md`, `ASSETS.md`, `.github/workflows/verify.yml` | everything |

**Ownership rule:** swarms do not edit outside their ownership. Shared files (e.g., `src/server.ts` wiring) — S2 owns server wiring; S3/S4 own their route modules which S2 imports. If a swarm must touch another's file, it reports to the Orchestrator instead.

---

## 8. Shared invariants (every swarm, no exceptions)

1. **Test mode only.** Razorpay test keys only. Live keys = instant fail. No real money, ever.
2. **No secrets in git.** `.env` gitignored (done at genesis). `.env.example` documents every variable with placeholders. Heartbeat scans staged diffs for `rzp_live|rzp_test|secret|api_key` — a match aborts the commit and alerts.
3. **Paise are integers (bigint).** End to end. No floats, no `Number` on money, no exceptions. Tests prove it.
4. **Every money action writes a ledger line.** Issuance, attempt, block, capture, release, dispute — all append to the hash-chained ledger.
5. **No payment without a valid artifact.** A test proves the gate refuses an unartifacted order.
6. **Honest metrics.** Numbers from committed, reproducible scripts. Report failures in `metrics/summary.md` § Exceptions.
7. **Zero generic templates.** No starter kits, template READMEs, default-shadcn look, Tailwind-default-blue, lorem ipsum, "Product A/B/C".
8. **Every asset licensed and cited** in `ASSETS.md` (source URL + license + where used). No orphan assets.

---

## 9. Metric definitions (S5, frozen)

- **In-scope pass rate** = in-scope scenarios ending `PAYMENT_CAPTURED` ÷ 25.
- **Out-of-scope block rate** = out-of-scope scenarios ending blocked with a reason code ÷ 15.
- **Evidence latency** = median ms over the 10 disputed scenarios, dispute→dossier.
- **Legit release rate** = flagged-legit scenarios ending `AGENT_RELEASED` ÷ 5.
- **Malicious block rate** = flagged-malicious scenarios ending blocked ÷ 5.
- **False-positive cost before** = Σ blocked-but-legit amountPaise under risk-engine-only policy (i.e., all flagged-legit blocked).
- **False-positive cost after** = Σ blocked-but-legit amountPaise under Pramaan pass-through (i.e., 0 if all released — report actuals honestly).
- **Holdout discipline:** scenarios are generated with a seeded PRNG (seed committed in report); the report states the seed and that the same seed reproduces the batch.

---

## 10. File-tree (target state)

```
pramaan/
├── .env.example          # every env var documented, placeholder values
├── .gitignore
├── .github/workflows/verify.yml
├── AGENTS.md
├── ARCHITECTURE.md
├── ASSETS.md
├── CONTRACTS.md          # this file
├── ENGINEERING_LOG.md
├── JUDGE.md
├── LICENSE               # MIT
├── PAPER.md              # stretch
├── README.md
├── catalog.json
├── llms.txt
├── package.json
├── tsconfig.json
├── risk-mock/engine.ts
├── scripts/
│   ├── gen-batch.ts
│   ├── run-batch.ts
│   ├── smoke.ts
│   └── demo.ts
├── src/
│   ├── app.ts            # Fastify app factory (S2)
│   ├── artifact.ts       # S1
│   ├── crypto.ts         # S1
│   ├── evidence.ts       # S3
│   ├── gate.ts           # S2
│   ├── ledger.ts        # S1
│   ├── passthrough.ts   # S4
│   ├── razorpay.ts       # S2
│   ├── server.ts         # S2 — entrypoint
│   ├── routes/
│   │   ├── delegations.ts
│   │   ├── gate.ts
│   │   ├── checkout.ts
│   │   ├── evidence.ts
│   │   ├── fraud.ts
│   │   ├── disputes.ts
│   │   └── ledger.ts
│   └── templates/        # evidence template (S3)
├── templates/evidence-pack.html   # if file-based; S3's choice
├── test/
│   ├── crypto.test.ts
│   ├── artifact.test.ts
│   ├── ledger.test.ts
│   ├── gate.test.ts
│   ├── routes.test.ts
│   ├── paise.test.ts
│   ├── evidence.test.ts
│   └── passthrough.test.ts
├── metrics/
│   ├── report.json
│   ├── summary.md
│   └── chart.svg
├── data/                 # gitignored runtime state
└── web/                  # S6 console (React + Vite)
```

---

## 11. Env vars (authoritative list)

| Var | Purpose | Default |
|---|---|---|
| `PRAMAAN_DB` | SQLite file path | `data/pramaan.db` |
| `PRAMAAN_SIGNING_SEED` | Optional deterministic seed for the demo signing keypair | (random) |
| `RAZORPAY_KEY_ID` | Razorpay **test** key id (`rzp_test_...`) | — |
| `RAZORPAY_KEY_SECRET` | Razorpay **test** key secret | — |
| `PRAMAAN_STUB_PAYMENTS` | `1` = force payment stub (documented fallback) | unset |
| `PRAMAAN_PORT` | server port | `3000` |

*FROZEN. v1.0 — Orchestrator, 2026-09-04. Any change requires a version bump + all-swarm notice.*
