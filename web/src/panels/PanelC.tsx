import { useEffect, useRef, useState } from 'react';
import type { SharedState } from '../App';
import { formatINR, truncateHash, type ChainVerification, type LedgerEntry } from '../api';

export function PanelC({ shared }: { shared: SharedState }) {
  const { api, ledger, refreshLedger } = shared;
  const [verification, setVerification] = useState<ChainVerification | null>(null);
  const [busy, setBusy] = useState(false);
  const prevSeqRef = useRef(0);

  // Initial load + stay live: parent refreshes after every action; also poll gently.
  useEffect(() => {
    void refreshLedger();
    const t = setInterval(() => void refreshLedger(), 4000);
    return () => clearInterval(t);
  }, [refreshLedger]);

  // Track the newest seq so newly arrived rows get the settle animation exactly once.
  const newestSeq = ledger[0]?.seq ?? 0;
  useEffect(() => {
    if (newestSeq > prevSeqRef.current) prevSeqRef.current = newestSeq;
  }, [newestSeq]);

  async function verify() {
    setBusy(true);
    try {
      const v = await api.verifyChain();
      setVerification(v);
      // Real mode re-reads the ledger from source for the recompute display.
      await refreshLedger();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel panel-c" aria-label="Ledger">
      <header>
        <span className="panel-key">C</span>
        <h2>The Ledger</h2>
        <span className="sub">hash-chained · append-only · every money action</span>
        <span className="spacer" />
        {verification && (
          <span className={'chain-status ' + (verification.valid ? 'ok' : 'pending')}>
            {verification.valid
              ? `CHAIN VERIFIED · ${verification.checkedEntries} ENTRIES`
              : `BROKEN AT #${verification.brokenAtSeq}`}
          </span>
        )}
        <button className="btn quiet verify" onClick={verify} disabled={busy}>
          {busy ? 'RECOMPUTING…' : 'VERIFY CHAIN'}
        </button>
      </header>
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
            {ledger.map((e) => (
              <LedgerRow key={e.seq} entry={e} />
            ))}
          </tbody>
        </table>
        {ledger.length === 0 && (
          <div style={{ padding: '30px 14px', color: 'var(--tx-2)', fontSize: 11 }}>awaiting first entry…</div>
        )}
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
        <span>{verification?.valid ? '● INTEGRITY: VERIFIED' : '● INTEGRITY: NOT YET CHECKED'}</span>
      </footer>
    </section>
  );
}

function LedgerRow({ entry: e }: { entry: LedgerEntry }) {
  const ts = new Date(e.ts);
  const hhmmss = ts.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
  return (
    <tr className="ledger-row">
      <td className="seq">{String(e.seq).padStart(3, '0')}</td>
      <td className="ts">{hhmmss}</td>
      <td className={'typ typ-' + e.type}>{e.type}</td>
      <td className="amt">{e.amountPaise ? formatINR(e.amountPaise) : '—'}</td>
      <td className={'verd-cell-' + (e.verdict ?? 'INFO')}>{e.verdict ?? '—'}</td>
      <td className="reason-cell">{e.reason ?? '—'}</td>
      <td className="hash-cell" tabIndex={0}>
        {truncateHash(e.prevHash)}
        <span className="link-arrow">→</span>
        {truncateHash(e.selfHash)}
        <span className="full-hash">
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
