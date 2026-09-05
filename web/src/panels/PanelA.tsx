import { useState } from 'react';
import type { SharedState } from '../App';
import { AGENT_PERSONAS, formatINR, formatIST } from '../api';

const CATEGORIES = ['coffee', 'equipment', 'pantry', 'merch'] as const;

/** Renders JSON with a light hand-rolled syntax tint (mono, no external hl lib). */
function JsonBlock({ obj }: { obj: unknown }) {
  const text = JSON.stringify(obj, null, 2);
  const parts = text.split(/("(?:\\.|[^"\\])*"(?:\s*:)?|\b-?\d+(?:\.\d+)?\b|\btrue\b|\bfalse\b|\bnull\b|[[\]{},])/g);
  return (
    <pre aria-label="delegation artifact JSON">
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

/** Rupees (what humans think in) <-> paise (what the wire carries). */
const rupeesToPaise = (r: string): string => {
  const n = Number(r);
  return Number.isFinite(n) && n > 0 ? String(Math.round(n * 100)) : '';
};

export function PanelA({ shared }: { shared: SharedState }) {
  const { api, registerArtifact, refreshLedger } = shared;
  const [principalName, setPrincipalName] = useState('Rukmini Desai');
  const [principalEmail, setPrincipalEmail] = useState('rukmini@example.in');
  const [agentId, setAgentId] = useState<string>(AGENT_PERSONAS[0].id);
  const [categories, setCategories] = useState<string[]>(['coffee', 'pantry']);
  const [perTxn, setPerTxn] = useState('800'); // rupees — what the human means
  const [aggregate, setAggregate] = useState('2500'); // rupees
  const [expiryMin, setExpiryMin] = useState('30');
  const [artifact, setArtifact] = useState<ReturnType<typeof Object> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const toggleCat = (c: string) =>
    setCategories((prev) => (prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]));

  async function issue(e?: React.FormEvent) {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    setOk(null);
    try {
      const a = await api.issueDelegation({
        principalName,
        principalEmail,
        agentId,
        categories,
        perTxnCapPaise: rupeesToPaise(perTxn),
        aggregateCapPaise: rupeesToPaise(aggregate),
        expiryMinutes: Number(expiryMin) || 30,
      });
      setArtifact(a);
      registerArtifact(a);
      await refreshLedger();
      setOk(`Delegation issued — ledger updated · valid ${formatIST(a.scope.expiresAt)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Issuance failed');
    } finally {
      setBusy(false);
    }
  }

  const perPaise = rupeesToPaise(perTxn);
  const aggPaise = rupeesToPaise(aggregate);
  const expiry = Number(expiryMin);
  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(principalEmail);
  const canIssue =
    !busy && categories.length > 0 && !!principalName && emailOk && !!perPaise && !!aggPaise && Number.isFinite(expiry) && expiry >= 1;
  const whyDisabled =
    categories.length === 0
      ? 'select at least one category'
      : !perPaise || !aggPaise
        ? 'caps must be positive amounts'
        : !principalName
          ? 'principal name required'
          : !emailOk
            ? 'principal email required (name@domain)'
            : !Number.isFinite(expiry) || expiry < 1
              ? 'expiry must be at least 1 minute'
              : null;

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
        <form className="issue-form" onSubmit={issue} noValidate>
          {error && (
            <p className="form-error" role="alert">
              ✕ {error}
            </p>
          )}
          {ok && (
            <p className="form-ok" role="status">
              ✓ {ok}
            </p>
          )}
          <div className="field">
            <label htmlFor="pa-principal">Principal (human)</label>
            <input
              id="pa-principal"
              type="text"
              required
              autoComplete="name"
              value={principalName}
              onChange={(e) => setPrincipalName(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="pa-email">Principal email</label>
            <input
              id="pa-email"
              type="email"
              required
              autoComplete="email"
              value={principalEmail}
              onChange={(e) => setPrincipalEmail(e.target.value)}
            />
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
          <fieldset className="field chip-fieldset">
            <legend>Categories in scope</legend>
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
          </fieldset>
          <div className="two-col">
            <div className="field">
              <label htmlFor="pa-per">Per-txn cap (₹)</label>
              <input
                id="pa-per"
                type="number"
                min="1"
                step="1"
                inputMode="decimal"
                required
                value={perTxn}
                onChange={(e) => setPerTxn(e.target.value)}
              />
              <div className="hint">{perPaise ? `${formatINR(perPaise)} · ${perPaise} paise` : 'enter an amount'}</div>
            </div>
            <div className="field">
              <label htmlFor="pa-agg">Aggregate cap (₹)</label>
              <input
                id="pa-agg"
                type="number"
                min="1"
                step="1"
                inputMode="decimal"
                required
                value={aggregate}
                onChange={(e) => setAggregate(e.target.value)}
              />
              <div className="hint">{aggPaise ? `${formatINR(aggPaise)} · ${aggPaise} paise` : 'enter an amount'}</div>
            </div>
          </div>
          <div className="field">
            <label htmlFor="pa-exp">Expiry (minutes from now)</label>
            <input
              id="pa-exp"
              type="number"
              min="1"
              inputMode="numeric"
              required
              value={expiryMin}
              onChange={(e) => setExpiryMin(e.target.value)}
            />
          </div>
          <button className="btn primary block" type="submit" disabled={!canIssue} title={whyDisabled ?? undefined}>
            {busy ? 'Signing…' : 'Issue Delegation →'}
          </button>
          {!canIssue && whyDisabled && (
            <p className="hint disabled-why" aria-live="polite">
              {whyDisabled}
            </p>
          )}
          {artifact && (
            <div className="artifact-view">
              <div className="codeblock">
                <button
                  type="button"
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
        </form>
      </div>
    </section>
  );
}
