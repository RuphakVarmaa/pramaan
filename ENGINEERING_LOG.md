# ENGINEERING_LOG.md — the build, honestly

A dated log of what actually happened while building Pramaan. Incidents included, not sanitized. Times are IST (Asia/Kolkata), 2026-09-04 onward.

---

## 2026-09-04 (evening → night)

### 20:30 — Research frozen

The program dossier (razorpay-buildathon/) is complete: all 5 track briefs verbatim, 20 competitor repos mapped, sources for every claim. Track 01 picked — Razorpay's own flagship direction, and the field is empty exactly where the hard problem is: merchant-side proof for agent payments. The core industry citations land on Finextra/Outpost (consent architecture "almost entirely absent", captured "at the point of delegation, not reconstructed after a dispute") and Visa VP Olaseni Alabede's "minimum viable intent" framework.

### 21:00 — Genesis

Repo created. Node 22 + TypeScript strict + Vitest; deliberately no database driver (`node:sqlite` ships in core), no crypto library (`node:crypto` Ed25519), no Razorpay SDK (plain `fetch`). The stack is the dependency list: one runtime, one framework (`fastify`), three dev tools. Everything a judge might distrust is something they can read in the standard library.

### 21:12 — CONTRACTS.md v1.0 frozen

Interfaces written before implementation: artifact schema, ledger row format and hash rule, gate reason codes, the full route table, evidence-pack exhibits A–E, the pass-through flow, batch scenario mix (60: 25/15/10/5/5), env vars, module ownership per swarm. The rule for the night: a swarm that finds a contract defect reports it; it does not edit the contract. The money invariant is set here for the first time — integer paise as bigint, strings at the JSON boundary, never `number`.

### 21:15 — Swarms spawned

- **S1 CORE** — crypto, artifact, ledger (+ tests)
- **S2 RAILS** — Fastify routes, gate, Razorpay test-mode adapter with stub fallback
- **S3 EVIDENCE** — the HTML dossier + function-based template
- **S4 FRAUD** — pass-through + the deliberately legible mock risk engine
- **S5 BATCH** — scenario generator, runner, metrics (lands later in the night)
- **S6 CONSOLE** — React console (web/)
- **S7 PROOFS** — this file, README, JUDGE.md, ARCHITECTURE.md, llms.txt, AGENTS.md, PAPER.md, CI

The git heartbeat is started on `wip/auto`: checkpoint-commit every 5 minutes, with a secret scan before every commit.

### 21:40 — Incident: the heartbeat guard flagged itself

The heartbeat's secret scan includes a check for live-key markers (`rzp_live_...`). The first version of the scan carried the marker as a plain string literal in the script — so every time the heartbeat staged its own script for commit, the scan matched the literal inside the script and aborted the commit. The guard was blocking its own checkpoint as a "secret."

The failure signature was confusing at first glance: a clean tree, a passing scan on real secrets, and a heartbeat log full of `HEARTBEAT ALERT` with nothing in the diff that matched any `.env` value. The literal in the script itself was the only match.

**Fix:** assemble the marker at runtime so the file never contains the contiguous literal — `LIVE_MARKER="rzp""_live"` in bash concatenates two innocuous fragments into the search string only in memory. The scan's behavior is unchanged against real diffs; it just no longer self-matches. A secondary benefit of the runtime assembly: the committed script text doesn't itself model the very string it exists to catch, so future greps of the repo for live-key markers stay clean too.

**Lesson recorded:** a scanner that searches for forbidden literals must never carry those literals contiguously in its own source. Same class of bug as a profanity filter that won't run in the directory it protects. Caught because the heartbeat logs its refusals loudly rather than silently skipping — which is the behavior we want everywhere in this system.

### 22:05 — Incident: the heartbeat guard flagged the engineering log

Second false positive, different mechanism. The doc mention of the first incident (`rzp_live_...` inside backticks, in this very file) matched the bare live-marker scan. A documentation mention is not a secret; a bare `rzp_live` grep cannot distinguish prose from a key.

**Fix:** the guard now matches live-key *formats* (`rzp_live_` + 14+ alphanumerics) rather than the bare marker, and exact-value matching against real `.env` values remains the primary defense. Real keys are still caught by both; prose now passes. The deeper lesson is the same as the first incident's, one level up: the guard's model of "what a secret looks like" must be tight enough that honest text never trips it — otherwise people learn to ignore the alarm, and the alarm is the whole point.

### 22:15 — Incident: S2 (RAILS) died mid-flight; the integration gap

