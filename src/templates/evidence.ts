// Pramaan — evidence-pack HTML template (S3 EVIDENCE, CONTRACTS.md §5).
//
// Function-based template: renderEvidencePack(data) -> full HTML string.
// No template engine, no external requests, inline CSS only, no JS needed
// to read the document. Serif letter-paper aesthetic, system font stack
// (no webfonts inside the dossier — the console owns webfonts, not this).
//
// Money invariant: all money enters as bigint paise and is formatted AT THE
// RENDER BOUNDARY ONLY via fmtPaise() (divide by 100, 2 decimals, ₹ prefix,
// en-IN thousands separators). No Number() on money anywhere above it.

import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Data model handed to the template (all view-decisions pre-computed by
// src/evidence.ts; this module stays a dumb, safe renderer)
// ---------------------------------------------------------------------------

/** One per-line scope check in Exhibit D. */
export interface DiffLine {
  seq: number;
  ts: string;              // display-form (IST)
  tsUtc: string;           // UTC ISO for the details line
  amountPaise: bigint | null;
  category: string | null;  // from the attempt's structured reason, if any
  inScopeCategories: boolean | null; // null = category unknown (not on ledger row)
  withinPerTxnCap: boolean | null;   // null = no amount on row
  note: string;            // human sentence for this line
}

export interface ExhibitEData {
  valid: boolean;
  firstBreak?: number;
  rowCount: number;
  seqMin?: number;
  seqMax?: number;
  fullChainRowCount: number;
  spanLinksValid: boolean; // every span row links to the true global predecessor
  spanFirstBreak?: number;
  methodNote: string;     // one-line explanation of what was verified
}

export interface EvidencePackData {
  // cover block
  disputeId: string | null;
  disputeAmountPaise: bigint | null;
  disputeReason: string | null;
  disputeOpenedAt: string | null; // display-form (IST)
  delegationId: string;
  generatedAtIso: string;         // UTC ISO (canonical moment)
  generatedAtIst: string;         // display-form (IST)
  generatedAtUtc: string;         // display-form (UTC)
  merchantId: string;
  agentId: string;
  principal: string;

  // Exhibit A — what was authorized
  scope: {
    categories: string[];
    maxPerTxnPaise: bigint;
    maxAggregatePaise: bigint;
    expiresAt: string;    // display-form (IST)
    issuedAt: string;    // display-form (IST)
  } | null;
  artifactSourceNote: string; // where the scope came from (sidecar / fallback / unavailable)

  // Exhibit B — what the agent attempted (every ledger line for the delegation)
  attempts: Array<{
    seq: number;
    ts: string;          // display-form (IST)
    tsUtc: string;
    type: string;
    amountPaise: bigint | null;
    verdict: string | null;
    reason: string | null;
    orderId: string | null;
    hash8: string;       // first 8 hex of selfHash — forensic pointer
  }>;

  // Exhibit C — what actually happened (captures)
  captures: Array<{
    seq: number;
    ts: string;
    tsUtc: string;
    amountPaise: bigint;
    orderId: string | null;
    hash8: string;
  }>;
  capturedTotalPaise: bigint;

  // Exhibit D — scope-vs-actual diff (COMPUTED by src/evidence.ts)
  diff: {
    lines: DiffLine[];
    attemptedTxnCount: number;   // ATTEMPT_ALLOWED rows with an amount
    capturedTxnCount: number;
    aggregateSpentPaise: bigint;
    aggregateCapPaise: bigint | null;
    aggregateWithinCap: boolean | null;
    allWithinScope: boolean;
    verdictSentence: string;    // the computed verdict line
  };

  // Exhibit E — chain of integrity
  chain: ExhibitEData;

  // footer
  packSha256: string;
}

// ---------------------------------------------------------------------------
// formatting helpers (render boundary — the ONLY place money becomes text)
// ---------------------------------------------------------------------------

const inr = new Intl.NumberFormat('en-IN', {
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

/** bigint paise -> "₹1,25,000.00" (en-IN grouping; (paise/100) at the boundary, never a float). */
export function fmtPaise(paise: bigint): string {
  const neg = paise < 0n;
  const abs = neg ? -paise : paise;
  const rupees = abs / 100n;
  const p = abs % 100n;
  return `${neg ? '−' : ''}₹${inr.format(Number(rupees))}.${p.toString().padStart(2, '0')}`;
}

/** UTC ISO -> "04 Sep 2026, 21:32:05 IST" (Asia/Kolkata, no webfont, no libs). */
export function istTimestamp(iso: string): string {
  return new Date(iso).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }) + ' IST';
}

/** UTC ISO -> "04 Sep 2026, 15:32:05 UTC". */
export function utcTimestamp(iso: string): string {
  return new Date(iso).toLocaleString('en-IN', {
    timeZone: 'UTC',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }) + ' UTC';
}

/** HTML-escape arbitrary strings (ids, reasons, notes). */
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---------------------------------------------------------------------------
// renderer
// ---------------------------------------------------------------------------

export function renderEvidencePack(data: EvidencePackData): string {
  const d = data;
  const scope = d.scope;
  const diff = d.diff;
  const yes = (b: boolean | null | undefined): string =>
    b === null || b === undefined ? '<span class="unk">unknown</span>' : b ? 'yes' : '<strong class="no">no</strong>';

  const cover = `
  <section class="cover">
    <div class="cover-rule"></div>
    <h2 class="doc-title">Delegation Evidence Pack</h2>
    <p class="doc-sub">Dispute representment &mdash; machine-verified record of delegated payment authority</p>
    <table class="cover-meta">
      <tr><th>Dispute ID</th><td>${d.disputeId ? esc(d.disputeId) : '<span class="unk">not registered (generated from route query)</span>'}</td></tr>
      ${d.disputeAmountPaise !== null ? `<tr><th>Disputed amount</th><td>${fmtPaise(d.disputeAmountPaise)}</td></tr>` : ''}
      ${d.disputeReason ? `<tr><th>Dispute reason</th><td>${esc(d.disputeReason)}</td></tr>` : ''}
      ${d.disputeOpenedAt ? `<tr><th>Dispute opened</th><td>${esc(d.disputeOpenedAt)}</td></tr>` : ''}
      <tr><th>Delegation ID</th><td class="mono">${esc(d.delegationId)}</td></tr>
      <tr><th>Generated at</th><td>${esc(d.generatedAtIst)}<span class="tz-alt"> (${esc(d.generatedAtUtc)})</span></td></tr>
      <tr><th>Merchant</th><td>${esc(d.merchantId)}</td></tr>
      <tr><th>Agent</th><td>${esc(d.agentId)}</td></tr>
      <tr><th>Principal</th><td>${esc(d.principal)}</td></tr>
      <tr><th>Artifact ID</th><td class="mono">${esc(d.delegationId)}</td></tr>
    </table>
    <p class="cover-note">All amounts in Indian Rupees. All timestamps Indian Standard Time (UTC+05:30) unless a UTC alternative is shown. Monetary values are carried as integer paise end-to-end and formatted only at this document's render boundary.</p>
  </section>`;

  const exhibitA = scope
    ? `
  <section class="exhibit">
    <h3><span class="ex-label">Exhibit A</span> &mdash; What was authorized</h3>
    <p class="ex-lede">The principal granted the agent a signed delegation artifact. Its scope, below, is the authoritative boundary of what the agent was permitted to do.</p>
    <table class="doc-table">
      <tr><th>Authorized categories</th><td>${scope.categories.map((c) => esc(c)).join(', ')}</td></tr>
      <tr><th>Per-transaction cap</th><td>${fmtPaise(scope.maxPerTxnPaise)}</td></tr>
      <tr><th>Aggregate cap</th><td>${fmtPaise(scope.maxAggregatePaise)}</td></tr>
      <tr><th>Issued</th><td>${esc(scope.issuedAt)}</td></tr>
      <tr><th>Expires</th><td>${esc(scope.expiresAt)}</td></tr>
    </table>
    <p class="fine">Source: ${esc(d.artifactSourceNote)}.</p>
  </section>`
    : `
  <section class="exhibit">
    <h3><span class="ex-label">Exhibit A</span> &mdash; What was authorized</h3>
    <p class="ex-lede">Artifact details unavailable: no artifact sidecar was found for this delegation and the issuance row carries no recoverable scope. The ledger rows in Exhibits B&ndash;E remain authentic and hash-verified.</p>
  </section>`;

  const attemptRows = d.attempts.length
    ? d.attempts
        .map(
          (r) => `<tr>
      <td class="mono">${r.seq}</td>
      <td>${esc(r.ts)}<div class="tz-alt">${esc(r.tsUtc)}</div></td>
      <td>${esc(r.type)}</td>
      <td class="num">${r.amountPaise === null ? '&mdash;' : fmtPaise(r.amountPaise)}</td>
      <td>${r.verdict ? esc(r.verdict) : '&mdash;'}</td>
      <td>${r.reason ? esc(r.reason) : '&mdash;'}</td>
      <td class="mono">${r.orderId ? esc(r.orderId) : '&mdash;'}</td>
      <td class="mono hash">${esc(r.hash8)}</td>
    </tr>`,
        )
        .join('')
    : '<tr><td colspan="8" class="unk">No ledger rows found for this delegation.</td></tr>';

  const exhibitB = `
  <section class="exhibit">
    <h3><span class="ex-label">Exhibit B</span> &mdash; What the agent attempted</h3>
    <p class="ex-lede">Every attempt line recorded for this delegation, in sequence order &mdash; allowed and refused alike, reasons included. Each line is anchored in the append-only hash chain (Exhibit E verifies it).</p>
    <table class="doc-table wide">
      <thead>
        <tr><th>#</th><th>Timestamp</th><th>Type</th><th>Amount</th><th>Verdict</th><th>Reason</th><th>Order</th><th>Row&nbsp;hash</th></tr>
      </thead>
      <tbody>${attemptRows}</tbody>
    </table>
  </section>`;

  const captureRows = d.captures.length
    ? d.captures
        .map(
          (c) => `<tr>
      <td class="mono">${c.seq}</td>
      <td>${esc(c.ts)}<div class="tz-alt">${esc(c.tsUtc)}</div></td>
      <td class="num">${fmtPaise(c.amountPaise)}</td>
      <td class="mono">${c.orderId ? esc(c.orderId) : '&mdash;'}</td>
      <td class="mono hash">${esc(c.hash8)}</td>
    </tr>`,
        )
        .join('')
    : '<tr><td colspan="5" class="unk">No captures recorded for this delegation.</td></tr>';

  const exhibitC = `
  <section class="exhibit">
    <h3><span class="ex-label">Exhibit C</span> &mdash; What actually happened</h3>
    <p class="ex-lede">Payments captured against the delegation. Captures are the money that actually moved; blocked attempts never became captures.</p>
    <table class="doc-table wide">
      <thead>
        <tr><th>#</th><th>Timestamp</th><th>Amount captured</th><th>Order</th><th>Row&nbsp;hash</th></tr>
      </thead>
      <tbody>${captureRows}</tbody>
      <tfoot>
        <tr><td colspan="2">Total captured</td><td class="num">${fmtPaise(d.capturedTotalPaise)}</td><td colspan="2">${d.captures.length} capture${d.captures.length === 1 ? '' : 's'}</td></tr>
      </tfoot>
    </table>
  </section>`;

  const diffRows = diff.lines.length
    ? diff.lines
        .map(
          (l) => `<tr>
      <td class="mono">${l.seq}</td>
      <td>${esc(l.ts)}<div class="tz-alt">${esc(l.tsUtc)}</div></td>
      <td class="num">${l.amountPaise === null ? '&mdash;' : fmtPaise(l.amountPaise)}</td>
      <td>${l.category === null ? '<span class="unk">not recorded</span>' : esc(l.category)}</td>
      <td>${yes(l.inScopeCategories)}</td>
      <td>${yes(l.withinPerTxnCap)}</td>
      <td class="note">${esc(l.note)}</td>
    </tr>`,
        )
        .join('')
    : '<tr><td colspan="7" class="unk">No attempts to diff.</td></tr>';

  const exhibitD = `
  <section class="exhibit">
    <h3><span class="ex-label">Exhibit D</span> &mdash; Scope vs. actual (computed)</h3>
    <p class="ex-lede">Every figure below is computed from the ledger rows at pack-generation time &mdash; not asserted by any party. ${diff.attemptedTxnCount} attempted transaction${diff.attemptedTxnCount === 1 ? ' was' : 's were'} evaluated against the authorized scope.</p>
    <table class="doc-table wide">
      <thead>
        <tr><th>#</th><th>Timestamp</th><th>Amount</th><th>Category</th><th>Category&nbsp;in&nbsp;scope?</th><th>Within&nbsp;per-txn&nbsp;cap?</th><th>Finding</th></tr>
      </thead>
      <tbody>${diffRows}</tbody>
    </table>
    <div class="verdict">
      <div class="verdict-label">Computed verdict</div>
      <p class="verdict-sentence">${esc(diff.verdictSentence)}</p>
      <table class="verdict-meta">
        <tr><th>Aggregate position after all activity</th><td>${
          diff.aggregateCapPaise === null
            ? 'cap unknown (artifact details unavailable)'
            : `${fmtPaise(diff.aggregateSpentPaise)} of ${fmtPaise(diff.aggregateCapPaise)} cap`
        }</td></tr>
        <tr><th>Aggregate within cap?</th><td>${yes(diff.aggregateWithinCap)}</td></tr>
        <tr><th>Attempted transactions</th><td>${diff.attemptedTxnCount}</td></tr>
        <tr><th>Captured transactions</th><td>${diff.capturedTxnCount}</td></tr>
      </table>
    </div>
  </section>`;

  const chainStatus = d.chain.valid
    ? `<p class="chain-ok">VALID &mdash; the full ledger chain (${d.chain.fullChainRowCount} rows) re-verifies with no breaks.</p>`
    : `<p class="chain-bad">BROKEN &mdash; first mismatch at ledger row seq ${d.chain.firstBreak ?? '?'}. Rows after the break must not be relied upon.</p>`;
  const spanStatus = d.chain.spanLinksValid
    ? `<p class="chain-ok">This delegation's ${d.chain.rowCount} row${d.chain.rowCount === 1 ? '' : 's'} (seq ${d.chain.seqMin ?? '?'}&ndash;${d.chain.seqMax ?? '?'}) each re-verify against the global chain: self-hashes recompute exactly and each row links to its true global predecessor.</p>`
    : `<p class="chain-bad">Span verification FAILED at ledger row seq ${d.chain.spanFirstBreak ?? '?'}. A row in this delegation's span fails hash recomputation or linkage.</p>`;

  const exhibitE = `
  <section class="exhibit">
    <h3><span class="ex-label">Exhibit E</span> &mdash; Chain of integrity</h3>
    <p class="ex-lede">The ledger is append-only and hash-chained: each row's self-hash covers its predecessor's hash, so any retroactive edit breaks the chain. This exhibit records the verification performed when this pack was generated.</p>
    ${chainStatus}
    ${spanStatus}
    <table class="doc-table">
      <tr><th>Full-chain verification</th><td>${d.chain.valid ? 'valid' : `invalid &mdash; first break at seq ${d.chain.firstBreak ?? '?'}`}</td></tr>
      <tr><th>Delegation span rows</th><td>${d.chain.rowCount} (seq ${d.chain.seqMin ?? '?'} to ${d.chain.seqMax ?? '?'})</td></tr>
      <tr><th>Span self-hash + linkage</th><td>${d.chain.spanLinksValid ? 'valid' : `invalid &mdash; first break at seq ${d.chain.spanFirstBreak ?? '?'}`}</td></tr>
      <tr><th>Method</th><td>${esc(d.chain.methodNote)}</td></tr>
    </table>
  </section>`;

  const footer = `
  <footer>
    <div class="footer-rule"></div>
    <p>Integrity seal (SHA-256 of this document with the seal field zeroed): <span class="mono hash">${esc(d.packSha256)}</span></p>
    <p class="fine">The pack&rsquo;s authoritative digest &mdash; sha256 of the delivered file bytes &mdash; is returned by the generating system alongside this document; the seal above is recomputable from the file alone by zeroing the seal value and hashing the whole.</p>
    <p>Generated ${esc(d.generatedAtIst)} <span class="tz-alt">(${esc(d.generatedAtUtc)})</span></p>
    <p class="brand">Pramaan &mdash; proof of delegation</p>
  </footer>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pramaan Evidence Pack &mdash; ${esc(d.delegationId)}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0 auto;
    padding: 48px 56px 64px;
    max-width: 8.5in;
    background: #fbfaf7;
    color: #191510;
    font-family: Georgia, 'Iowan Old Style', 'Times New Roman', Times, serif;
    font-size: 11.5pt;
    line-height: 1.55;
  }
  .masthead { text-align: center; margin-bottom: 6px; }
  .masthead .rule-1 { border-top: 2.5px solid #191510; margin-bottom: 2px; }
  .masthead .rule-2 { border-top: 1px solid #191510; }
  .masthead h1 {
    font-size: 15pt; letter-spacing: 0.18em; font-weight: 700;
    margin: 10px 0 2px; text-transform: uppercase;
  }
  .masthead .micro { font-size: 8pt; letter-spacing: 0.16em; margin: 2px 0; text-transform: uppercase; color: #5c5347; }
  .cover { margin-top: 26px; }
  .cover-rule { border-top: 1px solid #b8ad9c; margin: 18px 0; }
  .doc-title { font-size: 20pt; margin: 0 0 2px; font-weight: 700; }
  .doc-sub { font-style: italic; color: #4c4437; margin: 0 0 18px; }
  .cover-meta, .doc-table, .verdict-meta { border-collapse: collapse; width: 100%; }
  .cover-meta th, .doc-table th, .verdict-meta th {
    text-align: left; font-weight: 700; padding: 6px 14px 6px 0; vertical-align: top;
  }
  .cover-meta td, .doc-table td, .verdict-meta td { padding: 6px 8px; vertical-align: top; }
  .cover-meta th { width: 11.5em; white-space: nowrap; }
  .cover-meta tr, .doc-table tbody tr, .verdict-meta tr { border-bottom: 1px dotted #c9bfae; }
  .cover-note { font-size: 9.5pt; color: #5c5347; margin-top: 16px; font-style: italic; }
  .exhibit { margin-top: 34px; }
  .exhibit h3 { font-size: 13.5pt; margin: 0 0 6px; }
  .ex-label {
    display: inline-block; border: 1.5px solid #191510; padding: 1px 8px;
    font-size: 9.5pt; letter-spacing: 0.14em; text-transform: uppercase; margin-right: 6px;
  }
  .ex-lede { margin: 6px 0 12px; color: #3d362c; }
  .doc-table.wide { font-size: 10pt; }
  .doc-table.wide thead th {
    font-size: 8.5pt; letter-spacing: 0.08em; text-transform: uppercase;
    border-bottom: 1.5px solid #191510; padding: 5px 8px 5px 0;
  }
  .doc-table.wide td { padding: 5px 8px 5px 0; }
  .num { text-align: right; white-space: nowrap; }
  .mono { font-family: 'SF Mono', 'Cascadia Mono', Menlo, Consolas, 'DejaVu Sans Mono', monospace; font-size: 0.86em; }
  .hash { color: #5c5347; }
  .unk { color: #8a7f6e; font-style: italic; }
  .no { color: #8a1c1c; }
  .note { color: #3d362c; }
  .tz-alt { font-size: 8.5pt; color: #8a7f6e; font-family: 'SF Mono', 'Cascadia Mono', Menlo, Consolas, 'DejaVu Sans Mono', monospace; }
  .verdict {
    border: 1.5px solid #191510; padding: 14px 18px; margin-top: 16px; background: #f4f0e6;
  }
  .verdict-label { font-size: 8.5pt; letter-spacing: 0.14em; text-transform: uppercase; margin-bottom: 6px; }
  .verdict-sentence { font-size: 12.5pt; margin: 0 0 12px; font-weight: 700; }
  .chain-ok { font-weight: 700; }
  .chain-bad { font-weight: 700; color: #8a1c1c; }
  footer { margin-top: 44px; font-size: 9.5pt; color: #3d362c; }
  .footer-rule { border-top: 1px solid #191510; margin-bottom: 10px; }
  footer p { margin: 3px 0; }
  .brand { letter-spacing: 0.12em; text-transform: uppercase; font-size: 8.5pt; color: #5c5347; margin-top: 8px; }
  @media print {
    body { background: #fff; padding: 0.5in 0.6in; max-width: none; }
    .exhibit { page-break-inside: avoid; }
    .doc-table.wide { page-break-inside: auto; }
    a { color: inherit; text-decoration: none; }
  }
</style>
</head>
<body>
  <header class="masthead">
    <div class="rule-1"></div>
    <div class="rule-2"></div>
    <h1>Pramaan &mdash; Delegation Evidence Pack</h1>
    <p class="micro">Exhibits A&ndash;E</p>
    <p class="micro">Confidential &mdash; Dispute Representment</p>
  </header>
${cover}
${exhibitA}
${exhibitB}
${exhibitC}
${exhibitD}
${exhibitE}
${footer}
</body>
</html>
`;
}

/** sha256 of the full HTML string, hex — the pack's content digest. */
export function sha256Html(html: string): string {
  return createHash('sha256').update(html, 'utf8').digest('hex');
}
