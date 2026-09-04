# web/public/fonts — Self-Hosted Font Manifest

All fonts served from `web/public/fonts/` (no CDN requests at runtime).
Google served these as **variable fonts** — a single woff2 covers the full weight
range declared in our `@font-face` blocks (`font-weight: 100 900` / `200 800`).

| Font | Style | File | Weight range | Source (Google Fonts CSS v2) | License |
|---|---|---|---|---|---|
| JetBrains Mono | upright | `JetBrainsMono-Variable.woff2` | 100–900 | `https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&display=swap` → `https://fonts.gstatic.com/s/jetbrainsmono/v24/tDbv2o-flEEny0FZhsfKu5WU4zr3E_BX0PnT8RD8yKwBNntkaToggR7BYRbKPxDcwgknk-4.woff2` | SIL Open Font License 1.1 |
| Newsreader | upright | `Newsreader-Variable.woff2` | 200–800 (+ optical size 6–72) | `https://fonts.googleapis.com/css2?family=Newsreader:opsz,wght@6..72,400;6..72,500;6..72,600&display=swap` → `https://fonts.gstatic.com/s/newsreader/v26/cY9AfjOCX1hbuyalUrK4397yjIJFJpc.woff2` | SIL Open Font License 1.1 |
| Newsreader | italic | `Newsreader-Italic-Variable.woff2` | 200–800 (+ optical size 6–72) | `https://fonts.googleapis.com/css2?family=Newsreader:ital,opsz,wght@1,6..72,400&display=swap` → `https://fonts.gstatic.com/s/newsreader/v26/cY9XfjOCX1hbuyalUrK439vogqCz_goCYw7oRd6JFYYzbARA_n8.woff2` | SIL Open Font License 1.1 |

**Where used**
- **JetBrains Mono** — the ledger, all machine output, reason codes, hashes,
  forms, panel headers: the "forensic terminal" voice of the console.
- **Newsreader** (incl. italic) — editorial layer: verdict prose, the dispute
  dossier (rendered inside the evidence-pack iframe), panel lede text, the
  wordmark नमस्ते-adjacent treatments, quotes from the merchant.

**Fallback stacks** (declared in CSS, used only if a woff2 fails to load):
- mono: `ui-monospace, "SF Mono", Menlo, Consolas, monospace`
- serif: `"Iowan Old Style", Georgia, "Times New Roman", serif`

Licenses: JetBrains Mono — OFL 1.1 (© JetBrains Inc., Philipp Nurullin, Konstantin Bessonov).
Newsreader — OFL 1.1 (© 2016 The Newsreader Project Authors, designed by François Palet / Production Type).

*Orchestrator: please merge these rows into the repo-root ASSETS.md (owned by S7).*
