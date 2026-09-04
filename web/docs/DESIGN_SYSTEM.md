# Pramaan Console — Design System

**Aesthetic:** forensic terminal meets editorial dossier. A desk where a human
supervises machine spending. The ledger is the protagonist.

This is a hand-rolled system — custom properties, no Tailwind, no component
library, no template palette. Every token below is declared in
`web/src/styles.css` under `:root`.

---

## 1. Color

### Ink (the console)
Dark, blue-black, slightly cold — the color of a terminal at night, not a
dashboard's neutral gray.

| Token | Hex | Use |
|---|---|---|
| `--ink-0` | `#0B0E11` | app background |
| `--ink-1` | `#10151A` | panel background |
| `--ink-2` | `#161D24` | raised surface (cart summary, verdict cards) |
| `--ink-3` | `#1E2730` | control surface (buttons) |
| `--line-0` | `#222C36` | hairline |
| `--line-1` | `#2E3A46` | border |
| `--line-bright` | `#3D4C5A` | hover border |

### Text on ink
| Token | Hex | Use |
|---|---|---|
| `--tx-0` | `#E8EDF2` | primary |
| `--tx-1` | `#AAB8C4` | secondary |
| `--tx-2` | `#61707E` | muted / metadata |
| `--tx-3` | `#3E4A55` | faint rules |

### Paper (the dossier)
The evidence pack renders in a warm paper world inside the iframe — the
console never turns paper, the paper never turns console. The boundary between
them *is* the design idea: machine ink vs. document paper.

| Token | Hex |
|---|---|
| `--paper-0` | `#EDE6DA` |
| `--paper-1` | `#F6F1E6` |
| `--paper-ink` | `#1D1A14` |
| `--paper-muted` | `#6B5D42` |

### Verdicts — typographic events first, color second
| Token | Hex | Meaning |
|---|---|---|
| `--verd-green` | `#3DD68C` | ALLOWED / RELEASED (on ink) |
| `--verd-green-deep` | `#2E7D32` | seals on paper |
| `--verd-amber` | `#E2B93B` | **documented refusal** — amber, never red |
| `--verd-cyan` | `#62C6D9` | chain links, hashes, disputes |
| `--verd-violet` | `#A78BFA` | delegation / artifact |

**Blocked ≠ red-alert.** A refusal is a *documented* event: amber, stamped
(`REFUSED · CAP_EXCEEDED_PER_TXN`), with a machine-readable reason code and a
pointer to the ledger line that records it. Red is reserved for nothing —
there is no emergency in this system, only evidence.

No default blue anywhere. No Tailwind palette. Cyan is our own (`#62C6D9`,
chain-and-hash identity), not `#3B82F6`.

---

## 2. Typography

Two self-hosted variable fonts (see `web/ASSETS-FONTS.md`):

- **JetBrains Mono** — the machine voice: ledger, hashes, reason codes, forms,
  panel keys, masthead meta. Weights 400–700.
- **Newsreader** (upright + italic, optical sizing) — the human/editorial
  voice: panel titles, verdict prose ("Allowed." / "Documented refusal."),
  cart totals, the dossier inside the evidence iframe, the tagline.

Scale (mono-dominant; serif for emphasis):

| Role | Font | Size | Weight |
|---|---|---|---|
| body / controls | mono | 13px | 400 |
| ledger rows | mono | 11.5px | 400 (type: 600) |
| panel title | serif | 15px | 600 |
| verdict word | serif | 19px | 700 |
| cart total | serif | 22px | 600, tabular |
| section labels | mono | 10px | 400, +0.14em tracking, uppercase |
| panel key (A–E) | mono | 10px | 400, +0.22em tracking |
| masthead wordmark | serif | 21px | 600 |

Fallbacks: `ui-monospace / SF Mono / Menlo` and `Iowan Old Style / Georgia`.

---

## 3. Spacing & layout

- Base unit 4px; panel padding 10–14px; gap between panels 10px.
- The desk grid: `340px | 400px | minmax(460px,1fr) | 385px` with a 232px
  bottom row on the right rail. **Panel C (ledger) spans both rows and takes
  the flexible column — it is the protagonist and the layout says so.**
- Hairlines (1px `--line-0`) over shadows; the ledger panel alone gets a
  deeper border + ambient shadow to pull the eye.
- Minimum width 1280px — this is a desk, not a phone.

---

## 4. Motion

**The containment law:** *agent actions may animate; the ledger never lies and
never flickers.*

- Ledger rows appear with a single `row-settle` (160ms, cyan wash →
  transparent, `ease-out`) and are never removed, never re-animated, never
  reflowed. Entries only ever prepend.
- Controls: 120ms `--t-fast` transitions, `cubic-bezier(0.16, 1, 0.3, 1)`
  (`--ease-out`); buttons press with `cubic-bezier(0.34, 1.4, 0.64, 1)`
  (`--ease-spring`, slight overshoot).
- The integrity dot pulses at 2.2s — the only loop in the app.
- All transitions are interruptible by nature (they're single-property CSS
  transitions, no keyframe choreography).
- `prefers-reduced-motion: reduce` collapses every animation and transition
  to 0.01ms. The ledger's settle wash is content, not decoration — under
  reduced motion the row still appears, just without the wash.

Nothing scales, slides, or parallax. Verdicts are **typographic events**:
weight and size shift (serif 19px/700 "Documented refusal."), a reason-code
chip, a rotated stamp — not a red toast.

---

## 5. Icons

Inline, hand-drawn SVG only (original work, no icon font, no CDN):
- the masthead mark: a seal/chain-link glyph (double ring + प्रमाण-adjacent R),
- the release seal: concentric dashed rings + check (Panel E),
- the block seal: ring + cross,
- the favicon: same seal motif on ink.

---

## 6. Voice

Microcopy is part of the design: "a desk where a human supervises machine
spending", "the agent stays inside its mandate; the money does not",
"APPEND-ONLY · NO UPDATES · NO DELETIONS". Refusals explain themselves in
serif prose *and* emit a machine reason code — both audiences, one event.
