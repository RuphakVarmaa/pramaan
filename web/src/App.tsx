import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createApi, type PramaanApi, type DelegationArtifact, type LedgerEntry } from './api';
import { PanelA } from './panels/PanelA';
import { PanelB } from './panels/PanelB';
import { PanelC } from './panels/PanelC';
import { PanelD } from './panels/PanelD';
import { PanelE } from './panels/PanelE';

export interface SharedState {
  api: PramaanApi;
  artifacts: DelegationArtifact[];
  registerArtifact: (a: DelegationArtifact) => void;
  refreshLedger: () => Promise<void>;
  ledger: LedgerEntry[];
  mockMode: boolean;
  setMockMode: (on: boolean) => void;
}

type ViewKey = 'issue' | 'shop' | 'ledger' | 'dispute' | 'risk';

const NAV: Array<{ key: ViewKey; label: string; sub: string }> = [
  { key: 'issue', label: 'Issue Delegation', sub: 'merchant desk' },
  { key: 'shop', label: 'Agent Checkout', sub: 'gate the cart' },
  { key: 'ledger', label: 'Ledger', sub: 'audit trail' },
  { key: 'dispute', label: 'Dispute', sub: 'evidence pack' },
  { key: 'risk', label: 'Risk Gate', sub: 'fraud pass-through' },
];

export function App() {
  const [mockMode, setMockMode] = useState(true);
  const [view, setView] = useState<ViewKey>('issue');
  const [artifacts, setArtifacts] = useState<DelegationArtifact[]>([]);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const apiRef = useRef<PramaanApi>(createApi('mock'));
  useEffect(() => {
    apiRef.current = createApi(mockMode ? 'mock' : 'real');
    // artifacts from the previous mode are meaningless in the new one
    // (mock ids prm_… don't exist in the real backend and vice versa)
    setArtifacts([]);
    setLedger([]);
    void apiRef.current.listLedger().then(setLedger).catch(() => {});
  }, [mockMode]);

  const refreshLedger = useCallback(async () => {
    setLedger(await apiRef.current.listLedger());
  }, []);

  const registerArtifact = useCallback((a: DelegationArtifact) => {
    setArtifacts((prev) => [a, ...prev]);
  }, []);

  const shared = useMemo<SharedState>(
    () => ({
      api: apiRef.current,
      artifacts,
      registerArtifact,
      refreshLedger,
      ledger,
      mockMode,
      setMockMode,
    }),
    [artifacts, registerArtifact, refreshLedger, ledger, mockMode],
  );

  const go = (v: ViewKey) => {
    setView(v);
    window.scrollTo({ top: 0 });
  };

  return (
    <div className="console">
      <Masthead mockMode={mockMode} setMockMode={setMockMode} />
      <div className="shell">
        <nav className="sidenav" aria-label="Console sections">
          {NAV.map((n) => (
            <button
              key={n.key}
              type="button"
              className={'nav-item' + (view === n.key ? ' active' : '')}
              aria-current={view === n.key ? 'page' : undefined}
              onClick={() => go(n.key)}
            >
              <span className="nav-text">
                <span className="nav-label">{n.label}</span>
                <span className="nav-sub">{n.sub}</span>
              </span>
            </button>
          ))}
          <div className="nav-foot">
            <span className="nav-count">{ledger.length} ledger entries</span>
            <span className="nav-note">test mode · stub payments</span>
          </div>
        </nav>
        <main className="stage" id="main">
          {view === 'issue' && <PanelA shared={shared} onDone={() => go('shop')} />}
          {view === 'shop' && <PanelB shared={shared} />}
          {view === 'ledger' && <PanelC shared={shared} />}
          {view === 'dispute' && <PanelD shared={shared} />}
          {view === 'risk' && <PanelE shared={shared} />}
        </main>
      </div>
    </div>
  );
}

function Masthead({
  mockMode,
  setMockMode,
}: {
  mockMode: boolean;
  setMockMode: (v: boolean) => void;
}) {
  return (
    <header className="masthead">
      <div className="wordmark">
        {/* original mark: a seal glyph inside a chain-link */}
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <rect x="2.5" y="2.5" width="19" height="19" rx="3" stroke="#62C6D9" strokeWidth="1.4" />
          <path d="M8.2 15.8V8.2h4.1a2.6 2.6 0 0 1 0 5.2H9.9m1.6 0 3 2.4" stroke="#E8EDF2" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          <circle cx="12" cy="12" r="9.6" stroke="#2E3A46" strokeWidth="0.6" strokeDasharray="1.5 2.5" />
        </svg>
        <span className="word">Pramaan</span>
        <span className="devanagari">प्रमाण</span>
      </div>
      <span className="tagline">a desk where a human supervises machine spending</span>
      <span className="spacer" />
      <div className="meta">
        <span className="status">
          <span className={'dot' + (mockMode ? '' : ' live')} aria-hidden="true" />{' '}
          {mockMode ? 'MOCK ENGINE' : 'LIVE API'}
        </span>
        <button
          className="mode-toggle"
          onClick={() => setMockMode(!mockMode)}
          aria-pressed={mockMode}
          title={mockMode ? 'Switch to the live API' : 'Switch back to the mock engine'}
        >
          {mockMode ? 'GO LIVE' : 'USE MOCK'}
        </button>
      </div>
    </header>
  );
}
