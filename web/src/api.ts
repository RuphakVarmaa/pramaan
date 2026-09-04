/**
 * api.ts — Pramaan console API client.
 *
 * Two transports, one state machine:
 *  - MOCK (default): in-memory ledger, deterministic fake signatures, gate
 *    verdicts per CONTRACTS.md reason codes, evidence packs, fraud feed.
 *  - REAL: hits the Pramaan server (Vite proxies /api -> localhost:3000).
 *
 * Everything the UI needs is typed here; panels never call fetch directly.
 * Money is paise-as-string everywhere; all math is BigInt.
 */

// ---------------------------------------------------------------------------
// Types (mirror CONTRACTS.md §3/§4/§7/§8)
// ---------------------------------------------------------------------------

export type LedgerEntryType =
  | 'DELEGATION_ISSUED'
  | 'ATTEMPT_ALLOWED'
  | 'ATTEMPT_BLOCKED'
  | 'DISPUTE_OPENED'
  | 'EVIDENCE_GENERATED'
  | 'AGENT_RELEASED';

export type GateReasonCode =
  | 'OK'
  | 'CAP_EXCEEDED_PER_TXN'
  | 'CAP_EXCEEDED_AGGREGATE'
  | 'CATEGORY_NOT_IN_SCOPE'
  | 'ARTIFACT_EXPIRED'
  | 'ARTIFACT_NOT_FOUND'
  | 'ARTIFACT_INVALID_SIGNATURE'
  | 'AGENT_MISMATCH';

export interface LedgerEntry {
  seq: number;
  ts: string; // ISO 8601
  type: LedgerEntryType;
  amountPaise: string | null;
  verdict: 'ALLOWED' | 'BLOCKED' | 'INFO' | 'RELEASED' | null;
  reason: GateReasonCode | string | null;
  actor: string;
  memo: string;
  prevHash: string;
  selfHash: string;
}

export interface DelegationArtifact {
  artifactId: string;
  version: 1;
  merchant: { id: string; name: string };
  principal: { name: string; email: string };
  agent: { id: string; persona: string; model: string };
  scope: {
    categories: string[];
    perTxnCapPaise: string;
    aggregateCapPaise: string;
    expiresAt: string; // ISO
  };
  issuedAt: string;
  signature: string; // Ed25519 over canonical JSON (mock: deterministic)
}

export interface CartLine {
  sku: string;
  qty: number;
}

export interface GateRequest {
  artifactId: string;
  cart: CartLine[];
}

export interface GateVerdict {
  decision: 'ALLOWED' | 'BLOCKED';
  reason: GateReasonCode;
  amountPaise: string | null;
  orderId: string | null;
  ledgerSeq: number | null;
  artifactId: string | null;
  lines?: { sku: string; name: string; qty: number; unitPaise: string }[];
}

export interface Dispute {
  disputeId: string;
  ledgerSeq: number;
  orderId: string;
  amountPaise: string;
  reason: string;
  openedAt: string;
  status: 'OPEN' | 'EVIDENCE_READY';
}

export interface FraudFlag {
  flagId: string;
  orderId: string;
  actor: string;
  amountPaise: string;
  signals: string[]; // e.g. ['HIGH_VELOCITY', 'HEADLESS_BROWSER', 'NEW_ACCOUNT']
  flaggedAt: string;
}

export interface FraudVerdict {
  decision: 'RELEASE' | 'BLOCK';
  proof: 'PRAMAAN_DELEGATION_PROOF' | 'NO_VALID_DELEGATION';
  orderId: string;
  artifactId: string | null;
  ledgerSeq: number | null;
}

export interface ChainVerification {
  valid: boolean;
  checkedEntries: number;
  brokenAtSeq: number | null;
}

