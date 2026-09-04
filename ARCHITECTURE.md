# Pramaan — Architecture

One system: three layers over one ledger spine. This document is the diagram, the flows, and the reasons. The interface contracts live in [CONTRACTS.md](CONTRACTS.md); this is why they are shaped that way.

---

## The triangle

```
                        ┌──────────────────────────────┐
                        │   LAYER 1 — DELEGATION PROOF   │
                        │   src/artifact.ts + crypto.ts  │
                        │   Ed25519-signed artifact:     │
                        │   categories · per-txn cap ·   │
                        │   aggregate cap · expiry ·    │
                        │   nonce                        │
                        └───────────────┬──────────────┘
                                        │ gate evaluates it
        ┌───────────────────────────────┼───────────────────────────────┐
        │                               ▼                               │
        │                   ╔═══════════════════════╗                   │
        │                   ║   THE LEDGER SPINE     ║                   │
        │                   ║   src/ledger.ts        ║                   │
        │                   ║   node:sqlite          ║                   │
        │                   ║   append-only rows,    ║                   │
        │                   ║   SHA-256 hash chain   ║                   │
        │                   ║   (prevHash → selfHash) ║                   │
        │                   ╚═══════╦═══════╤═══════╝                   │
        │                           │       │                           │
        ▼                           │       ▼                           ▼
┌───────────────────────┐           │   ┌───────────────────────────────────┐
│ LAYER 2 —             │           │   │ LAYER 3 — FRAUD INTEROP           │
│ DISPUTE EVIDENCE      │◄──────────┘   │ src/passthrough.ts + routes/fraud │
│ src/evidence.ts +     │                │                                   │
│ templates/            │                │  risk engine BLOCKs → is there a   │
│ evidence-pack.html    │                │  valid in-scope artifact?          │
│                       │                │   YES → RELEASE (AGENT_RELEASED)  │
│ self-contained HTML   │                │   NO  → BLOCK  (NO_VALID_...)     │
│ dossier: exhibits    │                │                                   │
│ A–E + computed verdict│                │                                   │
└───────────────────────┘                └───────────────────────────────────┘
```

The ledger is the only state. The three layers are pure-ish functions over it: Layer 1 *writes* authorizations, Layer 2 *reads* them as evidence, Layer 3 *reads* them as a release key. No layer talks to another directly — they share the spine.

---

## Request flow — an authorized purchase

```
merchant console            Pramaan                          Razorpay (test)
     │                          │                                │
     │ 1. POST /delegations     │                                │
     │    (scope: caps,         │── sign artifact (Ed25519) ──┐  │
     │     categories, expiry)  │   append DELEGATION_ISSUED   │  │
     │◄── artifact + sig ───────│                               │  │
     │                          │                               │  │
     │ 2. agent returns with    │                               │  │
     │    artifact + sig + cart │                               │  │
     │    POST /checkout ──────►│                                │  │
     │                          │ 3. verify sig                  │  │
     │                          │    gate(artifact, cart, now,   │  │
     │                          │    aggregateSpent) → verdict    │  │
     │                          │    reason code if refused       │  │
     │                          │    ATTEMPT_BLOCKED ─ 403 ─────►│  │
     │                          │        (no payment possible)    │  │
     │                          │    ATTEMPT_ALLOWED              │  │
     │                          │ 4. createOrder(amountPaise,     │  │
     │                          │    receipt=delegationId) ──────┼─►│
     │◄── orderId ──────────────│◄── order ──────────────────────┼──┤
     │                          │ 5. PAYMENT_CAPTURED row         │  │
     │                          │    (aggregate position updated)  │  │
```

Step 3 is the whole product in one move: the gate is a **pure function** — signature check, expiry check, category check, per-txn cap, aggregate cap, count/nonce discipline — and its verdict is either an allow or a *named* refusal. The Razorpay order is only ever created behind an allow.

## Dispute flow — evidence pack

```
cardholder disputes ──► POST /disputes { delegationId, amount, reason }
                              │  DISPUTE_OPENED row (+ data/disputes.json sidecar)
                              ▼
                        GET /evidence/:delegationId?disputeId=…
                              │
                              ▼
                    src/evidence.ts pulls the ledger span:
                      DELEGATION_ISSUED (+ artifact JSON)
                      every ATTEMPT_ALLOWED / ATTEMPT_BLOCKED
                      PAYMENT_CAPTURED · DISPUTE_OPENED
                              │
                              ▼
                    renderEvidencePack() → single self-contained HTML:
                      Exhibit A — what was authorized (scope)
                      Exhibit B — what the agent attempted (every row, reasons)
                      Exhibit C — what actually happened (captures)
                      Exhibit D — scope-vs-actual diff (COMPUTED, not asserted)
                      Exhibit E — chain of integrity (verifyChain over the span)
                      footer — SHA-256 of the rendered HTML itself
```

