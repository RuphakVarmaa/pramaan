# PAPER.md — Proof of Delegation: closing the missing layer of agentic commerce

**Pramaan (प्रमाण — proof/authority) · working paper · September 2026**

---

## 1. The problem

Agentic commerce is being built faster than it is being proven. Autonomous agents initiate payments on a merchant's rails today — in-chat UPI via NPCI pilots, agentic checkout via the emerging protocol race — yet the merchant-side record of *what an agent was authorized to do* does not exist at the moment it matters.

May 2026 industry reporting frames the gap precisely: consent-and-permission architecture is **"almost entirely absent"** from merchant infrastructure, and where it must exist is **"at the point of delegation, not reconstructed after a dispute"** ([Finextra via The Outpost, May 28 2026](https://theoutpost.ai/news-story/agentic-commerce-exposes-critical-gaps-in-merchant-infrastructure-as-consumer-trust-surges-26699/)). The same coverage carries Visa VP Olaseni Alabede's **"minimum viable intent"** framework — the minimum intent data a merchant must hold before an autonomous transaction, not after.

Two losses follow from the same absence:

1. **The unwinnable dispute.** A human disputes an agent's purchase. The merchant's representment evidence is an order row and a card token — nothing that establishes scope, caps, or expiry of the delegation. The dispute is decided without the only fact that matters.
2. **The invisible false decline.** Bot traffic was reported at 51% of traffic; risk engines respond by declining bot-shaped requests — including authorized agents. Each false decline is a *consented* purchase that never completes, revenue lost with **"no chargeback to show for it"** (same source). It never appears in any dispute metric, which is exactly why it is under-managed.

The protocol race — ACP (Stripe/OpenAI), AP2 (Google), x402 (Coinbase), and India's NPCI Unified Agent Protocol ([Business Standard, 2026](https://www.business-standard.com/finance/news/india-may-allow-agentic-ai-led-upi-transactions-under-new-npci-protocol-126070801343_1.html); [protocol comparisons](https://orium.com/blog/agentic-payments-acp-ap2-x402)) — standardizes how agents transact. None of it standardizes how a *merchant proves* an agent's authority after the fact. Razorpay ships both halves of the problem separately — [Agentic Payments](https://razorpay.com/agentic-payments/) on the outbound side, [Agent Studio's Dispute Responder](https://razorpay.com/agent-studio/) on the chargeback side — leaving the connective tissue, merchant-side delegation proof, unclaimed.

## 2. The protocol

Pramaan is one coherent system over one ledger — three layers, each worthless alone.

**The artifact (Layer 1).** Before an agent acts, the merchant issues an Ed25519-signed delegation artifact: principal, agent, allowed categories, per-transaction cap, aggregate cap, expiry, nonce. The artifact is hashed over canonical JSON and signed with the merchant's key. It is small enough to travel in every request body and specific enough to be the entire authorization basis.

**The gate.** A pure function evaluates a proposed transaction against the artifact: signature validity, expiry, category membership, per-txn cap, aggregate position (caller-supplied — the gate never reads state or clock). Every refusal names itself with a machine reason code (`ARTIFACT_EXPIRED`, `CAP_EXCEEDED_PER_TXN`, `CATEGORY_OUT_OF_SCOPE`, `SIGNATURE_INVALID`). No valid artifact, no payment — there is no other path to the payment provider.

**The ledger (the spine).** Every money action — issuance, attempt (allowed or blocked), capture, dispute, evidence, release — appends one row to an append-only SQLite ledger where each row's hash chains to its predecessor (SHA-256 over the row's canonical fields). The chain provides tamper-*evidence*: any edit of history is detectable by a single linear verification pass. The ledger is single-writer by design; consensus is a non-goal (§4).

**The evidence pack (Layer 2).** On dispute, the ledger span for the delegation is rendered into a self-contained HTML dossier: what was authorized, what was attempted (every row, including refusals and their reasons), what was captured, a **computed** scope-vs-actual verdict, and the chain-integrity check over the span. The verdict is derived from the data, never asserted — the dossier is as damning for an over-scope agent as it is exculpatory for an in-scope merchant.

**The pass-through (Layer 3).** When a risk engine flags a transaction, Pramaan interposes exactly one question: can the requester present a valid, unexpired, in-scope artifact for *this* transaction? Yes → release (and record the release). No → block. The flagged-but-authorized agent — the false-decline case — is freed by proof rather than by exception lists.

Together: **captured at delegation, weaponized at dispute, and the key that frees authorized agents from false declines.**

## 3. The economics

The two losses are asymmetric in observability, which is why only one is managed today.

**Disputes are visible but poorly evidenced.** A chargeback arrives, a merchant contests it, and the contest succeeds or fails largely on documentation quality. The evidence pack is a direct lever on representment win-rate: it converts "an agent bought this" into "the principal's signed delegation authorized exactly this, within these caps, and the record is tamper-evident." We claim directionality, not a measured win-rate delta — measuring that requires dispute-outcome data we do not have and will not pretend to.

**False declines are invisible but pure loss.** A declined authorized agent produces no chargeback, no ticket, no metric — just a purchase that did not happen and a customer who may not return. Under a risk-engine-only policy, every flagged-legit transaction is lost revenue at full margin on the goods plus any retry cost the customer never pays. The pass-through converts that class of loss to completed revenue *when and only when* proof exists; it carries no new fraud exposure, because release requires the same artifact the gate would demand for payment.

The combined economic shape: **one system, two revenue defenses** — dispute win-rate on one side, recovered false declines (lost revenue with no chargeback to show for it) on the other — both riding the same artifact and the same ledger.

## 4. Design choices (and their honest limits)

- **Hash chain, not blockchain.** The threat model is tamper-evidence for a single merchant's own record, not Byzantine agreement among competitors. A chain plus a verify pass answers the actual question — "was this ledger edited?" — at zero additional infrastructure.
- **Ed25519, `node:crypto`, `node:sqlite`, plain `fetch`.** Every trust-critical component is readable in the standard library. Verifiability by a skeptical third party is the product; a dependency pile undermines it.
- **A legible mock risk engine.** Three signals, any-two-of-three, thresholds in source. An opaque engine would make the pass-through unauditable — the opposite of the design goal. Real ML integration is future work, behind the same single question.
- **Single demo keypair, not a KMS.** Reproducible for evaluation; production deployment requires key custody we do not pretend to provide in a test-mode build.
- **Test mode only.** No live keys, no real money, by hard constraint in code.

## 5. Evaluation

Methodology (frozen in CONTRACTS.md §9): **60 scenarios generated by a seeded PRNG** — 25 in-scope, 15 out-of-scope, 10 disputed, 5 flagged-legit, 5 flagged-malicious — run as a batch; the seed is committed and the batch is reproducible. Held-out discipline is structural: the gate's rules and the pass-through's single question are fixed before any scenario is scored, and thresholds are never tuned against the scored set.

Metrics reported per the definitions: in-scope pass rate, out-of-scope block rate, evidence latency (dispute → dossier), legit release rate, malicious block rate, and false-positive cost measured under both policies (risk-engine-only vs. pass-through). The exceptions list — every scenario the system resolved incorrectly or could not resolve — ships in the same report as the headline numbers.

Numbers (holdout run, seed 20260904 — regenerate any figure with `npm run batch`):

| Metric | Result |
|---|---|
| In-scope pass rate (n=25) | 100.0% |
| Out-of-scope block rate (n=15) | 100.0% |
| Evidence latency, median (n=10) | ~1.5 ms (max 10.2 ms) |
| Legit release rate (n=5) | 100.0% |
| Malicious block rate (n=5) | 100.0% |
| False-positive cost, before vs. after (n=5 flagged-legit) | ₹7,559.00 → ₹0.00 |
| Exceptions | 1 honest exception: one out-of-scope scenario planted `CATEGORY_OUT_OF_SCOPE` but was blocked with `CAP_EXCEEDED_PER_TXN` (both violations present; the gate reports the first in its fixed ordering — the block was correct, the planted label was not). See `metrics/summary.md` § Exceptions. |

## 6. Limitations, stated plainly

Synthetic scenarios, not production traffic; single merchant, single writer; a mock risk engine standing in for a real one; a demo keypair standing in for custody; no measured dispute win-rate delta (we claim the lever, not the number). Each limitation is a scoped bet: that the mechanism — proof at delegation, evidence at dispute, release on proof — is the durable part, and everything it stands in for can be swapped in behind the same contracts.

## 7. Reproduce everything

The claims in this paper are checkable from the repo: `npm run demo` (the full arc), `npx vitest run test/gate.test.ts test/ledger.test.ts test/routes.test.ts` (the mechanisms), `npm run batch` (every number above, seed included). See [JUDGE.md](JUDGE.md) for the criterion-by-criterion map.

---

*References: [Finextra via The Outpost (May 28, 2026)](https://theoutpost.ai/news-story/agentic-commerce-exposes-critical-gaps-in-merchant-infrastructure-as-consumer-trust-surges-26699/) · [Razorpay Agentic Payments](https://razorpay.com/agentic-payments/) · [Razorpay Agent Studio](https://razorpay.com/agent-studio/) · [Razorpay × NPCI agentic UPI](https://razorpay.com/blog/agentic-payments-and-npci/) · [NPCI UAP coverage, Business Standard](https://www.business-standard.com/finance/news/india-may-allow-agentic-ai-led-upi-transactions-under-new-npci-protocol-126070801343_1.html) · [Agentic payment protocols compared](https://orium.com/blog/agentic-payments-acp-ap2-x402) · [Razorpay Buildathon](https://razorpay.com/buildathon/)*
