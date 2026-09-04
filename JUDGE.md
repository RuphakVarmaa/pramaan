# JUDGE.md — verify every claim yourself

You should not trust this repo's prose. Every judging criterion below maps to a file you can read and a command you can run. Nothing here is asserted without a pointer to the code that proves it.

First run:

```bash
npm install        # Node 22+ required (node:sqlite, Ed25519 in node:crypto)
npm run build      # tsc -> dist/ (the demo/batch/smoke scripts run from dist/)
```

Commands below assume a clean checkout of this branch. Tests are `npx vitest run <file>` — you can also run the whole suite with `npm test`.

---

## The 60-second tour

Run these in order. Each line is one layer of the system.

```bash
npm run demo                          # 1. full arc: delegation -> gate -> capture -> dispute -> evidence -> pass-through
npx vitest run test/gate.test.ts      # 2. the gate: every refusal carries a machine reason code
npx vitest run test/ledger.test.ts    # 3. tamper with one ledger row -> verifyChain reports the exact break
npx vitest run test/routes.test.ts    # 4. no artifact, no payment (HTTP-level proof)
npm run batch                         # 5. 60 seeded scenarios -> metrics/report.json + metrics/summary.md
                                      #    (needs Razorpay TEST keys in .env, or use PRAMAAN_STUB_PAYMENTS=1)
```

Want to drive it by hand over HTTP instead? `npm start`, then follow the curl sequence in the demo section of [ENGINEERING_LOG.md](ENGINEERING_LOG.md) or the route table in [CONTRACTS.md](CONTRACTS.md) §4. The one graceful-failure path (documented refusal) is shown in the tour's step 2 — the gate refuses with a reason, nothing crashes, the refusal is ledgered, and the next attempt proceeds normally.