Exhibit D is the load-bearing exhibit: its verdict line is computed from the data (per-line category/cap checks, aggregate position), never a hard-coded conclusion. If the agent stayed in scope, the dossier says so because the numbers say so — and vice versa.

## Fraud flow — pass-through release

```
risk signals ──► POST /fraud/evaluate { transaction, riskSignals }
                      │
                      ▼
              risk-mock/engine.ts (legible, no ML):
                velocityPerMin > 5 · headless · accountAgeDays < 30
                any two of three → BLOCK-flag, else clear
                      │
        ┌─ clear ─────┴──── flagged ─┐
        ▼                             ▼
  RELEASE                     present artifactWire + sig
  (RISK_ENGINE_CLEAR)                │
                                    ▼
                          same gate as checkout, for this
                          exact transaction (merchant, amount,
                          category)
                             │              │
                    valid ───┴─── invalid ──┐
                     ▼                       ▼
              RELEASE (PRAMAAN_       BLOCK (NO_VALID_DELEGATION)
              DELEGATION_PROOF)
              + AGENT_RELEASED row
```

The flagged-legit agent — the one the risk engine would have false-declined — walks free only because it can *prove* it was authorized. That recovered sale is the economic argument; `npm run batch` measures it.

---

## Decisions

| Decision | Why (honest reasons) |
|---|---|
| **Ed25519 via `node:crypto`** | 64-byte signatures, verification in the standard library — zero dependencies for the crypto that everything else stands on. Small sigs matter because the artifact travels in every request body. The alternative (HMAC-SHA256) was the documented fallback if Ed25519 friction ate the night; it didn't. |
| **SQLite via `node:sqlite` (DatabaseSync)** | Zero external dependency — `node:sqlite` ships with Node 22. One file per run (`data/pramaan.db`, gitignored): the audit trail is a file a judge can open, and `PRAMAAN_DB` points anywhere for an isolated test run. Append-only discipline is enforced in code, not by SQLite configuration. |
| **Canonical JSON for hashing** | Deterministic hashes require deterministic bytes. Key order in JS objects is insertion-ordered — the same logical artifact would hash differently depending on how it was constructed. Canonical JSON (sorted keys, defined escaping) pins the hash input, so signature verification is stable across processes and languages. |
| **Hash chain, not blockchain** | The threat model is *tamper-evidence*, not consensus. A single merchant writes its own ledger; there is no double-spend race and no need for distributed agreement — only for the guarantee that any edit of history is detectable, which `prevHash` chaining + `verifyChain()` provides exactly. A blockchain here would add energy cost and ceremony while answering a question nobody asked. |
| **The gate is a pure function** | Testability and explainability are the same feature here. No I/O, no clock, no side effects — the caller supplies `now` and the running aggregate — so every verdict is reproducible from its inputs, boundary cases are unit-testable to the paise, and the reason code is forced to name itself because there is nothing else in the function to blame. |
| **Mock risk engine (legible, not ML)** | A judge has ~20 seconds per novel mechanism. Three visible thresholds (velocity, headless, account age, any two of three) make the pass-through *auditable* — you can see exactly which rule fired. A real ML model would be both out of scope for one night and actively counterproductive: an opaque engine would undermine the explainability the whole system is selling. |
| **Paise as `bigint` end-to-end, strings at the JSON boundary** | `0.1 + 0.2 !== 0.3` is not an acceptable property in a money system. Internally every amount is integer paise as `bigint` — caps, aggregates, comparisons all exact. JSON has no bigint, so amounts serialize as strings (`"125000"`) and are reparsed to bigint at the boundary. The boundary is one place, so the discipline is enforceable. |

---

## What runs where

- `src/` — the library: `crypto.ts`, `artifact.ts`, `ledger.ts`, `gate.ts`, `evidence.ts`, `passthrough.ts`, `razorpay.ts`, `server.ts`, `routes/*`
- `templates/evidence-pack.html` — function-based template (a TS function returning HTML; no template-engine dependency)
- `risk-mock/engine.ts` — the deliberately legible risk engine
- `scripts/` — `demo.ts`, `smoke.ts`, `gen-batch.ts`, `run-batch.ts` (S5)
- `metrics/` — batch output: `report.json`, `summary.md`, `chart.svg` (S5)
- `web/` — the React console (S6)
- `data/` — gitignored runtime state (ledger db, disputes sidecar)

CI ([.github/workflows/verify.yml](.github/workflows/verify.yml)) runs typecheck + the full suite + the batch in stub mode on every push and PR — green without any secrets.
