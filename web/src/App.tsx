import { useCallback, useMemo, useRef, useState } from 'react';
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

export function App() {
  const [mockMode, setMockMode] = useState(true);
  const [artifacts, setArtifacts] = useState<DelegationArtifact[]>([]);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const apiRef = useRef<PramaanApi>(createApi('mock'));
  if (mockMode === false && apiRef.current.mode !== 'real') apiRef.current = createApi('real');
  if (mockMode === true && apiRef.current.mode !== 'mock') apiRef.current = createApi('mock');

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

  return (
    <div className="console">
      <Masthead mockMode={mockMode} setMockMode={setMockMode} />
      <main className="desk">
        <PanelA shared={shared} />
        <PanelB shared={shared} />
        <PanelC shared={shared} />
        <PanelD shared={shared} />
        <PanelE shared={shared} />
      </main>
    </div>
  );
}

function Masthead({ mockMode, setMockMode }: { mockMode: boolean; setMockMode: (v: boolean) => void }) {
  return (
    <header className="masthead">
      <div className="wordmark">
        {/* original mark: a seal glyph inside a chain-link */}
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <rect x="2.5" y="2.5" width="19" height="19" rx="3" stroke="#62C6D9" strokeWidth="1.4" />
          <path d="M8.2 15.8V8.2h4.1a2.6 2.6 0 0 1 0 5.2H9.9m1.6 0 3 2.4" stroke="#E8EDF2" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          <circle cx="12" cy="12" r="9.6" stroke="#2E3A46" strokeWidth="0.6" strokeDasharray="1.5 2.5" />
        </svg>
        Pramaan
        <span className="devanagari">प्रमाण</span>
      </div>
      <span className="tagline">a desk where a human supervises machine spending</span>
      <span className="spacer" />
      <div className="meta">
        <span><span className="dot">●</span> RAZORPAY TEST MODE</span>
        <span>KADAI &amp; CO. · INDIRANAGAR</span>
        <button className="mode-toggle" onClick={() => setMockMode(!mockMode)} title="Toggle mock / real API">
          {mockMode ? 'MOCK ENGINE' : 'LIVE API'}
        </button>
      </div>
    </header>
  );
}