`npm run demo` and `npm run batch` come from `scripts/` (swarm S5's batch runner produces `metrics/`; the demo path is the end-to-end arc above).

---

## Criterion → proof map

### 1. Explainable money actions

Every decision the system makes about money — allow or refuse — carries a machine-readable reason code, and the gate is a **pure function**: no I/O, no clock reads, no side effects. A caller supplies `now` and the running aggregate; the gate only decides. The reason codes (`ARTIFACT_EXPIRED`, `CAP_EXCEEDED`, `CATEGORY_NOT_IN_SCOPE`, `SIG_INVALID`, …) are enumerated in `src/types.ts` and produced by `src/gate.ts`.

| Where | Command |
|---|---|
| `src/gate.ts` (pure decision), `src/types.ts` (reason codes) | `npx vitest run test/gate.test.ts` |

The test file asserts verdicts *with reasons*, not just booleans — you can see the refusal reason asserted in every negative case.

### 2. Bounded + gated

Hard caps (per-txn, aggregate, category, count, expiry) are enforced in code at the gate — an LLM cannot talk its way past them because the LLM is never in the loop at enforcement time. Scope enforcement cases (cap over, cap exactly-at-boundary, unknown category, expired artifact, bad signature) are in the gate suite.

| Where | Command |
|---|---|
| `src/gate.ts` scope checks; `test/gate.test.ts` boundary cases | `npx vitest run test/gate.test.ts` |

### 3. Gated — no payment without a valid artifact

The route suite contains a dedicated no-artifact test: a checkout attempt without a valid, signed, in-scope artifact is refused (HTTP 403) and recorded as `ATTEMPT_BLOCKED` in the ledger. The payment path is unreachable otherwise.

| Where | Command |
|---|---|
| `test/routes.test.ts` no-artifact case; `src/routes/*` (403 on gate refusal) | `npx vitest run test/routes.test.ts` |

### 4. Audit trail

Every money action appends one row to a SHA-256 hash-chained SQLite ledger (`src/ledger.ts`): `DELEGATION_ISSUED`, `ATTEMPT_BLOCKED`, `ATTEMPT_ALLOWED`, `PAYMENT_CAPTURED`, `DISPUTE_OPENED`, `EVIDENCE_PACKED`, `AGENT_RELEASED`. Each row's `prevHash` is the prior row's hash. `verifyChain()` walks the chain; the tamper test mutates a row and proves the break is detected at the exact sequence number.

| Where | Command |
|---|---|
| `src/ledger.ts`; tamper test in `test/ledger.test.ts` | `npx vitest run test/ledger.test.ts` |

### 5. Measured on held-out data

`npm run batch` runs 60 seeded scenarios (25 in-scope, 15 out-of-scope, 10 disputed, 5 flagged-legit, 5 flagged-malicious). The PRNG seed is committed in `metrics/report.json`; the same seed reproduces the same batch. The report is raw JSON; `metrics/summary.md` is the human summary including the exceptions list. Definitions are frozen in [CONTRACTS.md](CONTRACTS.md) §9.

| Where | Command |
|---|---|
| `scripts/run-batch.ts`, `scripts/gen-batch.ts`, `metrics/report.json`, `metrics/summary.md` | `npm run batch` _(script lands with swarm S5)_ |

### 6. Honest exceptions + false-positive cost

`metrics/summary.md` carries a dedicated **§ Exceptions**: the scenarios the system could not resolve correctly, plus false-positive cost measured two ways — Σ blocked-but-legit amountPaise under a risk-engine-only policy (before) and under Pramaan pass-through (after). Failures are listed, not averaged away.

| Where | Command |
|---|---|
| `metrics/summary.md` § Exceptions | `npm run batch` _(script lands with swarm S5)_ |

### 7. One graceful failure (documented refusal)

The demo path shows a refusal handled as a first-class outcome: an out-of-scope attempt is refused with reason code, ledgered as `ATTEMPT_BLOCKED`, and the run continues — the next in-scope attempt succeeds. Over HTTP: `POST /checkout` with an over-cap cart returns `403 { error, reason }`; nothing crashes, nothing retries, the refusal is on the ledger for the evidence pack to show.

| Where | Command |
|---|---|
| `npm run demo` (refusal mid-arc); `test/routes.test.ts` 403 case | `npm run demo` |

### 8. Defense-only

The gate refuses everything out of scope — there is no code path that widens scope, raises a cap, or re-signs an artifact after issuance. The fraud route only ever *releases on proof* or *blocks*; it cannot approve beyond an artifact's bounds. Track 2's constraint is satisfied here by construction: Pramaan's only actions are refuse, record, and prove.

| Where | Command |
|---|---|
| `src/gate.ts` (exhaustive refusal paths); `src/passthrough.ts` | `npx vitest run test/gate.test.ts test/passthrough.test.ts` |

### 9. Test mode only

`.env.example` documents exactly two Razorpay variables, both test-mode; `src/razorpay.ts` guards that the key id starts `rzp_test_` and the heartbeat aborts any commit containing a live-key marker. No live key can run here.

| Where | Command |
|---|---|
| `.env.example`; `src/razorpay.ts` guard | `grep -n "rzp_test" src/razorpay.ts` |

---

## The rubric, mapped

The track brief's bars (rows 1–6), each with its proof pointer:

| # | Bar (from the track brief) | Proof in this repo |
|---|---|---|
| 1 | Explainable money actions | `src/gate.ts` reason codes — `npx vitest run test/gate.test.ts` |
| 2 | Bounded + gated | Scope-enforcement tests in the same suite; boundary cases included |
| 3 | No payment without a valid artifact | `test/routes.test.ts` no-artifact test — `npx vitest run test/routes.test.ts` |
| 4 | Measured on held-out data | `npm run batch` → `metrics/report.json` + `metrics/summary.md` (seeded, reproducible) |
| 5 | Honest exceptions + false-positive cost | `metrics/summary.md` § Exceptions |
| 6 | Audit trail + one graceful failure | `npx vitest run test/ledger.test.ts` (tamper detection); `npm run demo` (documented refusal) |

---

## Reproducing the batch without Razorpay keys

```bash
PRAMAAN_STUB_PAYMENTS=1 npm run batch
```

The stub is the documented fallback (`src/razorpay.ts`): deterministic fake order ids, flagged in `/health` and recorded honestly — never silent. CI runs this way too (see [.github/workflows/verify.yml](.github/workflows/verify.yml)); with real test keys in `.env` the batch exercises the live test-mode rails instead.

---

## One more thing to try (tamper with the past)

The evidence system only means something if the ledger can defend itself. The tamper test in `test/ledger.test.ts` does this for you; if you want to feel it, open `data/pramaan.db` after a demo run, edit any row's payload by hand, and re-verify — `verifyChain()` names the exact row where the chain broke.