The RAILS swarm stopped partway through `src/app.ts` and `test/routes.test.ts`. What it left was structurally sound — a ports-and-adapters `buildApp(deps)` with the business logic still pure — but unfinished: seven type errors, a `server.ts` that never wired the real modules (it called helper names that don't exist: `createLedger`, `createSigner`, `loadCatalog`), and a route test written against an API it had invented rather than the frozen contracts (it even passed paise as JS numbers, violating the money invariant).

The confusing part: the test failures looked like *gate* bugs (`CAP_EXCEEDED_AGGREGATE` not firing) when they were actually *fixture* bugs — one test used `90_00n` (₹90) where the comment said ₹900, another had an arithmetic typo in an expected bigint. Reproducing the exact scenario with a contract-shaped fixture proved the gate correct in two minutes; the tests were wrong, not the code.

**Fix:** took ownership of S2's remains per the swarm protocol, reconciled everything to CONTRACTS.md — rewired `server.ts` to the real ledger/artifact/gate exports, aligned the test to the real `AppDeps` shape and field names (`artifactWire`, string paise), and added the missing `PAYMENT_CAPTURED` emission (honestly labeled with payment mode; a production build lands that row from the `payment.captured` webhook instead — documented in README's limitations). Also fixed two real server bugs found only by running it: a leftover `createSign(null)` crash in the signer, and `require()` calls inside an ESM module.

**Lesson recorded:** when a parallel swarm dies, its *tests* are the most dangerous artifact it leaves — they encode its intentions, not the contracts, and they fail in ways that misattribute blame to working code. Verify the fixture before suspecting the module. The live end-to-end run (all six demo moments over HTTP, curl against a booted server) is the only proof that actually closes the loop; unit tests alone had left the server unbootable twice.

### 22:47 — Evidence wired; the six demo moments green over live HTTP

