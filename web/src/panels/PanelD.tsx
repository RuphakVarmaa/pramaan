import { useEffect, useMemo, useState } from 'react';
import type { SharedState } from '../App';
import { formatINR } from '../api';

const DISPUTE_REASONS: ReadonlyArray<{ code: string; label: string }> = [
  { code: 'UNAUTHORIZED_TRANSACTION', label: 'I never authorized this transaction' },
  { code: 'SERVICE_NOT_RECEIVED', label: 'The goods or service was never delivered' },
  { code: 'DUPLICATE_CHARGE', label: 'I was charged more than once' },
  { code: 'AMOUNT_MISMATCH', label: 'The charged amount is wrong' },
  { code: 'AGENT_EXCEEDED_SCOPE', label: 'My agent spent beyond what I allowed' },
];

export function PanelD({ shared }: { shared: SharedState }) {
  const { api, ledger, refreshLedger } = shared;
  // Captured (ALLOWED) transactions are the disputable ones.
  const capturables = useMemo(() => ledger.filter((l) => l.type === 'ATTEMPT_ALLOWED'), [ledger]);
  const [pickedSeq, setPickedSeq] = useState<number | null>(null);
  const [reason, setReason] = useState<string>(DISPUTE_REASONS[0].code);
  const [disputeOpened, setDisputeOpened] = useState(false);
  const [evidence, setEvidence] = useState<{ html: string; disputeId: string; sha256: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (pickedSeq === null && capturables.length > 0) setPickedSeq(capturables[0].seq);
    if (pickedSeq !== null && !capturables.some((c) => c.seq === pickedSeq)) {
      setPickedSeq(capturables[0]?.seq ?? null);
    }
  }, [capturables, pickedSeq]);

  const picked = capturables.find((c) => c.seq === pickedSeq) ?? null;

  async function openDispute() {
    if (pickedSeq == null) return;
    setBusy(true);
    setError(null);
    try {
      await api.openDispute({ ledgerSeq: pickedSeq, reason });
      setDisputeOpened(true);
      setEvidence(null);
      await refreshLedger().catch(() => {
        // the dispute itself succeeded; only the view refresh failed
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Dispute could not be opened');
    } finally {
      setBusy(false);
    }
  }

  async function generateEvidence() {
    if (pickedSeq == null) return;
    setBusy(true);
    setError(null);
    try {
      const pack = await api.generateEvidence({ ledgerSeq: pickedSeq });
      setEvidence(pack);
      await refreshLedger().catch(() => {
        // the pack itself is already rendered; only the view refresh failed
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Evidence pack generation failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel panel-d" aria-label="Dispute desk">
      <header>
        <h2>Dispute Desk</h2>
        <span className="sub">contest with evidence</span>
      </header>
      <div className="panel-body dispute-body">
        <div className="field">
          <label>Captured transaction</label>
          <div className="tx-pick-list">
            {capturables.length === 0 && (
              <div style={{ color: 'var(--tx-2)', fontSize: 11 }}>no captured transactions yet — run one through the Agent Checkout view</div>
            )}
            {capturables.map((c) => (
              <button type="button" key={c.seq} className={'tx-pick' + (c.seq === pickedSeq ? ' selected' : '')} onClick={() => { setPickedSeq(c.seq); setDisputeOpened(false); setEvidence(null); }}>
                <span className="amt">#{c.seq}</span>
                <span>{c.memo.split(' · ')[1] ?? c.memo}</span>
                <span className="amt">{c.amountPaise ? formatINR(c.amountPaise) : '—'}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="field">
          <label htmlFor="pd-reason">Dispute reason</label>
          <select id="pd-reason" value={reason} onChange={(e) => setReason(e.target.value)}>
            {DISPUTE_REASONS.map((r) => (
              <option key={r.code} value={r.code}>
                {r.label}
              </option>
            ))}
          </select>
        </div>
        {error && (
          <p className="form-error" role="alert">✕ {error}</p>
        )}
        {picked && (
          <div className="picked-summary">
            <span className="ps-lbl">DISPUTING</span>
            <span className="ps-main">ledger #{picked.seq} · {formatINR(picked.amountPaise ?? '0')}</span>
            <span className="ps-sub">
              {picked.type} at {new Date(picked.ts).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false })}
            </span>
          </div>
        )}
        <div className="actions-row">
          <button className="btn" disabled={busy || pickedSeq == null || disputeOpened} onClick={openDispute}>
            Open Dispute
          </button>
          <button className="btn amber" disabled={busy || pickedSeq == null || !disputeOpened} onClick={generateEvidence}>
            Generate Evidence Pack
          </button>
        </div>

        {evidence && (
          <>
            <div className="evidence-frame-shell">
              <iframe title={`Evidence pack ${evidence.disputeId}`} srcDoc={evidence.html} sandbox="" />
              <div className="evidence-caption">
                DOSSIER {evidence.disputeId} · RENDERED FROM LEDGER · sha256 {evidence.sha256.slice(0, 32)}…
              </div>
            </div>
            <button
              className="btn quiet"
              style={{ marginTop: 8 }}
              onClick={() => {
                const w = window.open('', '_blank');
                if (w) {
                  w.document.write(evidence.html);
                  w.document.close();
                }
              }}
            >
              Open pack in new tab
            </button>
          </>
        )}
      </div>
    </section>
  );
}
