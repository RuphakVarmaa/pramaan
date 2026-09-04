import { useState } from 'react';
import type { SharedState } from '../App';
import { AGENT_PERSONAS, formatINR, formatIST } from '../api';

const CATEGORIES = ['coffee', 'equipment', 'pantry', 'merch'] as const;

/** Renders JSON with a light hand-rolled syntax tint (mono, no external hl lib). */
function JsonBlock({ obj }: { obj: unknown }) {
  const text = JSON.stringify(obj, null, 2);
  const parts = text.split(/("(?:\\.|[^"\\])*"(?:\s*:)?|\b-?\d+(?:\.\d+)?\b|\btrue\b|\bfalse\b|\bnull\b|[[\]{},])/g);
  return (
    <pre>
      {parts.map((p, i) => {
        if (!p) return null;
        let cls = 'tok-punc';
        if (/^"/.test(p)) cls = p.endsWith(':') ? 'tok-key' : 'tok-str';
        else if (/^-?\d/.test(p)) cls = 'tok-num';
        return (
          <span key={i} className={cls}>
            {p}
          </span>
        );
      })}
    </pre>
  );
}

export function PanelA({ shared }: { shared: SharedState }) {
  const { api, registerArtifact, refreshLedger } = shared;
  const [principalName, setPrincipalName] = useState('Rukmini Desai');
  const [principalEmail, setPrincipalEmail] = useState('rukmini@example.in');
  const [agentId, setAgentId] = useState<string>(AGENT_PERSONAS[0].id);
  const [categories, setCategories] = useState<string[]>(['coffee', 'pantry']);
  const [perTxn, setPerTxn] = useState('80000'); // ₹800 in paise-as-string
  const [aggregate, setAggregate] = useState('250000'); // ₹2,500
  const [expiryMin, setExpiryMin] = useState('30');
  const [artifact, setArtifact] = useState<ReturnType<typeof Object> | null>(null);
  const [busy, setBusy] = useState(false);

  const toggleCat = (c: string) =>
    setCategories((prev) => (prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]));

  async function issue() {
    setBusy(true);
    try {
      const a = await api.issueDelegation({
        principalName,
        principalEmail,
        agentId,
        categories,
        perTxnCapPaise: perTxn,
        aggregateCapPaise: aggregate,
        expiryMinutes: Number(expiryMin) || 30,
      });
      setArtifact(a);
      registerArtifact(a);
      await refreshLedger();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel panel-a" aria-label="Merchant desk">
      <header>
        <span className="panel-key">A</span>
        <h2>Merchant Desk</h2>
        <span className="sub">issue delegation</span>
      </header>
      <div className="merchant-strip">
        <span className="m-name">Kadai &amp; Co.</span>
        <span className="m-id">kadai-and-co · fixed merchant</span>
      </div>
      <div className="panel-body">
        <div className="issue-form">
          <div className="field">
            <label htmlFor="pa-principal">Principal (human)</label>
            <input id="pa-principal" type="text" value={principalName} onChange={(e) => setPrincipalName(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="pa-email">Principal email</label>
            <input id="pa-email" type="email" value={principalEmail} onChange={(e) => setPrincipalEmail(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="pa-agent">Agent</label>
            <select id="pa-agent" value={agentId} onChange={(e) => setAgentId(e.target.value)}>
              {AGENT_PERSONAS.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.persona} — {a.model}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>Categories in scope</label>
            <div className="chip-row">
              {CATEGORIES.map((c) => (
                <button
                  type="button"
                  key={c}
                  className={'chip' + (categories.includes(c) ? ' on' : '')}
                  onClick={() => toggleCat(c)}
                  aria-pressed={categories.includes(c)}
                >
                  {c}
                </button>
              ))}
            </div>
          </div>
          <div className="two-col">
            <div className="field">
              <label htmlFor="pa-per">Per-txn cap (paise)</label>
              <input id="pa-per" type="number" min="1" value={perTxn} onChange={(e) => setPerTxn(e.target.value)} />
              <div className="hint">{formatINR(perTxn)}</div>
            </div>
            <div className="field">
              <label htmlFor="pa-agg">Aggregate cap (paise)</label>
              <input id="pa-agg" type="number" min="1" value={aggregate} onChange={(e) => setAggregate(e.target.value)} />
              <div className="hint">{formatINR(aggregate)}</div>
            </div>
          </div>
          <div className="field">
            <label htmlFor="pa-exp">Expiry (minutes from now)</label>
            <input id="pa-exp" type="number" min="1" value={expiryMin} onChange={(e) => setExpiryMin(e.target.value)} />
          </div>
          <button className="btn primary block" disabled={busy || categories.length === 0 || !principalName} onClick={issue}>
            {busy ? 'Signing…' : 'Issue Delegation →'}
          </button>
          {artifact && (
            <div className="artifact-view">
              <div className="codeblock">
                <button
                  className="btn quiet copy-btn"
                  onClick={() => navigator.clipboard?.writeText(JSON.stringify(artifact, null, 2))}
                >
                  COPY
                </button>
                <JsonBlock obj={artifact} />
              </div>
              <div className="sig-line">
                <span>ed25519 sig:</span>
                <span className="sig">{artifact.signature}</span>
              </div>
              <div className="sig-line" style={{ marginTop: 4 }}>
                <span>valid until</span>
                <span className="sig">{formatIST(artifact.scope.expiresAt)}</span>
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