`GET /evidence/:delegationId` now renders S3's forensic dossier for real: ledger span, dispute metadata, Exhibits A–E, computed scope-vs-actual verdict, chain-of-integrity proof, sealed footer. Issuance also writes the `data/artifacts.json` sidecar (Exhibit A's authoritative source), with the structured-reason fallback in the `DELEGATION_ISSUED` ledger row for when the sidecar is absent. The full curl-verified sequence: issue → in-scope order → cap-exceeded documented refusal → dispute → evidence pack → flagged-legit RELEASE (`PRAMAAN_DELEGATION_PROOF`) → flagged-malicious BLOCK (`NO_VALID_DELEGATION`), with the ledger showing every money action leaving a row (and `EVIDENCE_GENERATED` recording the pack's sha256).

<!--

The sections below were reserved for real incidents; see the filled entries
above (22:05, 22:15, 22:47). Further entries appended as they happen.

-->

---

## S4 (RISK) — Layer 3 passthrough landed: decisions worth knowing

**Date:** 2026-09-04, swarm S4 (risk layer)

**Category-handling choice (the one the mission asked to report):** the frozen
`FraudTransaction` type has no `category` field, but `/fraud/evaluate` carries
ONE purchase. `src/passthrough.ts` therefore defines
`FraudEvaluateTransaction = FraudTransaction & { category?: string }`. If the
tx carries a category, it must be inside `wire.scope.categories`; if it does
NOT, the category check is skipped (amount + merchant + caps + expiry still
enforced). Rationale: the passthrough cannot guess a category for a purchase
the caller never classified, and an absent category must not manufacture a
denial the issuer never expressed. The same rule is mirrored in S2's
`src/app.ts` bridge (synthetic in-scope category line) and in
`src/routes/fraud.ts`'s lazy bridge — the three call sites agree.

**Passthrough purity:** `pramaanFraudGate` writes NOTHING to the ledger. The
route (`src/routes/fraud.ts`, and S2's inline version in `src/app.ts`) owns the
rows: `AGENT_RELEASED` on delegation-proven releases, `ATTEMPT_BLOCKED` on every
BLOCK, and NO row on `RISK_ENGINE_CLEAR` (no interposition happened — there is
nothing to evidence). Fail-closed on unreadable spend history (aggregate
headroom unknown -> BLOCK).

**Aggregate headroom in passthrough:** computed route-side via injected
`aggregateSpent(artifactId)` against `wire.scope.maxAggregatePaise` — not folded
into `evaluateGate` — because S2's gate takes `aggregateSpentPaise` as an input,
and the passthrough already holds the artifactId. One source of truth.

**Contract-adjacent notes for the Orchestrator:**
1. `FraudVerdict.reason` includes `RISK_ENGINE_DENY` in the frozen type, but
   §6's flow never produces it (risk-BLOCK always resolves to NO_VALID_DELEGATION
   or PRAMAAN_DELEGATION_PROOF). Not a defect — just an unused enum member; the
   mock engine's own BLOCK is what a strict risk-deny would surface if the
   contract ever grows a risk-only deny path.
2. S2's `src/app.ts` implements `/fraud/evaluate` inline instead of registering
   `src/routes/fraud.ts`. Overlap exists; both follow the same §6 flow and
   ledger discipline (my route adds `ATTEMPT_BLOCKED` on BLOCK — S2's inline
   version appends `ATTEMPT_BLOCKED` too; the difference is my plugin also
   400s on malformed paise strings). Orchestrator to pick one at integration.
3. The mock engine (`risk-mock/engine.ts`) has ZERO imports from `src/` — the
   batch swarm can lift it verbatim. Thresholds are named consts:
   `VELOCITY_PER_MIN_LIMIT=5` (strict >), `MIN_ACCOUNT_AGE_DAYS=30` (strict <),
   `BLOCK_SCORE_THRESHOLD=2` (>=).

**Test proof (numbers):** 21/21 green — the seven mission scenarios (plus
aggregate-exhausted, wrong-agent, fail-closed spend, and category in/out), the
threshold matrix (velocity 5/6, age 29/30/31, headless t/f, 0/1/2/3-of-3), and
route-level ledger discipline via fastify inject (risk-clear writes nothing;
delegation-proven release writes exactly one AGENT_RELEASED row; every BLOCK
writes exactly one ATTEMPT_BLOCKED row).

## S3 (EVIDENCE) — Layer 2 dossier landed: decisions worth knowing

**Template location:** `src/templates/evidence.ts` (the §7-sanctioned TS-function
form; no template engine, single location).

**The footer digest cannot be self-referential.** A footer that displays
"sha256 of the full HTML" containing that digest is impossible in principle —
the digest would have to be its own preimage. Resolved honestly with TWO
well-defined digests: the API returns `sha256` of the delivered bytes
(verifiable by `shasum -a 256` — proven in tests), while the visible footer
seal is the sha256 of the document **with the seal field zeroed** (64 zeroes),
worded precisely and recomputable from the file alone. Both are stated in the
footer. Reported to the Orchestrator as a §5 wording defect ("SHA-256 of the
full rendered HTML" in-footer is unsatisfiable as literally written).

**Span verification vs. `verifyChain(rows)`:** S1's `verifyChain` assumes the
rows array starts at genesis, so it cannot verify a per-delegation span of an
interleaved ledger (span row N links globally to rows of OTHER delegations).
Exhibit E therefore (a) runs S1's `verifyChain` over the FULL ledger for the
global proof, and (b) independently recomputes each span row's selfHash
(mirroring the §2.2 wire-form hash exactly — proven identical in tests) and
checks linkage to the true global predecessor via seq-1 lookup. Both results
are shown. `recomputeSelfHash` is exported for that second opinion.

**Sidecar shapes (S2 must align):**
- `data/artifacts.json`: `{ [delegationId]: { artifact: DelegationArtifactWire, sig: string } }`
  — written at issuance by `/delegations`. Authoritative source for Exhibit A
  scope + cover merchant/agent/principal.
- `data/disputes.json`: per §5.1 `[{ disputeId, delegationId, amountPaise (string), reason, openedAt }]`
  — read for dispute metadata; ledger `DISPUTE_OPENED` row is the fallback.
Both tolerated when absent (graceful degradation, honestly worded in-pack).

**Exhibit D category data:** attempt rows must carry category info for the
per-line scope check. The structured reason
`{"categories":["coffee"],"skus":["KC-COF-CHIK-250"],"qty":2}` is parsed
(tolerantly: JSON, bare category token, gate codes pass through as-is).
`DELEGATION_ISSUED` reason may carry `{"scope":{...},"issuedAt":...}` as the
fallback when the artifacts sidecar is absent; when neither exists the pack
says "artifact details unavailable" and marks per-line checks `unknown`
rather than inventing data. Rows without category/amount show `unknown`, not
silently-passing checks.

**Money formatting:** `(paise/100n)` at the render boundary only; `Intl.NumberFormat('en-IN')`
with 0 fraction digits formats the rupee integer part (lakh grouping), paise
appended as `.padStart(2,'0')`. Tests prove ₹12,34,567.89 for 123456789n paise.

**Timestamps:** IST display everywhere (`Asia/Kolkata` via `toLocaleString`),
UTC ISO alongside in every details line. Masthead: "PRAMAAN — DELEGATION
EVIDENCE PACK" (CSS-uppercased), "EXHIBITS A–E", "CONFIDENTIAL — DISPUTE
REPRESENTMENT".

**Test proof:** 8/8 green — full-purchase dossier with all exhibits + computed
verdict sentence + external-shasum-matching digest; out-of-scope category
honesty; sidecar-absent fallback + honest-unavailable path; retroactive-edit
(tampered SQL) chain break detection; self-hash mirror identity; en-IN
formatting matrix; reason-parser tolerance; interleaved-delegations span
verification. Full suite at landing: 87/87 across 8 files.

---

### 23:50 — S5 BATCH lands: the measured proof (scripts + metrics)

**Delivered:** `scripts/gen-batch.ts` (seeded corpus generator, mulberry32,
seed 20260904 committed), `scripts/run-batch.ts` (runs the 60 scenarios on
the real modules — artifact, gate, ledger, evidence, passthrough — stub
payments, per-scenario `:memory:` ledgers, deterministic per-agent Ed25519
signers), `scripts/smoke.ts` (full-arc app smoke via `fastify.inject()`,
10 route steps, chain verify), `scripts/demo.ts` (the video arc: unicode
box-drawing narrative over the real modules, four demo moments, verifyChain
finale). Outputs: `metrics/report.json` (raw numbers + per-scenario detail +
seed), `metrics/summary.md` (human summary + exceptions), `metrics/chart.svg`
(hand-authored SVG, the false-positive before/after bar pair),
`metrics/generated/` (gitignored, 10 evidence packs per run).

**Headline numbers (seed 20260904, stub mode):** in-scope 25/25 captured;
out-of-scope 15/15 blocked with reason codes; evidence latency median
~0.7–1.5 ms (measured, not simulated — real dispute→dossier renders over
small ledger spans); flagged-legit 5/5 released on delegation proof;
flagged-malicious 5/5 blocked; false-positive cost ₹7,559 → ₹0.

**Incidents worth keeping:**

1. **Ed25519 public key is not the seed.** First signer derivation wrapped
   the same sha256 bytes as both PKCS8 private key and SPKI public key.
   Signing worked; verification failed for every artifact. Symptom was
   confusing: in-scope scenarios "passed" because their blocked outcomes were
   recorded (not thrown), and the first hard failure surfaced in the dispute
   path. Fix: derive the public key with `createPublicKey(createPrivateKey(...))`
   — node:crypto does the Ed25519 scalar multiplication. The corpus was never
   at fault.

2. **Risk-engine trigger arithmetic.** First flagging-signals generator drew
   combos like velocity-only (score 1 = ALLOW). Result: 3 of 5
   flagged-malicious scenarios sailed through as `RISK_ENGINE_CLEAR` —
   malicious block rate 40%, reported honestly in that run's exceptions.
   Root cause was mine (the generator's premise was "flagged" but the signals
   didn't flag). Fix: every combo now trips ≥ 2 triggers. The lesson: when a
   metric embarrasses you, check your harness before your system — but report
   the bad number while you check.

3. **`issueDelegation` cannot mint expired artifacts** (expiresAt must be >
   issuedAt at mint). The corpus therefore stores expiry OFFSETS in days and
   the runner materializes them against the real clock; the ARTIFACT_EXPIRED
   scenarios mint short-window artifacts and evaluate the gate after lapse.
   This is the honest construction — the expired-artifact test exercises a
   real issuance that genuinely expired, not a fabricated wire object.

4. **Paths from dist/.** Scripts run from `dist/scripts/`, so `../catalog.json`
   and `../metrics/` resolved inside `dist/` (tsc had copied a catalog there
   earlier — silently stale). Fix: `repoRoot()` walks up until `package.json`
   + `catalog.json` coexist.

**Exceptions list (final run):** 1 — out-of-scope#1 planted
CATEGORY_OUT_OF_SCOPE but the gate blocked with CAP_EXCEEDED_PER_TXN first
(the cart also tripped the per-txn cap; first-match ordering per CONTRACTS
§3). Informational, reported, not suppressed.

**Contract observations (reported, not fixed):**

- `app.ts` `LedgerAppendEvent` uses `T | null` for optional fields while
  `ledger.ts` `LedgerEvent` uses `T | undefined` — every adapter needs a
  null-strip shim. Cosmetic, but it cost every integrator a mapping function.

**Test proof at landing:** typecheck 0 errors; build clean; `npm run batch`,
`npm run smoke`, `npm run demo` all exit 0 from `dist/`; full suite 87/87
untouched. Batch reproducibility verified: two consecutive runs produce
identical outcomes (only wall-clock latency differs, as documented).
