# Pramaan — 5-Minute Pitch Video Script

> Rehearse to these timings. The structure is fixed; the demo moments map 1:1 to
> `npm run demo` (terminal) and the console click-paths in `web/DEMO_SCRIPT.md`.
> Record at 1920×1080, dark terminal, JetBrains Mono. No dead air — cut between beats.

---

## 0:00–0:30 — The industry gap (cited, on screen)

**Screen:** the two citations, large, on a dark background. Read them aloud.

> "When an AI agent pays on a human's behalf and the human disputes it, the
> merchant cannot prove what the agent was allowed to do."
>
> That's not my claim. May 2026, Finextra and The Outpost: the consent
> architecture agentic transactions require is — quote — **"almost entirely
> absent"** from merchant infrastructure, and must be captured — quote —
> **"at the point of delegation, not reconstructed after a dispute."**
>
> Visa's own VP of Product published the framework for fixing it: *minimum
> viable intent* — who is the agent, who authorized it, what can it do,
> and can we trace it?

**Screen:** the Razorpay context, one line:

> Razorpay is building both sides — Agentic Payments with NPCI, and Agent
> Studio's Dispute Responder. Nobody connects them for merchants.

## 0:30–1:00 — Pramaan in one sentence + the triangle

**Screen:** the three-layer triangle diagram (from README/ARCHITECTURE.md).

> Pramaan is the missing trust layer. Three layers over one hash-chained
> ledger:
>
> **One** — delegation proof: what the human authorized, captured
> cryptographically at the moment of delegation. An Ed25519-signed artifact:
> scope, caps, expiry, merchant. Not a session. A proof.
>
> **Two** — dispute evidence: when the chargeback comes, one command renders
> a forensic dossier proving the agent acted within its mandate.
>
> **Three** — fraud pass-through: legitimate agents look like bots and get
> falsely declined. Pramaan frees them — on proof, not on vibes.

## 1:00–2:00 — Demo moments 1 + 2 (purchase + graceful failure)

**Screen:** the console (or `npm run demo`).

> Watch the whole story on one screen. [Panel A] Rupa issues her agent a
> bounded mandate: coffee and pantry, five hundred rupees per transaction,
> fifteen hundred lifetime. Here's the artifact — signed, scoped, expiring.
>
> [Panel B] The agent buys the Chikmagalur peaberry — in scope, under cap.
> The gate allows it, and every money action lands on the ledger [Panel C]:
> issued, allowed, captured — each row hash-chained to the last.
>
> Now the failure — because the product is the refusal. [Panel B] The agent
> tries to stock the whole kitchen: over the cap. The gate says no —
> machine-readable reason code, CAP_EXCEEDED_PER_TXN — and the refusal
> itself is a ledger line. No payment, no order, no ambiguity. The agent
> can self-correct. That's the graceful failure the track asks for.

## 2:00–3:00 — Demo moment 3 (the 30-second evidence pack)

**Screen:** Panel D → open dispute → generate evidence pack.

> Six weeks later, the statement shows the charge. Rupa disputes it.
> [Panel D] One command — and in under two seconds, the dossier:
> Exhibits A through E. What was authorized. Every attempt, with verdicts
> and reasons. What actually moved. A computed scope-vs-actual verdict —
> not asserted, computed from the data. And the chain-of-integrity proof.
>
> This is the document a payments network accepts. This is the merchant's
> answer to "I never authorized this" — timestamped, hash-chained,
> self-contained.

## 3:00–4:00 — Demo moment 4 (agent release + the numbers)

**Screen:** Panel E → flagged transaction → RELEASE.

> Layer three. A legitimate agent trips the fraud system — high velocity,
> headless. The risk engine says block. Pramaan asks exactly one question:
> can it present a valid, unexpired, in-scope artifact for *this* transaction?
> It can. [RELEASE — PRAMAAN_DELEGATION_PROOF] The impostor, with no proof?
> Blocked.
>
> **Screen:** the metrics table (from README, seeded, reproducible):
>
> Measured on a sixty-scenario seeded batch: in-scope pass rate twenty-five
> of twenty-five. Out-of-scope blocks fifteen of fifteen. Flagged-legit
> released five of five; malicious blocked five of five. And the number the
> rubric literally asks for — false-positive cost: seven thousand five
> hundred fifty-nine rupees lost before Pramaan, zero after. Reproduce every
> number yourself: `npm run batch`. It's the same in CI, on every push.

## 4:00–4:40 — Honest limitations + what's next

**Screen:** the limitations list (from README).

> What this is not: the signing key is a demo keypair, not a KMS. The risk
> engine is three legible rules, not ML — you can read its entire decision
> surface in twenty seconds, and that's the design choice. Test mode only.
> Next: UAP-shaped artifact export, multi-merchant federation, and the
> payment.captured webhook driving the capture row in production.

## 4:40–5:00 — Close

**Screen:** the repo URL, large. The winning sentence beneath it.

> When an AI agent pays and the human disputes it, the merchant cannot
> prove what the agent was allowed to do. Pramaan is the proof — captured at
> delegation, weaponized at dispute, and the key that frees authorized
> agents from false declines. Built on Razorpay, open, and verifiable.
>
> github.com/RuphakVarmaa/pramaan

---

## Recording checklist

- [ ] Terminal font: JetBrains Mono (self-hosted in `web/public/fonts/`)
- [ ] Every action visibly lands on Panel C — zoom the ledger on each beat
- [ ] The refusal moment stays calm: amber documented-refusal, not red-alert
- [ ] Metrics slide: the actual table from README (seed 20260904)
- [ ] One take per demo moment; cut together — no re-shooting the whole thing
- [ ] Upload unlisted to YouTube; put the link + repo URL + ARCHITECTURE.md in the application form
