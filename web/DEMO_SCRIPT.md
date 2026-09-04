# Pramaan Console — Demo Script (≈5 minutes)

**Setup:** `cd web && npm run dev` → open the printed URL (default
`http://localhost:5175`). No backend needed — the console boots in MOCK
ENGINE mode (see top-right). The ledger already has 4 seeded entries so the
screen never looks empty.

**Camera notes:** the layout is one screen — A (far left) → B → C (dominant
center) → D/E (right rail). Keep Panel C visible at all times; every moment
below lands a row on it.

---

## Moment 0 — The premise (30s)

- Open on the full desk. Read the masthead: *"प्रमाण — a desk where a human
  supervises machine spending."*
- Point at Panel C: the hash-chained ledger, seeded with history. Hover a
  hash cell (`a1b2…ef → c3d4…90`) to reveal the full 64-char `prev_hash` /
  `self_hash` and the canonical-JSON commit description.
- Click **VERIFY CHAIN**. Badge: `CHAIN VERIFIED · 4 ENTRIES`, footer flips to
  `INTEGRITY: VERIFIED`.

**Say:** *"Pramaan is a proof-of-delegation and dispute-evidence layer for
AI-agent payments. Every money action — allowed, refused, disputed — lands on
this hash-chained ledger. Nothing updates, nothing deletes."*

---

## Moment 1 — Issue a delegation (60s)

1. **Panel A.** Principal is prefilled (Rukmini Desai). Pick agent **Arjun —
   Household Buyer**.
2. Categories: leave **coffee + pantry** on (tap equipment/merch off if on).
3. Caps: per-txn **₹800.00** (80000 paise), aggregate **₹2,500.00**
   (250000 paise), expiry 30 min.
4. Click **Issue Delegation →**

**What happens:** the Ed25519-signed artifact JSON appears, syntax-tinted
monospace, with signature line `ed25519:…` and a **COPY** button.
**Panel C lands: `DELEGATION_ISSUED`** (violet, `INFO`).

**Say:** *"The merchant signs a delegation artifact: this agent may buy coffee
and pantry only, ₹800 per transaction, ₹2,500 total, expiring in 30 minutes.
The signature is verifiable, the scope is machine-checkable."*

---

## Moment 2 — In-scope purchase (60s)

1. **Panel B.** The delegation from Moment 1 is auto-selected; the scope note
   under it restates the mandate.
2. Catalog (real Kadai & Co. catalog): add **Chikmagalur Peaberry 250g ×1**
   (₹520.00). Cart total: ₹520.00.
3. Click **Attempt Payment →**

**What happens:** verdict card — **"Allowed."** (green serif), reason `OK`,
order id `order_4101`, pointer to ledger seq.
**Panel C lands: `ATTEMPT_ALLOWED` ₹520.00**.

**Say:** *"The agent shops the real catalog. The gate checks the basket
against the artifact — category, per-txn cap, aggregate, expiry — before any
money moves. ₹520 against a ₹800 cap: allowed."*

*(Optional beat: add the ₹1,459 V60 kit → `CATEGORY_NOT_IN_SCOPE` — equipment
was never in scope.)*

---

## Moment 3 — Cap-exceeded refusal (60s)

1. Still Panel B. Set qty on **Chikmagalur ×2** (cart total ₹1,040.00).
2. Click **Attempt Payment →**

**What happens:** the verdict card is **typographically calm, never
red** — amber serif **"Documented refusal."**, reason code
`CAP_EXCEEDED_PER_TXN`, prose: *"The basket exceeds the artifact's
per-transaction cap…"*, and a rotated stamp: `REFUSED · CAP_EXCEEDED_PER_TXN`.
**Panel C lands: `ATTEMPT_BLOCKED`** with the same reason code.

**Say:** *"₹1,040 against an ₹800 cap. The gate refuses — but this is a
documented refusal: machine-readable reason code, ledger line, evidence
preserved. Not an error. A record."*

*(Optional beat: keep buying under-cap combos until `CAP_EXCEEDED_AGGREGATE`
fires — the aggregate cap is cumulative and enforced.)*

---

## Moment 4 — Dispute + evidence pack (75s)

1. **Panel D.** The captured transaction from Moment 2 (`#006`, ₹520.00) is
   preselected in the list.
2. Reason: **UNAUTHORIZED_TRANSACTION** → click **Open Dispute**.
   **Panel C lands: `DISPUTE_OPENED`** (cyan).
3. Click **Generate Evidence Pack**.
   **Panel C lands: `EVIDENCE_GENERATED`**.
4. The dossier renders in the iframe: warm paper, serif, **ExHIBITS A–E** —
   cover block, delegation artifact, contested transaction, hash-chained
   ledger extract, chain-integrity statement with the `PRAMAAN · CHAIN
   VERIFIED` seal — IST timestamps throughout, sha256 footer.
   **Open pack in new tab** shows it full-size.

**Say:** *"The principal disputes. Pramaan assembles the evidence
automatically from the ledger: the signed artifact, the contested
transaction, the chain extract. Exhibits A through E, timestamps in IST,
a sha256 footer — this is what the acquiring bank receives."*

---

## Moment 5 — Fraud release (45s)

1. **Panel E.** The flag feed shows bot-flagged Razorpay test payments —
   `HIGH_VELOCITY`, `HEADLESS_BROWSER`, `NEW_ACCOUNT` signal tags.
2. With **valid delegation artifact presented** checked, click **Run Pramaan
   Gate** → **RELEASE**: green seal, `PRAMAAN_DELEGATION_PROOF`.
   **Panel C lands: `AGENT_RELEASED`.**
3. Uncheck the artifact, run again on the other flag → **BLOCK**:
   amber seal, `NO_VALID_DELEGATION`.
   **Panel C lands: `ATTEMPT_BLOCKED`.**

**Say:** *"The payment gateway flags bot-like activity — high velocity,
headless browser. Normal fraud systems would eat the decline. Pramaan
checks the delegation proof: authorized agent spending inside scope gets
released; no proof, no release."*

---

## Close (15s)

Click **VERIFY CHAIN** once more. The badge recounts every entry — every
moment of this demo is now rows in an unbroken chain.

**Say:** *"Five panels, one screen — and one ledger. A human supervises
machine spending, and every decision the machine makes leaves evidence."*