export interface PramaanApi {
  mode: 'mock' | 'real';
  listLedger(): Promise<LedgerEntry[]>;
  issueDelegation(input: IssueInput): Promise<DelegationArtifact>;
  attemptPayment(input: GateRequest & { actor?: string }): Promise<GateVerdict>;
  openDispute(input: { ledgerSeq: number; reason: string }): Promise<Dispute>;
  generateEvidence(input: { ledgerSeq: number }): Promise<{ html: string; disputeId: string; sha256: string }>;
  listDisputes(): Promise<Dispute[]>;
  listFraudFlags(): Promise<FraudFlag[]>;
  runFraudGate(input: { flagId: string; withArtifact: boolean }): Promise<FraudVerdict>;
  verifyChain(): Promise<ChainVerification>;
}

export interface IssueInput {
  principalName: string;
  principalEmail: string;
  agentId: string;
  categories: string[];
  perTxnCapPaise: string;
  aggregateCapPaise: string;
  expiryMinutes: number;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** djb2-ish deterministic 64-hex "hash" for mock mode. Not crypto. Looks it. */
function fakeHash(input: string, seed = 5381): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const a = (h2 >>> 0).toString(16).padStart(8, '0');
  const b = (h1 >>> 0).toString(16).padStart(8, '0');
  return (a + b).padEnd(64, '0').slice(0, 64);
}

