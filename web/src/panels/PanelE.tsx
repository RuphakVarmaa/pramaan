import { useEffect, useRef, useState } from 'react';
import type { SharedState } from '../App';
import { formatINR, formatIST, type FraudFlag, type FraudVerdict } from '../api';

export function PanelE({ shared }: { shared: SharedState }) {
  const { api, refreshLedger, mockMode } = shared;
  const [flags, setFlags] = useState<FraudFlag[]>([]);
  const [pickedFlag, setPickedFlag] = useState<string | null>(null);
  const [withArtifact, setWithArtifact] = useState(true);
  const [verdict, setVerdict] = useState<FraudVerdict | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const setBusySafe = (v: boolean) => {
    busyRef.current = v;
    setBusy(v);
  };
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      if (!alive) return;
      try {
        const f = await api.listFraudFlags();
        if (alive) {
          setLoadError(null);
          setLoading(false);
          setFlags(f);
          setPickedFlag((p) => {
            const stillThere = p && f.some((x) => x.flagId === p);
            if (!stillThere) setVerdict(null); // selection changed — old verdict is stale
            return stillThere ? p : (f[0]?.flagId ?? null);
          });
        }
      } catch (err) {
        if (alive) {
          setLoading(false);
          setLoadError(err instanceof Error ? err.message : 'flag feed unavailable — real mode needs the API up');
        }
      }
    };
    void load();
    const t = setInterval(() => {
      if (document.hidden || busyRef.current) return; // never reorder mid-review
      void load();
    }, 6000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [api, mockMode]);

  async function runGate() {
    if (!pickedFlag) return;
    setBusySafe(true);
    setError(null);
    setVerdict(null); // no stale result while a new one is in flight
    try {
      const v = await api.runFraudGate({ flagId: pickedFlag, withArtifact });
      setVerdict(v);
      await refreshLedger();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Fraud gate evaluation failed');
    } finally {
      setBusySafe(false);
    }
  }

  return (
    <section className="panel panel-e" aria-label="Risk desk">
      <header>
        <h2>Risk Desk</h2>
        <span className="sub">fraud pass-through</span>
      </header>
      <div className="panel-body risk-body" aria-busy={busy}>
        {loading && (
          <p className="hint" role="status">loading flagged transactions…</p>
        )}
        {loadError && (
          <p className="form-error" role="alert">✕ {loadError}</p>
        )}
        {flags.length === 0 && !loadError && !loading && (
          <div style={{ color: 'var(--tx-2)', fontSize: 11 }}>
            no flagged transactions in the feed — bot-like Razorpay test payments will appear here
          </div>
        )}
        <div className="flag-feed">
        {flags.map((f) => (
          <button
            type="button"
            key={f.flagId}
            className={'flag-item' + (f.flagId === pickedFlag ? ' selected' : '')}
            aria-pressed={f.flagId === pickedFlag}
            style={{
              cursor: 'pointer',
              textAlign: 'left',
              font: 'inherit',
              display: 'grid',
              borderColor: f.flagId === pickedFlag ? 'rgba(97,198,217,.5)' : undefined,
            }}
            disabled={busy}
            onClick={() => {
              setPickedFlag(f.flagId);
              setVerdict(null);
              setError(null);
            }}
          >
            <span className="f-head">
              <span className="f-amt">{formatINR(f.amountPaise)}</span>
              <span className="f-id">
                {f.orderId} · {f.actor}
              </span>
            </span>
            <span>
              {f.signals.map((s) => (
                <span key={s} className="signal-tag">
                  {s}
                </span>
              ))}
            </span>
            <span className="f-id" style={{ gridColumn: '1 / -1' }}>
              flagged {formatIST(f.flaggedAt)}
            </span>
          </button>
        ))}
        </div>
        <div className="risk-controls">
          <label>
            <input
              type="checkbox"
              checked={withArtifact}
              disabled={busy}
              onChange={(e) => setWithArtifact(e.target.checked)}
            />
            valid delegation artifact presented
          </label>
          <span className="helper-text">the agent presents its signed mandate for this exact transaction</span>
          <span style={{ flex: 1 }} />
          <button className="btn" disabled={busy || !pickedFlag} onClick={runGate}>
            {busy ? 'Evaluating…' : 'Run Pramaan Gate'}
          </button>
        </div>
        {error && (
          <p className="form-error" role="alert">✕ {error}</p>
        )}
        {verdict && (
          <div className={'release-seal' + (verdict.decision === 'BLOCK' ? ' blocked' : '')} role="status" aria-live="polite">
            {verdict.decision === 'RELEASE' ? (
              <>
                {/* original seal motif */}
                <svg width="34" height="34" viewBox="0 0 34 34" fill="none" aria-hidden="true">
                  <circle cx="17" cy="17" r="15" stroke="#3DD68C" strokeWidth="1.6" />
                  <circle cx="17" cy="17" r="11.5" stroke="#3DD68C" strokeWidth="0.7" strokeDasharray="2 3" />
                  <path d="M11.5 17.2l3.6 3.6 7.2-7.6" stroke="#3DD68C" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <span className="txt">
                  RELEASED
                  <br />
                  <span className="proof-text proof-ok">{verdict.proof}</span>
                </span>
              </>
            ) : (
              <>
                <svg width="34" height="34" viewBox="0 0 34 34" fill="none" aria-hidden="true">
                  <circle cx="17" cy="17" r="15" stroke="#E2B93B" strokeWidth="1.6" />
                  <path d="M12 12l10 10M22 12L12 22" stroke="#E2B93B" strokeWidth="2" strokeLinecap="round" />
                </svg>
                <span className="txt">
                  BLOCKED
                  <br />
                  <span className="proof-text proof-no">{verdict.proof}</span>
                </span>
              </>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
