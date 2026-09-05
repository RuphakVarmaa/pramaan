import { useMemo, useState } from 'react';
import type { SharedState } from '../App';
import { formatINR, formatIST, type GateVerdict } from '../api';
import catalog from '../data/catalog.json' with { type: 'json' };

interface Product {
  sku: string;
  name: string;
  category: string;
  unitPaise: number;
  description: string;
}
const products = catalog.products as Product[];
const categories = catalog.merchant.categories as string[];

const REASON_PROSE: Record<string, string> = {
  CAP_EXCEEDED_PER_TXN: 'The basket exceeds the artifact’s per-transaction cap. The agent stays inside its mandate; the money does not.',
  CAP_EXCEEDED_AGGREGATE: 'The aggregate cap for this delegation is exhausted. No further spending is authorized.',
  CATEGORY_NOT_IN_SCOPE: 'One or more items fall outside the categories this delegation authorizes.',
  ARTIFACT_EXPIRED: 'The delegation artifact has expired. Authority lapsed before the attempt.',
  ARTIFACT_NOT_FOUND: 'No delegation artifact was presented for this attempt.',
};

export function PanelB({ shared }: { shared: SharedState }) {
  const { api, artifacts, refreshLedger } = shared;
  const [artifactId, setArtifactId] = useState<string>('');
  const [cart, setCart] = useState<Record<string, number>>({});
  const [verdict, setVerdict] = useState<GateVerdict | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selected = artifacts.find((a) => a.artifactId === artifactId) ?? artifacts[0];
  const effectiveId = selected?.artifactId ?? '';

  const cartLines = useMemo(
    () =>
      Object.entries(cart)
        .filter(([, qty]) => qty > 0)
        .map(([sku, qty]) => ({ sku, qty, product: products.find((p) => p.sku === sku)! }))
        .filter((l) => l.product),
    [cart],
  );

  // paise-safe total: BigInt over integer paise
  const totalPaise = useMemo(
    () => cartLines.reduce((s, l) => s + BigInt(l.product.unitPaise) * BigInt(l.qty), 0n),
    [cartLines],
  );

  const setQty = (sku: string, d: number) => {
    setVerdict(null); // stale verdict must not survive a cart change
    setError(null);
    setCart((prev) => {
      const next = Math.max(0, (prev[sku] ?? 0) + d);
      return { ...prev, [sku]: next };
    });
  };

  const setQtyExact = (sku: string, raw: string) => {
    setVerdict(null);
    setError(null);
    const n = Math.max(0, Math.min(999, parseInt(raw, 10) || 0));
    setCart((prev) => ({ ...prev, [sku]: n }));
  };

  async function attempt() {
    if (!effectiveId || cartLines.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const v = await api.attemptPayment({
        artifactId: effectiveId,
        cart: cartLines.map(({ sku, qty }) => ({ sku, qty })),
      });
      setVerdict(v);
      await refreshLedger();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gate evaluation failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel panel-b" aria-label="Agent checkout">
      <header>
        <span className="panel-key">B</span>
        <h2>Agent Checkout</h2>
        <span className="sub">shop within mandate</span>
      </header>
      <div className="panel-body">
        <div style={{ padding: '10px 14px 0' }}>
          <div className="field">
            <label htmlFor="pb-artifact">Active delegation</label>
            <select id="pb-artifact" value={effectiveId} onChange={(e) => { setArtifactId(e.target.value); setVerdict(null); }}>
              {artifacts.length === 0 && <option value="">— issue one from Panel A first —</option>}
              {artifacts.map((a) => (
                <option key={a.artifactId} value={a.artifactId}>
                  {a.agent.persona} · {a.scope.categories.join('/')} · per-txn ≤ {formatINR(a.scope.perTxnCapPaise)}
                </option>
              ))}
            </select>
          </div>
          {selected && (
            <p className="scope-note">
              <b>{selected.principal.name}</b> delegates <b>{selected.agent.persona}</b> · categories{' '}
              <b>{selected.scope.categories.join(', ')}</b> · per-txn <b>{formatINR(selected.scope.perTxnCapPaise)}</b> · aggregate{' '}
              <b>{formatINR(selected.scope.aggregateCapPaise)}</b> · expires <b>{formatIST(selected.scope.expiresAt)}</b>
            </p>
          )}
        </div>
        <div className="catalog-list">
          {categories.map((cat) => (
            <div key={cat}>
              <div className="catalog-cat">{cat}</div>
              {products
                .filter((p) => p.category === cat)
                .map((p) => (
                  <div className="cat-item" key={p.sku}>
                    <div>
                      <div className="p-name">{p.name}</div>
                      <div className="p-sku">{p.sku}</div>
                    </div>
                    <div className="p-price">{formatINR(String(p.unitPaise))}</div>
                    <div className="stepper" data-sku={p.sku}>
                      <button type="button" aria-label={`remove one ${p.name}`} onClick={() => setQty(p.sku, -1)} disabled={(cart[p.sku] ?? 0) === 0}>
                        −
                      </button>
                      <input
                        className="qty"
                        type="number"
                        min={0}
                        max={999}
                        inputMode="numeric"
                        aria-label={`Quantity of ${p.name}`}
                        value={cart[p.sku] ?? 0}
                        onChange={(e) => setQtyExact(p.sku, e.target.value)}
                      />
                      <button type="button" aria-label={`add one ${p.name}`} onClick={() => setQty(p.sku, +1)} disabled={(cart[p.sku] ?? 0) >= 999}>
                        +
                      </button>
                    </div>
                  </div>
                ))}
            </div>
          ))}
        </div>
      </div>
      <div className="cart-summary">
        {cartLines.length > 0 && (
          <ul className="cart-lines">
            {cartLines.map((l) => (
              <li key={l.sku}>
                <span className="cl-name">{l.product.name}</span>
                <span className="cl-qty">× {l.qty}</span>
                <span className="cl-amt">{formatINR((BigInt(l.product.unitPaise) * BigInt(l.qty)).toString())}</span>
              </li>
            ))}
          </ul>
        )}
        <div className="cart-total-row">
          <span className="lbl">CART TOTAL · {cartLines.reduce((s, l) => s + l.qty, 0)} ITEMS</span>
          <span className="amt">{formatINR(totalPaise.toString())}</span>
        </div>
        <button className="btn primary block" disabled={busy || !effectiveId || cartLines.length === 0} onClick={attempt}>
          {busy ? 'Gate evaluating…' : 'Attempt Payment →'}
        </button>
        {error && (
          <p className="form-error" role="alert">✕ {error}</p>
        )}
        {verdict && (
          <VerdictCard verdict={verdict} />
        )}
      </div>
    </section>
  );
}

function VerdictCard({ verdict }: { verdict: GateVerdict }) {
  if (verdict.decision === 'ALLOWED') {
    return (
      <div className="verdict-card allowed">
        <div className="verdict-head">
          <span className="verdict-word">Allowed.</span>
          <span className="verdict-reason-code">OK</span>
        </div>
        <div className="verdict-meta">
          order <b>{verdict.orderId}</b> captured · {formatINR(verdict.amountPaise)} charged via Razorpay test mode
          <br />
          recorded at ledger seq <b>#{verdict.ledgerSeq}</b> — see Panel C
        </div>
      </div>
    );
  }
  return (
    <div className="verdict-card refused">
      <div className="verdict-head">
        <span className="verdict-word">Documented refusal.</span>
        <span className="verdict-reason-code">{verdict.reason}</span>
      </div>
      <div className="verdict-meta">
        {REASON_PROSE[verdict.reason] ?? 'The gate refused this attempt.'}
        <br />
        recorded at ledger seq <b>#{verdict.ledgerSeq}</b> — the evidence trail is preserved
      </div>
      <span className="refusal-stamp">REFUSED · {verdict.reason}</span>
    </div>
  );
}
