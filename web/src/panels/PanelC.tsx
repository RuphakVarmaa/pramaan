import { useEffect, useRef, useState } from 'react';
import type { SharedState } from '../App';
import { formatINR, truncateHash, type ChainVerification, type LedgerEntry } from '../api';

export function PanelC({ shared }: { shared: SharedState }) {
  const { api, ledger, refreshLedger } = shared;
  const [verification, setVerification] = useState<ChainVerification | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const prevSeqRef = useRef(0);
  const ledgerSeq = ledger.length > 0 ? Math.max(...ledger.map((l) => l.seq)) : 0;
  const verifiedAtSeqRef = useRef(0);

  // A new ledger entry invalidates a previous verification: the chain grew.
  useEffect(() => {
    if (verification && ledgerSeq !== verifiedAtSeqRef.current) {
      setVerification(null);
    }
  }, [ledgerSeq, verification]);

  // Initial load + stay live; pause while hidden, stamp last-updated.
  useEffect(() => {
    const tick = () => {
      if (document.hidden) return;
      refreshLedger()
        .then(() => setLastUpdated(new Date().toLocaleTimeString('en-IN', { hour12: false })))
        .catch(() => setLastUpdated(null));
    };
    tick();
    const t = setInterval(tick, 4000);
    return () => clearInterval(t);
  }, [refreshLedger]);

  // Track the newest seq so newly arrived rows get the settle animation exactly once.
  const newestSeq = ledger[0]?.seq ?? 0;
  useEffect(() => {
    if (newestSeq > prevSeqRef.current) prevSeqRef.current = newestSeq;
  }, [newestSeq]);

  async function verify() {
    setBusy(true);
    setError(null);
    try {
      const v = await api.verifyChain();
      setVerification(v);
      verifiedAtSeqRef.current = ledgerSeq;
      // Real mode re-reads the ledger from source for the recompute display.
      await refreshLedger();
    } catch (err) {
      // do NOT fabricate a chain verdict — the verification is unknown, not broken
      setError(err instanceof Error ? err.message : 'Verification failed — chain status unknown');
      setVerification(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel panel-c" aria-label="Ledger">
      <header>
        <div className="hdr-line">
          <h2>The Ledger</h2>
          <span className="sub">hash-chained · append-only · every money action</span>
        </div>
        <div className="hdr-actions">
        {verification && (
          <span className={'chain-status ' + (verification === null ? 'unknown' : verification.valid ? 'ok' : 'broken')}>
            {verification.valid
              ? `CHAIN VERIFIED · ${verification.checkedEntries} ENTRIES`
              : `BROKEN AT #${verification.brokenAtSeq}`}
          </span>
        )}
        {lastUpdated && (
          <span className="live-stamp" title="ledger last synced">
            LIVE · {lastUpdated}
          </span>
        )}
        <button className="btn quiet verify" onClick={verify} disabled={busy}>
          {busy ? 'RECOMPUTING…' : 'VERIFY CHAIN'}
        </button>
        </div>
      </header>
      {error && (
        <p className="form-error" role="alert" style={{ margin: '8px 14px' }}>✕ {error}</p>
      )}
      <div className="panel-body">
        <table className="ledger-table">
          <thead>
            <tr>
              <th>SEQ</th>
              <th>TIMESTAMP</th>
              <th>TYPE</th>
              <th style={{ textAlign: 'right' }}>AMOUNT</th>
              <th>VERDICT</th>
              <th>REASON</th>
              <th>PREV → SELF</th>
              <th>MEMO</th>
            </tr>
          </thead>
          <tbody>
            {ledger.length === 0 ? (
              <tr>
                <td colSpan={8} className="ledger-empty">
                  awaiting first entry — issue a delegation in Panel A
                </td>
              </tr>
            ) : (
              ledger.map((e) => (
                <LedgerRow key={e.seq} entry={e} />
              ))
            )}
          </tbody>
        </table>
      </div>
      <footer
        style={{
          flex: 'none',
          borderTop: '1px solid var(--line-0)',
          padding: '7px 14px',
          fontSize: '9.5px',
          letterSpacing: '0.14em',
          color: 'var(--tx-2)',
          display: 'flex',
          justifyContent: 'space-between',
        }}
      >
        <span>APPEND-ONLY · NO UPDATES · NO DELETIONS</span>
        <span
          className={
            verification === null
              ? 'integrity unknown'
              : verification.valid
                ? 'integrity verified'
                : 'integrity broken'
          }
        >
          {verification === null
            ? '● INTEGRITY: NOT YET CHECKED'
            : verification.valid
              ? `● INTEGRITY: VERIFIED (${verification.checkedEntries} ENTRIES)`
              : `● INTEGRITY: BROKEN${verification.brokenAtSeq ? ` AT #${verification.brokenAtSeq}` : ''}`}
        </span>
      </footer>
    </section>
  );
}

function LedgerRow({ entry: e }: { entry: LedgerEntry }) {
  const [hashOpen, setHashOpen] = useState(false);
  const ts = new Date(e.ts);
  const hhmmss = ts.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return (
    <tr className="ledger-row">
      <td className="seq">{String(e.seq).padStart(3, '0')}</td>
      <td className="ts">{hhmmss}</td>
      <td className={'typ typ-' + e.type}>{e.type}</td>
      <td className="amt">{e.amountPaise ? formatINR(e.amountPaise) : '—'}</td>
      <td className={'verd-cell-' + (e.verdict ?? 'INFO')}>{e.verdict ?? '—'}</td>
      <td className="reason-cell">{e.reason ?? '—'}</td>
      <td className="hash-cell">
        <button
          type="button"
          className="hash-btn"
          aria-label={`Toggle full hashes for ledger entry ${e.seq}`}
          aria-expanded={hashOpen}
          aria-controls={`full-hash-${e.seq}`}
          onClick={() => setHashOpen((v) => !v)}
        >
          {truncateHash(e.prevHash)}
          <span className="link-arrow">→</span>
          {truncateHash(e.selfHash)}
        </button>
        <span id={`full-hash-${e.seq}`} className={"full-hash" + (hashOpen ? " open" : "")}>
          <b style={{ color: 'var(--verd-cyan)' }}>prev_hash</b>
          <br />
          {e.prevHash}
          <br />
          <b style={{ color: 'var(--verd-cyan)' }}>self_hash</b>
          <br />
          {e.selfHash}
          <br />
          <span style={{ color: 'var(--tx-2)' }}>
            sha-256 over canonical JSON of (seq, prev_hash, ts, type, amount, verdict, reason, actor, memo)
          </span>
        </span>
      </td>
      <td className="memo-cell" title={e.memo}>
        {e.memo}
      </td>
    </tr>
  );
}
