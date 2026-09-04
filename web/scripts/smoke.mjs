/**
 * smoke.mjs — drives the four demo moments through the mock API state machine
 * (mirrors what the panels do). Run: node scripts/smoke.mjs (from web/)
 */
import { createApi, formatINR } from '../src/api.ts';

const api = createApi('mock');
const fail = (msg) => {
  console.error('✗ ' + msg);
  process.exitCode = 1;
};
const ok = (msg) => console.log('✓ ' + msg);

// Moment 0: ledger seeds
let ledger = await api.listLedger();
if (ledger.length !== 4) fail(`seed ledger should have 4 entries, has ${ledger.length}`);
else ok('seed ledger: 4 entries');

// Moment 1: issue delegation
const art = await api.issueDelegation({
  principalName: 'Rukmini Desai',
  principalEmail: 'rukmini@example.in',
  agentId: 'agent-arjun',
  categories: ['coffee', 'pantry'],
  perTxnCapPaise: '80000',
  aggregateCapPaise: '250000',
  expiryMinutes: 30,
});
if (!art.artifactId.startsWith('prm_')) fail('artifact id not deterministic prefix prm_');
ok(`issued ${art.artifactId} · sig ${art.signature.slice(0, 24)}…`);

// Moment 2: in-scope purchase
let v = await api.attemptPayment({ artifactId: art.artifactId, cart: [{ sku: 'KC-COF-CHIK-250', qty: 1 }] });
if (v.decision !== 'ALLOWED' || v.reason !== 'OK' || !v.orderId) fail('in-scope purchase should be ALLOWED');
else ok(`allowed ${v.orderId} ${formatINR(v.amountPaise)} @ seq ${v.ledgerSeq}`);

// Moment 2b: category refusal (equipment not in scope)
v = await api.attemptPayment({ artifactId: art.artifactId, cart: [{ sku: 'KC-EQP-TAM-53', qty: 1 }] });
if (v.decision !== 'BLOCKED' || v.reason !== 'CATEGORY_NOT_IN_SCOPE') fail('equipment should be CATEGORY_NOT_IN_SCOPE');
else ok(`refused CATEGORY_NOT_IN_SCOPE @ seq ${v.ledgerSeq}`);

// Moment 3: cap-exceeded per txn (Chikmagalur ×2 = ₹1,040 > ₹800)
v = await api.attemptPayment({ artifactId: art.artifactId, cart: [{ sku: 'KC-COF-CHIK-250', qty: 2 }] });
if (v.decision !== 'BLOCKED' || v.reason !== 'CAP_EXCEEDED_PER_TXN') fail('expected CAP_EXCEEDED_PER_TXN');
else ok(`refused CAP_EXCEEDED_PER_TXN @ seq ${v.ledgerSeq}`);

// Aggregate cap: combos under the per-txn cap; spent so far ₹520 of ₹2,500
v = await api.attemptPayment({ artifactId: art.artifactId, cart: [{ sku: 'KC-COF-CHIK-250', qty: 1 }, { sku: 'KC-PAN-JAGR-350', qty: 1 }] });
if (v.decision !== 'ALLOWED') fail('combo A (₹705) should be allowed: ' + v.reason);
else ok(`allowed combo A ${formatINR(v.amountPaise)} @ seq ${v.ledgerSeq}`);
v = await api.attemptPayment({ artifactId: art.artifactId, cart: [{ sku: 'KC-COF-MALB-250', qty: 1 }, { sku: 'KC-COF-BRWD-100', qty: 1 }] });
if (v.decision !== 'ALLOWED') fail('combo B (₹790) should be allowed: ' + v.reason);
else ok(`allowed combo B ${formatINR(v.amountPaise)} @ seq ${v.ledgerSeq}`);
// spent ₹2,015 of ₹2,500; DECA ₹590 would make ₹2,605 → aggregate refusal
v = await api.attemptPayment({ artifactId: art.artifactId, cart: [{ sku: 'KC-COF-DECA-250', qty: 1 }] });
if (v.decision !== 'BLOCKED' || v.reason !== 'CAP_EXCEEDED_AGGREGATE') fail('expected CAP_EXCEEDED_AGGREGATE, got ' + v.reason);
else ok(`refused CAP_EXCEEDED_AGGREGATE @ seq ${v.ledgerSeq}`);

// Moment 4: dispute + evidence on the first allowed txn
ledger = await api.listLedger();
const allowedSeq = [...ledger].reverse().find((l) => l.type === 'ATTEMPT_ALLOWED' && l.amountPaise === '52000').seq;
const dsp = await api.openDispute({ ledgerSeq: allowedSeq, reason: 'UNAUTHORIZED_TRANSACTION' });
if (!dsp.disputeId.startsWith('dsp_')) fail('dispute id format');
ok(`dispute ${dsp.disputeId} opened on seq ${allowedSeq}`);
const pack = await api.generateEvidence({ ledgerSeq: allowedSeq });
if (!pack.html.includes('EXHIBIT A') || !pack.html.includes('sha256') || !pack.html.includes('Kadai')) fail('evidence pack missing exhibits');
else ok(`evidence pack ${pack.disputeId} · exhibits A–E · sha256 ${pack.sha256.slice(0, 12)}…`);

// Moment 5: fraud gate both ways
let fv = await api.runFraudGate({ flagId: 'flag_1', withArtifact: true });
if (fv.decision !== 'RELEASE' || fv.proof !== 'PRAMAAN_DELEGATION_PROOF') fail('fraud gate should RELEASE with artifact');
else ok(`released ${fv.orderId} on PRAMAAN_DELEGATION_PROOF @ seq ${fv.ledgerSeq}`);
fv = await api.runFraudGate({ flagId: 'flag_2', withArtifact: false });
if (fv.decision !== 'BLOCK' || fv.proof !== 'NO_VALID_DELEGATION') fail('fraud gate should BLOCK without artifact');
else ok(`blocked ${fv.orderId} NO_VALID_DELEGATION @ seq ${fv.ledgerSeq}`);

// Chain verification
const ver = await api.verifyChain();
if (!ver.valid) fail('chain should verify');
else ok(`chain verified · ${ver.checkedEntries} entries`);

// Ledger composition
ledger = await api.listLedger();
const types = ledger.map((l) => l.type);
const expect = ['ATTEMPT_BLOCKED', 'AGENT_RELEASED', 'EVIDENCE_GENERATED', 'DISPUTE_OPENED', 'ATTEMPT_BLOCKED', 'ATTEMPT_ALLOWED', 'ATTEMPT_ALLOWED', 'ATTEMPT_BLOCKED', 'ATTEMPT_BLOCKED', 'ATTEMPT_ALLOWED', 'DELEGATION_ISSUED', 'ATTEMPT_BLOCKED', 'ATTEMPT_ALLOWED', 'ATTEMPT_ALLOWED', 'DELEGATION_ISSUED'];
if (JSON.stringify(types) !== JSON.stringify(expect)) fail('ledger composition mismatch: ' + types.join(','));
else ok('ledger composition exact · newest-first, all action types landed');

console.log('\nSMOKE ' + (process.exitCode ? 'FAILED' : 'PASSED'));