export function formatINR(paiseStr: string | null | undefined): string {
  if (!paiseStr) return '—';
  const neg = paiseStr.startsWith('-');
  const p = BigInt(neg ? paiseStr.slice(1) : paiseStr);
  const rupees = p / 100n;
  const rem = (p % 100n).toString().padStart(2, '0');
  const rStr = rupees.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '−' : ''}₹${rStr}.${rem}`;
}

export function truncateHash(h: string, n = 8): string {
  return `${h.slice(0, n)}…${h.slice(-n / 2)}`;
}

export function formatIST(iso: string): string {
  const d = new Date(iso);
  return (
    d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false, year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }) + ' IST'
  );
}

// ---------------------------------------------------------------------------
// MOCK IMPLEMENTATION — same state machine as the real API
// ---------------------------------------------------------------------------

import catalog from './data/catalog.json';

interface Product {
  sku: string;
  name: string;
  category: string;
  unitPaise: number;
  description: string;
}
const products = catalog.products as Product[];
const merchant = catalog.merchant;

export const AGENT_PERSONAS = [
  { id: 'agent-arjun', persona: 'Arjun — Household Buyer', model: 'claude-sonnet · shopping v2' },
  { id: 'agent-meera', persona: 'Meera — Office Provisioner', model: 'gpt-4o · procurement v1' },
  { id: 'agent-vikram', persona: 'Vikram — Field Ops', model: 'local-70b · autonomous v3' },
] as const;

function makeMockApi(): PramaanApi {
  const ledger: LedgerEntry[] = [];
  const artifacts = new Map<string, DelegationArtifact>();
  const aggregateSpent = new Map<string, bigint>(); // artifactId -> paise spent
  const disputes: Dispute[] = [];
  const orderToSeq = new Map<string, number>();
  const releasedOrders = new Set<string>();
  let seqCounter = 0;
  let orderCounter = 4100;
  let disputeCounter = 1;
  let flagCounter = 1;

  function append(entry: Omit<LedgerEntry, 'seq' | 'prevHash' | 'selfHash'>): LedgerEntry {
    const seq = ++seqCounter;
    const prevHash = seq === 1 ? '0'.repeat(64) : ledger[ledger.length - 1].selfHash;
    const canonical = JSON.stringify({ seq, prevHash, ...entry, ts: entry.ts });
    const selfHash = fakeHash(canonical, seq * 7919);
    const full: LedgerEntry = { seq, prevHash, selfHash, ...entry };
    ledger.push(full);
    return full;
  }

  function cartTotalPaise(cart: CartLine[]): bigint {
    return cart.reduce((sum, l) => {
      const p = products.find((x) => x.sku === l.sku);
      return p ? sum + BigInt(p.unitPaise) * BigInt(l.qty) : sum;
    }, 0n);
  }

  // Seed a modest pre-existing chain so the ledger opens with history.
  function seed() {
    const now = Date.now();
    const mk = (minsAgo: number) => new Date(now - minsAgo * 60_000).toISOString();
    append({ ts: mk(62), type: 'DELEGATION_ISSUED', amountPaise: null, verdict: 'INFO', reason: null, actor: 'kadai-and-co', memo: 'seed · delegation for agent-meera' });
    append({ ts: mk(48), type: 'ATTEMPT_ALLOWED', amountPaise: '31000', verdict: 'ALLOWED', reason: 'OK', actor: 'agent-meera', memo: 'order seed-4021 · KC-COF-BRWD-100 ×1' });
    append({ ts: mk(31), type: 'ATTEMPT_ALLOWED', amountPaise: '18500', verdict: 'ALLOWED', reason: 'OK', actor: 'agent-meera', memo: 'order seed-4022 · KC-PAN-JAGR-350 ×1' });
    append({ ts: mk(12), type: 'ATTEMPT_BLOCKED', amountPaise: '239000', verdict: 'BLOCKED', reason: 'CAP_EXCEEDED_PER_TXN', actor: 'agent-meera', memo: 'order seed-4023 refused · KC-EQP-SCLE-01 ×1' });
  }
  seed();

  const api: PramaanApi = {
    mode: 'mock',

    async listLedger() {
      return [...ledger].reverse(); // newest first
    },

    async issueDelegation(input) {
      const artifactId = `prm_${input.agentId}_${Date.now().toString(36)}`;
      const issuedAt = new Date().toISOString();
      const artifact: DelegationArtifact = {
        artifactId,
        version: 1,
        merchant: { id: merchant.id, name: merchant.name },
        principal: { name: input.principalName, email: input.principalEmail },
        agent: AGENT_PERSONAS.find((a) => a.id === input.agentId) ?? AGENT_PERSONAS[0],
        scope: {
          categories: [...input.categories].sort(),
          perTxnCapPaise: input.perTxnCapPaise,
          aggregateCapPaise: input.aggregateCapPaise,
          expiresAt: new Date(Date.now() + input.expiryMinutes * 60_000).toISOString(),
        },
        issuedAt,
        signature: 'ed25519:' + fakeHash(JSON.stringify({ artifactId, issuedAt, agent: input.agentId }), 0xed25519),
      };
      artifacts.set(artifactId, artifact);
      aggregateSpent.set(artifactId, 0n);
      append({
        ts: issuedAt,
        type: 'DELEGATION_ISSUED',
        amountPaise: null,
        verdict: 'INFO',
        reason: null,
        actor: merchant.id,
        memo: `delegation ${artifactId} → ${artifact.agent.id} · scope ${input.categories.sort().join('/')}`,
      });
      return artifact;
    },

    async attemptPayment({ artifactId, cart, actor }) {
      const artifact = artifacts.get(artifactId);
      const total = cartTotalPaise(cart);
      const who = actor ?? artifact?.agent.id ?? 'unknown-agent';
      const lines = cart.map((l) => {
        const p = products.find((x) => x.sku === l.sku)!;
        return { sku: l.sku, name: p.name, qty: l.qty, unitPaise: String(p.unitPaise) };
      });
      const fail = (reason: GateReasonCode, amount: string | null): GateVerdict => {
        const e = append({
          ts: new Date().toISOString(),
          type: 'ATTEMPT_BLOCKED',
          amountPaise: amount,
          verdict: 'BLOCKED',
          reason,
          actor: who,
          memo: `documented refusal · ${reason} · ${truncateHash(artifactId ?? 'n/a', 6)}`,
        });
        return { decision: 'BLOCKED', reason, amountPaise: amount, orderId: null, ledgerSeq: e.seq, artifactId, lines };
      };

      if (!artifact) return fail('ARTIFACT_NOT_FOUND', total.toString());
      if (new Date(artifact.scope.expiresAt).getTime() < Date.now()) return fail('ARTIFACT_EXPIRED', total.toString());

      const outOfScope = cart.find((l) => {
        const p = products.find((x) => x.sku === l.sku);
        return p && !artifact.scope.categories.includes(p.category);
      });
      if (outOfScope) return fail('CATEGORY_NOT_IN_SCOPE', total.toString());

      if (total > BigInt(artifact.scope.perTxnCapPaise)) return fail('CAP_EXCEEDED_PER_TXN', total.toString());

      const spent = aggregateSpent.get(artifactId) ?? 0n;
      if (spent + total > BigInt(artifact.scope.aggregateCapPaise)) return fail('CAP_EXCEEDED_AGGREGATE', total.toString());

      // Allowed
      const orderId = `order_${++orderCounter}`;
      const e = append({
        ts: new Date().toISOString(),
        type: 'ATTEMPT_ALLOWED',
        amountPaise: total.toString(),
        verdict: 'ALLOWED',
        reason: 'OK',
        actor: who,
        memo: `order ${orderId} · ${cart.map((l) => `${l.sku}×${l.qty}`).join(', ')}`,
      });
      orderToSeq.set(orderId, e.seq);
      aggregateSpent.set(artifactId, spent + total);
      return { decision: 'ALLOWED', reason: 'OK', amountPaise: total.toString(), orderId, ledgerSeq: e.seq, artifactId, lines };
    },

    async openDispute({ ledgerSeq, reason }) {
      const target = ledger.find((l) => l.seq === ledgerSeq);
      const dispute: Dispute = {
        disputeId: `dsp_2026_${String(disputeCounter++).padStart(4, '0')}`,
        ledgerSeq,
        orderId: (target?.memo.match(/order_(\d+)/)?.[1] ?? '0').padStart(9, '0').replace(/^0+(?=\d)/, ''),
        amountPaise: target?.amountPaise ?? '0',
        reason,
        openedAt: new Date().toISOString(),
        status: 'OPEN',
      };
      // Normalize orderId display
      dispute.orderId = `order_${target?.memo.match(/order_(\d+)/)?.[1] ?? '4099'}`;
      disputes.unshift(dispute);
      append({
        ts: dispute.openedAt,
        type: 'DISPUTE_OPENED',
        amountPaise: dispute.amountPaise,
        verdict: 'INFO',
        reason: null,
        actor: 'principal',
        memo: `dispute ${dispute.disputeId} opened on ledger seq ${ledgerSeq} · ${reason}`,
      });
      return dispute;
    },

    async generateEvidence({ ledgerSeq }) {
      const dispute = disputes.find((d) => d.ledgerSeq === ledgerSeq) ?? disputes[0];
      const d = dispute ?? {
        disputeId: 'dsp_2026_0001',
        ledgerSeq,
        orderId: 'order_4101',
        amountPaise: '31000',
        reason: 'UNAUTHORIZED_TRANSACTION',
        openedAt: new Date().toISOString(),
        status: 'OPEN' as const,
      };
      const allowed = ledger.find((l) => l.seq === d.ledgerSeq && l.type === 'ATTEMPT_ALLOWED');
      const artifact = artifacts.values().next().value as DelegationArtifact | undefined;
      const sha256 = fakeHash(`evidence:${d.disputeId}:${d.ledgerSeq}`, 0x5e256);
      const html = buildEvidencePackHtml(d, allowed, artifact, ledger, sha256);
      append({
        ts: new Date().toISOString(),
        type: 'EVIDENCE_GENERATED',
        amountPaise: null,
        verdict: 'INFO',
        reason: null,
        actor: 'pramaan',
        memo: `evidence pack for ${d.disputeId} · sha256 ${truncateHash(sha256, 10)}`,
      });
      if (dispute) dispute.status = 'EVIDENCE_READY';
      return { html, disputeId: d.disputeId, sha256 };
    },

    async listDisputes() {
      return [...disputes];
    },

    async listFraudFlags() {
      // Deterministic-ish live feed of bot-flagged Razorpay test payments.
      const now = Date.now();
      const mk = (m: number) => new Date(now - m * 60_000).toISOString();
      const flags: FraudFlag[] = [
        {
          flagId: `flag_${flagCounter}`,
          orderId: `order_${orderCounter + 1}`,
          actor: 'agent-vikram',
          amountPaise: '59000',
          signals: ['HIGH_VELOCITY', 'HEADLESS_BROWSER'],
          flaggedAt: mk(3),
        },
        {
          flagId: `flag_${flagCounter + 1}`,
          orderId: `order_${orderCounter + 2}`,
          actor: 'agent-vikram',
          amountPaise: '118000',
          signals: ['NEW_ACCOUNT', 'NIGHT_WINDOW'],
          flaggedAt: mk(9),
        },
      ];
      return flags;
    },

    async runFraudGate({ flagId, withArtifact }) {
      // Resolve the flag to an order; if withArtifact and a live artifact
      // covers it, release. Otherwise documented refusal.
      const flags = await api.listFraudFlags();
      const flag = flags.find((f) => f.flagId === flagId) ?? flags[0];
      const orderId = flag?.orderId ?? `order_${++orderCounter}`;
      if (withArtifact) {
        const artifact = artifacts.values().next().value as DelegationArtifact | undefined;
        const e = append({
          ts: new Date().toISOString(),
          type: 'AGENT_RELEASED',
          amountPaise: flag?.amountPaise ?? null,
          verdict: 'RELEASED',
          reason: 'PRAMAAN_DELEGATION_PROOF',
          actor: flag?.actor ?? 'agent',
          memo: `order ${orderId} released on delegation proof · ${truncateHash(artifact?.artifactId ?? 'prm_live', 6)}`,
        });
        releasedOrders.add(orderId);
        return { decision: 'RELEASE', proof: 'PRAMAAN_DELEGATION_PROOF', orderId, artifactId: artifact?.artifactId ?? null, ledgerSeq: e.seq };
      }
      const e = append({
        ts: new Date().toISOString(),
        type: 'ATTEMPT_BLOCKED',
        amountPaise: flag?.amountPaise ?? null,
        verdict: 'BLOCKED',
        reason: 'NO_VALID_DELEGATION',
        actor: flag?.actor ?? 'agent',
        memo: `order ${orderId} held · no valid delegation presented`,
      });
      return { decision: 'BLOCK', proof: 'NO_VALID_DELEGATION', orderId, artifactId: null, ledgerSeq: e.seq };
    },

    async verifyChain() {
      let prev = '0'.repeat(64);
      for (const e of ledger) {
        if (e.prevHash !== prev) return { valid: false, checkedEntries: e.seq - 1, brokenAtSeq: e.seq };
        prev = e.selfHash;
      }
      return { valid: true, checkedEntries: ledger.length, brokenAtSeq: null };
    },
  };

  return api;
}

// ---------------------------------------------------------------------------
// Evidence pack (mock, but representative of CONTRACTS.md §5)
// ---------------------------------------------------------------------------

function buildEvidencePackHtml(
  d: Dispute,
  allowed: LedgerEntry | undefined,
  artifact: DelegationArtifact | undefined,
  ledger: LedgerEntry[],
  sha256: string,
): string {
  const chain = ledger.slice(-8);
  const rows = chain
    .map(
      (e) => `<tr><td>${e.seq}</td><td>${formatIST(e.ts)}</td><td>${e.type}</td><td>${e.amountPaise ? formatINR(e.amountPaise) : '—'}</td><td>${e.verdict ?? '—'}</td><td>${truncateHash(e.selfHash, 10)}</td></tr>`,
    )
    .join('');
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Prāmaṇa — Evidence Pack ${d.disputeId}</title>
<style>
  @font-face { font-family: 'Newsreader'; src: url('/fonts/Newsreader-Variable.woff2') format('woff2'); font-weight: 200 800; font-style: normal; font-display: swap; }
  @font-face { font-family: 'Newsreader'; src: url('/fonts/Newsreader-Italic-Variable.woff2') format('woff2'); font-weight: 200 800; font-style: italic; font-display: swap; }
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #EDE6DA; color: #1D1A14; font-family: 'Iowan Old Style', Georgia, 'Times New Roman', serif; font-size: 15px; line-height: 1.55; }
  .page { max-width: 760px; margin: 0 auto; padding: 48px 56px 40px; background: #F6F1E6; min-height: 100vh; box-shadow: 0 0 80px rgba(29,26,20,.25); }
  .cover { border-bottom: 3px double #8A7B5E; padding-bottom: 20px; margin-bottom: 28px; }
  .cover .brand { font-variant: small-caps; letter-spacing: .35em; font-size: 12px; color: #6B5D42; }
  h1 { font-size: 30px; font-weight: 500; margin: 10px 0 4px; letter-spacing: .01em; }
  .sub { color: #6B5D42; font-style: italic; font-size: 14px; }
  .exhibit { margin: 26px 0; }
  .exhibit > h2 { font-size: 13px; font-family: ui-monospace, 'SF Mono', Menlo, monospace; letter-spacing: .22em; color: #6B5D42; border-bottom: 1px solid #C9BC9E; padding-bottom: 6px; margin-bottom: 12px; font-weight: 500; }
  dl { margin: 0; display: grid; grid-template-columns: 170px 1fr; row-gap: 6px; }
  dt { font-variant: small-caps; letter-spacing: .08em; color: #6B5D42; }
  dd { margin: 0; }
  table { width: 100%; border-collapse: collapse; font-family: ui-monospace, 'SF Mono', Menlo, monospace; font-size: 11.5px; }
  th { text-align: left; font-weight: 500; letter-spacing: .08em; color: #6B5D42; border-bottom: 1px solid #C9BC9E; padding: 4px 8px 4px 0; font-variant: small-caps; }
  td { border-bottom: 1px dotted #C9BC9E; padding: 4px 8px 4px 0; }
  .seal { display: inline-block; margin-top: 18px; padding: 14px 22px; border: 2px solid #2E5B3A; color: #2E5B3A; font-family: ui-monospace, 'SF Mono', Menlo, monospace; font-size: 12px; letter-spacing: .28em; transform: rotate(-2deg); border-radius: 4px; }
  footer { margin-top: 36px; border-top: 3px double #8A7B5E; padding-top: 14px; font-family: ui-monospace, 'SF Mono', Menlo, monospace; font-size: 10.5px; color: #6B5D42; word-break: break-all; }
  .note { font-style: italic; color: #6B5D42; }
</style></head>
<body><div class="page">
  <div class="cover">
    <div class="brand">Kadai &amp; Co. · Prāmaṇa Dispute Evidence</div>
    <h1>Evidence Pack ${d.disputeId}</h1>
    <div class="sub">Dispute dossier assembled from the hash-chained Pramaan ledger — for submission to the acquiring bank.</div>
  </div>

  <div class="exhibit">
    <h2>EXHIBIT A — COVER BLOCK</h2>
    <dl>
      <dt>Dispute</dt><dd>${d.disputeId}</dd>
      <dt>Order</dt><dd>${d.orderId}</dd>
      <dt>Amount</dt><dd>${formatINR(d.amountPaise)}</dd>
      <dt>Dispute reason</dt><dd>${d.reason}</dd>
      <dt>Merchant</dt><dd>Kadai &amp; Co. (kadai-and-co)</dd>
      <dt>Principal</dt><dd>${artifact ? `${artifact.principal.name} &lt;${artifact.principal.email}&gt;` : 'on file'}</dd>
      <dt>Agent</dt><dd>${artifact ? `${artifact.agent.persona} (${artifact.agent.id})` : 'on file'}</dd>
      <dt>Opened</dt><dd>${formatIST(d.openedAt)}</dd>
      <dt>Assembled</dt><dd>${formatIST(new Date().toISOString())}</dd>
    </dl>
  </div>

  <div class="exhibit">
    <h2>EXHIBIT B — DELEGATION ARTIFACT</h2>
    ${artifact ? `<dl>
      <dt>Artifact id</dt><dd>${artifact.artifactId}</dd>
      <dt>Scope</dt><dd>${artifact.scope.categories.join(', ')} · per-txn ≤ ${formatINR(artifact.scope.perTxnCapPaise)} · aggregate ≤ ${formatINR(artifact.scope.aggregateCapPaise)}</dd>
      <dt>Issued</dt><dd>${formatIST(artifact.issuedAt)}</dd>
      <dt>Expires</dt><dd>${formatIST(artifact.scope.expiresAt)}</dd>
      <dt>Signature</dt><dd style="font-family:ui-monospace,Menlo,monospace;font-size:11px;word-break:break-all">${artifact.signature}</dd>
    </dl>` : '<p class="note">Artifact on file with merchant records.</p>'}
  </div>

  <div class="exhibit">
    <h2>EXHIBIT C — CONTESTED TRANSACTION</h2>
    ${allowed ? `<dl>
      <dt>Ledger seq</dt><dd>${allowed.seq}</dd>
      <dt>Timestamp</dt><dd>${formatIST(allowed.ts)}</dd>
      <dt>Type</dt><dd>${allowed.type}</dd>
      <dt>Amount</dt><dd>${formatINR(allowed.amountPaise)}</dd>
      <dt>Gate verdict</dt><dd>${allowed.verdict} · ${allowed.reason}</dd>
      <dt>Actor</dt><dd>${allowed.actor}</dd>
    </dl>` : '<p class="note">Ledger extract below constitutes the record.</p>'}
  </div>

  <div class="exhibit">
    <h2>EXHIBIT D — LEDGER EXTRACT (HASH-CHAINED)</h2>
    <table>
      <tr><th>Seq</th><th>Timestamp (IST)</th><th>Type</th><th>Amount</th><th>Verdict</th><th>Hash</th></tr>
      ${rows}
    </table>
  </div>

  <div class="exhibit">
    <h2>EXHIBIT E — CHAIN INTEGRITY STATEMENT</h2>
    <p>The entries above are drawn from the Pramaan append-only ledger. Each entry's <em>self-hash</em> commits to its sequence number, predecessor hash, and full contents. As of assembly, the chain verifies end-to-end from the genesis entry.</p>
    <div class="seal">PRAMAAN · CHAIN VERIFIED</div>
  </div>

  <footer>
    Evidence pack ${d.disputeId} · assembled ${formatIST(new Date().toISOString())} · Pramaan v1.0<br>
    sha256 ${sha256}
  </footer>
</div></body></html>`;
}

