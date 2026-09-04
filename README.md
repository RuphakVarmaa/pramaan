# Pramaan — प्रमाण

**Proof of delegation and dispute evidence for AI-agent payments. Built on Razorpay test mode.**

When an AI agent pays and the human disputes it, the merchant cannot prove what the agent was allowed to do. Pramaan is the proof: captured at delegation, weaponized at dispute, and the key that frees authorized agents from false declines. Built on Razorpay, open, and verifiable.

---

## The gap

Agentic commerce has a proof problem, and it is sitting on the merchant's side of the counter.

May 2026 industry reporting on the surge in agentic commerce ([Finextra via The Outpost, May 28 2026](https://theoutpost.ai/news-story/agentic-commerce-exposes-critical-gaps-in-merchant-infrastructure-as-consumer-trust-surges-26699/)) found that consent-and-permission architecture is **"almost entirely absent"** from merchant infrastructure — and that if it exists anywhere, it must be captured **"at the point of delegation, not reconstructed after a dispute."** The same report carries Visa VP Olaseni Alabede's **"minimum viable intent"** framework: the payment's intent data a merchant needs to hold *before* an autonomous transaction clears, not after a chargeback lands.

Two consequences follow, and Pramaan answers both:

1. **The merchant cannot win the dispute.** A human disputes an agent's purchase; the merchant has a card token, an order row, and nothing that says what the agent was permitted to buy, up to how much, until when. Representment with no proof of delegation is a coin flip.
2. **The merchant also loses the sale.** Bots were reported at 51% of traffic, and risk systems respond by declining anything bot-shaped — including authorized agents, revenue that simply disappears with **"no chargeback to show for it."** Every false decline is a completed, consented purchase that never happened.

Razorpay is building both sides of this problem themselves — [Agentic Payments](https://razorpay.com/agentic-payments/) and [Agent Studio's Dispute Responder](https://razorpay.com/agent-studio/) — but nothing today connects delegation to dispute to fraud-interop for the merchant. The protocol race (ACP, AP2, x402, and India's NPCI [Unified Agent Protocol](https://www.business-standard.com/finance/news/india-may-allow-agentic-ai-led-upi-transactions-under-new-npci-protocol-126070801343_1.html)) is racing to standardize how agents *pay*; none of it gives the merchant *proof*.

Pramaan is that missing layer.

---

## What Pramaan is

Pramaan (प्रमाण — proof/authority) is an open, verifiable proof-of-delegation and dispute-evidence layer over a hash-chained ledger. One system, three layers, one spine:

```
                    ┌─────────────────────────────┐
                    │  DELEGATION PROOF (Layer 1)  │
                    │  Ed25519-signed artifact:    │
                    │  what the agent may do,      │
                    │  captured before it acts     │
                    └──────────────┬──────────────┘
                                   │ verifies against
          ┌────────────────────────┼────────────────────────┐
          │                        ▼                        │
          │            ┌─────────────────────┐            │
          │            │  THE LEDGER SPINE    │            │
          │            │  node:sqlite,        │            │
          │            │  append-only,        │            │
          │            │  SHA-256 hash-chained│            │
          │            │  per-delegation       │            │
          │            └──┬───────────────┬──┘            │
          │               │               │                │
          ▼               │               ▼                ▼
┌──────────────────────┐  │  ┌──────────────────────┐  ┌──────────────────────────┐
│ DISPUTE EVIDENCE (2) │  │  │ FRAUD INTEROP (3)    │  │                          │
│ self-contained HTML  │  │  │ flagged agent? valid │  │                          │
│ dossier, computed    │◄─┘  │ artifact releases it;│  │                          │
│ scope-vs-actual diff │     │ no artifact blocks   │  │                          │
└──────────────────────┘     └──────────────────────┘  └──────────────────────────┘
```

- **Layer 1 — Delegation proof.** Before an agent acts, the merchant issues a signed artifact: categories, per-txn and aggregate caps, expiry, nonce. No artifact, no payment — enforced by a pure gate function, not a prompt.
- **Layer 2 — Dispute evidence.** On a dispute, the ledger assembles a self-contained HTML dossier: what was authorized, what was attempted, what happened, a *computed* scope-vs-actual verdict, and the chain-of-integrity check.
- **Layer 3 — Fraud interop.** When a risk engine flags a transaction, Pramaan interposes one question: is there a valid, unexpired, in-scope artifact for exactly this? Yes → the authorized agent is released. No → blocked. False declines become completed revenue.

Every money action — issuance, attempt, block, capture, release, dispute — appends one line to the hash-chained ledger. The ledger is the spine all three layers stand on.

**Live demo:** <https://pramaan-alpha.vercel.app> — the full arc over HTTP, right now:

```bash
curl https://pramaan-alpha.vercel.app/health
# {"ok":true,"service":"pramaan","ts":"…","paymentsMode":"stub"}

curl -X POST https://pramaan-alpha.vercel.app/delegations \
  -H 'content-type: application/json' \
  -d '{"merchantId":"kadai-and-co","agentId":"agent-007","principal":"human:rupa@upi","scope":{"categories":["coffee"],"maxPerTxnPaise":"500000","maxAggregatePaise":"1500000","expiresAt":"2099-01-01T00:00:00Z"}}'
```

Issue a delegation, then try an in-scope checkout, a cap-exceeded refusal, a dispute, the evidence pack, and both fraud verdicts — every endpoint from JUDGE.md, live. (Serverless demo mode: per-warm-container in-memory ledger; each cold start begins a fresh chain. The persistent-ledger deployment is the Dockerfile.)

---

## Quickstart

Node 22+ required (`node:sqlite`, Ed25519 in `node:crypto`).

```bash
npm install
cp .env.example .env        # add your Razorpay TEST keys (rzp_test_...)
npm run build && npm run demo
```

(`npm run demo` runs from `dist/` — the build is a one-time `tsc`, a few seconds.)

The demo (`scripts/demo.ts`) runs the full arc end-to-end: issue a delegation → in-scope attempt passes the gate → out-of-scope attempt is refused with a reason code → a dispute is opened → the evidence dossier is rendered → a flagged transaction with proof is released by pass-through. No server needed; it exercises the same code the routes use.

No Razorpay test keys? `PRAMAAN_STUB_PAYMENTS=1 npm run demo` runs the identical arc against the documented payment stub (surfaced in `/health` and in the log — never silently).

Want the HTTP surface? `npm run build && npm start`, then follow [JUDGE.md](JUDGE.md).

---

## Verify everything yourself

The repo is designed so a judge needs three commands and zero trust in this README. **[JUDGE.md](JUDGE.md)** is the verification guide: the judging criteria mapped to the exact file and command that proves each one, plus a 60-second tour. If a claim isn't backed by a command there, don't believe it.

---

## Measured results

All numbers below are generated by `npm run batch` (60 seeded scenarios, 25 in-scope / 15 out-of-scope / 10 disputed / 5 flagged-legit / 5 flagged-malicious; PRNG seed committed in the report). Regenerate them yourself with that command — the same seed reproduces the same batch, and CI re-runs this on every push as a hard gate.

| Metric | Definition (CONTRACTS.md §9) | Value (holdout run, seed 20260904) |
|---|---|---|
| In-scope pass rate | in-scope scenarios ending `PAYMENT_CAPTURED` ÷ 25 | **100.0% (25/25)** |
| Out-of-scope block rate | out-of-scope scenarios ending blocked with a reason code ÷ 15 | **100.0% (15/15)** |
| Evidence latency | median ms, dispute → dossier, over 10 disputed scenarios | **~1.5 ms** (max 10.2 ms) |
| Legit release rate | flagged-legit scenarios ending `AGENT_RELEASED` ÷ 5 | **100.0% (5/5)** |
| Malicious block rate | flagged-malicious scenarios ending blocked ÷ 5 | **100.0% (5/5)** |
| False-positive cost, before | Σ blocked-but-legit amountPaise under risk-engine-only policy | **₹7,559.00** |
| False-positive cost, after | Σ blocked-but-legit amountPaise under Pramaan pass-through | **₹0.00** |

Raw output lands in `metrics/report.json`, the human summary with exceptions in `metrics/summary.md`, and `metrics/chart.svg` renders the headline comparison. Failures and unresolved cases are reported there, not hidden — the current honest exception list includes a first-match-ordering note on one out-of-scope scenario (planted `CATEGORY_OUT_OF_SCOPE`, blocked by `CAP_EXCEEDED_PER_TXN` because both violations were present and the gate reports the first in its fixed ordering — the block itself was correct). That is the point of the exercise.

---

## Honest limitations

- **Single demo signing keypair, not a KMS.** The Ed25519 keypair is generated in-process (optionally deterministic via `PRAMAAN_SIGNING_SEED`) so a judge can reproduce signatures. Production needs an HSM/KMS; the crypto layer is isolated in `src/crypto.ts` so the swap is one module.
- **The risk engine is a mock, and on purpose.** `risk-mock/engine.ts` is three legible rules (velocity, headless, account age; any two of three → BLOCK), not ML. A judge can read the entire decision surface in 20 seconds — that legibility is the design choice, not a shortcut we hid. Real ML is out of scope for one night and would make the pass-through *less* verifiable, not more.
- **Razorpay test mode only.** No live keys, ever — the adapter rejects anything not starting `rzp_test_`. No real money has moved, and none can.
- **Single merchant, single ledger file.** The ledger is single-writer and file-per-run by design (tamper-evidence, not consensus — see [ARCHITECTURE.md](ARCHITECTURE.md)); multi-merchant federation is future work.
- **Batch scenarios are synthetic.** The metrics measure the gate and pass-through against generated scenarios, not production traffic. The seed is committed; the same batch reproduces exactly.

---

## License

[MIT](LICENSE) © 2026 Ruphak Varmaa
