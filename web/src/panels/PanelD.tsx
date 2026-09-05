import { useEffect, useMemo, useState } from 'react';
import type { SharedState } from '../App';
import { formatINR } from '../api';

const DISPUTE_REASONS = [
  'UNAUTHORIZED_TRANSACTION',
  'SERVICE_NOT_RECEIVED',
  'DUPLICATE_CHARGE',
  'AMOUNT_MISMATCH',
  'AGENT_EXCEEDED_SCOPE',
] as const;

export function PanelD({ shared }: { shared: SharedState }) {
  const { api, ledger, refreshLedger } = shared;
  // Captured (ALLOWED) transactions are the disputable ones.
  const capturables = useMemo(() => ledger.filter((l) => l.type === 'ATTEMPT_ALLOWED'), [ledger]);
  const [pickedSeq, setPickedSeq] = useState<number | null>(null);
  const [reason, setReason] = useState<string>(DISPUTE_REASONS[0]);
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
  void picked;

  async function openDispute() {
    if (pickedSeq == null) return;
    setBusy(true);
    setError(null);
    try {
      await api.openDispute({ ledgerSeq: pickedSeq, reason });
      setDisputeOpened(true);
      setEvidence(null);
      await refreshLedger();
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
      await refreshLedger();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Evidence pack generation failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel panel-d" aria-label="Dispute desk">
      <header>
        <span className="panel-key">D</span>
        <h2>Dispute Desk</h2>
        <span className="sub">contest with evidence</span>
      </header>
      <div className="panel-body dispute-body">
        <div className="field">
          <label>Captured transaction</label>
          <div className="tx-pick-list">
            {capturables.length === 0 && (
              <div style={{ color: 'var(--tx-2)', fontSize: 11 }}>no captured transactions yet — allow one in Panel B</div>
            )}
            {capturables.slice(0, 5).map((c) => (
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
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </div>
        <div className="two-col">
          {error && (
            <p className="form-error" role="alert">✕ {error}</p>
          )}
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
