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

<!--

The sections below are the Orchestrator's to fill as the night proceeds.
Keep the voice: what happened, what was confusing, what fixed it, what it cost.

### (TBD-1) — Incident slot: reserved for the next real incident
_Orchestrator: date, time, what happened, what was confusing, the fix, the lesson._

### (TBD-2) — Incident slot: reserved
_Orchestrator: as above._

### (TBD-3) — Incident slot: reserved
_Orchestrator: as above._

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
