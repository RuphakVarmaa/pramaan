// risk-mock/engine.ts — deliberately tiny, legible mock risk engine (NO ML).
//
// Policy (readable in 20 seconds):
//   1. velocityPerMin > VELOCITY_PER_MIN_LIMIT  -> trigger
//   2. headless === true                        -> trigger
//   3. accountAgeDays < MIN_ACCOUNT_AGE_DAYS    -> trigger
//   score = number of triggered checks (0..3)
//   score >= BLOCK_SCORE_THRESHOLD -> BLOCK, else ALLOW
//
// This module is a STANDALONE mock: it has ZERO imports from src/ and zero
// third-party deps, so the batch swarm (and any judge) can reuse it directly.
// Deterministic: no randomness, no I/O, no clock reads.

/** Fire when transactions-per-minute exceeds this limit. */
export const VELOCITY_PER_MIN_LIMIT = 5;

/** Fire when the browser/agent context is headless. */
export const HEADLESS_TRIGGER = true;

/** Fire when the account is younger than this many days. */
export const MIN_ACCOUNT_AGE_DAYS = 30;

/** How many triggered checks are needed to BLOCK. */
export const BLOCK_SCORE_THRESHOLD = 2;

/** Input shape for evaluateRisk. Mirrors RiskSignals in src/types.ts,
 *  re-declared locally so this module stays standalone. */
export interface RiskSignalsInput {
  velocityPerMin: number;
  headless: boolean;
  accountAgeDays: number;
}

export interface RiskEvaluation {
  action: 'ALLOW' | 'BLOCK';
  score: number;
  triggered: string[];
}

/** Named trigger ids, stable for logs/tests. */
export const TRIGGERS = {
  VELOCITY: 'VELOCITY_PER_MIN_HIGH',
  HEADLESS: 'HEADLESS_BROWSER',
  NEW_ACCOUNT: 'ACCOUNT_TOO_NEW',
} as const;

export function evaluateRisk(signals: RiskSignalsInput): RiskEvaluation {
  const triggered: string[] = [];

  if (signals.velocityPerMin > VELOCITY_PER_MIN_LIMIT) {
    triggered.push(TRIGGERS.VELOCITY);
  }
  if (signals.headless === HEADLESS_TRIGGER) {
    triggered.push(TRIGGERS.HEADLESS);
  }
  if (signals.accountAgeDays < MIN_ACCOUNT_AGE_DAYS) {
    triggered.push(TRIGGERS.NEW_ACCOUNT);
  }

  const score = triggered.length;
  return {
    action: score >= BLOCK_SCORE_THRESHOLD ? 'BLOCK' : 'ALLOW',
    score,
    triggered,
  };
}