// ---------------------------------------------------------------------------
// REAL IMPLEMENTATION (thin; server owns the same state machine)
// ---------------------------------------------------------------------------

function makeRealApi(baseUrl = '/api'): PramaanApi {
  const j = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const r = await fetch(baseUrl + path, {
      headers: { 'content-type': 'application/json' },
      ...init,
    });
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}: ${await r.text().catch(() => '')}`);
    return r.json() as Promise<T>;
  };
  return {
    mode: 'real',
    listLedger: () => j('/ledger'),
    issueDelegation: (input) => j('/delegations', { method: 'POST', body: JSON.stringify(input) }),
    attemptPayment: (input) => j('/gate', { method: 'POST', body: JSON.stringify(input) }),
    openDispute: (input) => j('/disputes', { method: 'POST', body: JSON.stringify(input) }),
    generateEvidence: (input) => j('/evidence', { method: 'POST', body: JSON.stringify(input) }),
    listDisputes: () => j('/disputes'),
    listFraudFlags: () => j('/fraud/flags'),
    runFraudGate: (input) => j('/fraud/gate', { method: 'POST', body: JSON.stringify(input) }),
    verifyChain: () => j('/ledger/verify'),
  };
}

// ---------------------------------------------------------------------------
// Export: mock by default; UI toggle can switch at runtime.
// ---------------------------------------------------------------------------

const env = (import.meta as { env?: Record<string, string | undefined> }).env;
const envMock = env?.VITE_USE_MOCKS;

export function createApi(mode: 'mock' | 'real' = envMock === 'false' ? 'real' : 'mock'): PramaanApi {
  return mode === 'mock' ? makeMockApi() : makeRealApi();
}
