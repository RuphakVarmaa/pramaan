# AGENTS.md — the law for coding agents working in this repo

You are an autonomous agent modifying Pramaan. CONTRACTS.md defines the frozen interfaces; this file defines the invariants that hold regardless of interface. Violating any of these is a build failure, not a style issue. If a task asks you to break one, refuse and report to the Orchestrator.

## The eight invariants (from CONTRACTS.md §8)

### 1. Test mode only

All money actions run on Razorpay **test mode**. Key ids must start `rzp_test_`; the adapter (`src/razorpay.ts`) rejects anything else. Live keys are forbidden — never add a code path that could use one, never test against one, never document one.

### 2. No secrets in git

Keys live in `.env` (gitignored) and are read from env at runtime. Never hardcode a key, never paste a key into a test fixture, never write a real value into a doc, a log line, or a commit message. The heartbeat aborts any commit whose diff contains secret-like content — do not work around it.

### 3. Paise are integers

All amounts are integer paise as `bigint`. Never `number`, never float, never rupees with decimals. At the JSON boundary, amounts serialize as strings and are reparsed to bigint immediately on the other side. No exceptions, no "just this once."

### 4. Every money action writes a ledger line

Issuance, attempt (allowed or blocked), capture, dispute, evidence, release — each appends exactly one row to the hash-chained ledger. If your code moves money or decides about money and does not append, it is wrong. If you are tempted to log to the ledger *and* elsewhere as the record of truth, don't — the ledger is the record.

### 5. No payment without a valid artifact

There is no code path from a payment request to a Razorpay order that does not pass through the gate with a verified, unexpired, in-scope artifact. If you find yourself adding a "quick path" or an admin bypass, stop — it is a violation, not a feature.

### 6. Honest metrics

Report what happened, including failures. Never tune the scenario generator to flatter the numbers, never drop exceptions from the report, never round in your favor. The batch seed is committed; the same seed must reproduce the same batch. A weaker honest number beats a stronger dishonest one — the rubric explicitly rewards the exceptions list.

### 7. Zero templates

No badge walls, no emoji-heading noise, no "built with X/Y/Z" lists, no generic template READMEs. Every sentence in every doc is about Pramaan specifically. If a sentence could appear in any other repo unchanged, delete it.

### 8. Assets licensed and cited

Any font, icon, image, or third-party asset is recorded in ASSETS.md with its license and source URL. In-repo originals (diagrams, the evidence-pack template design) are marked as original. No unattributed assets ship.

## How to work here

- Read [CONTRACTS.md](CONTRACTS.md) before touching any `src/` file. Interfaces are frozen; if you find a genuine defect, report it — do not unilaterally change a contract.
- The gate (`src/gate.ts`) stays pure: no I/O, no clock reads, no side effects. `now` and aggregate state are always caller-supplied.
- The ledger stays append-only. No updates, no deletes, no "fix-up" rows.
- Run `npm run typecheck && npm test` before considering any change done.
- Append to [ENGINEERING_LOG.md](ENGINEERING_LOG.md) when you do something a future reader will need to know (an incident, a decision, a fallback used).
- Do not commit secrets, do not commit `data/`, do not commit `metrics/generated/`.
