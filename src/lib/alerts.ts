import { getConfig, getConfigInt, getConfigNumber } from '@/config/env';
import type { StatusView } from '@/lib/api-types';

export interface Alert {
  id: 'error-rate' | 'p95-latency' | 'daily-cost' | 'guardrail-leak' | 'judge-score' | 'save-failures';
  firing: boolean;
  /** null when the value could not be computed (too few runs, or cost unknown). */
  value: number | null;
  threshold: number;
  owner: string;
  detail: string;
}

/**
 * S15. Alerts over the last 24 hours. Each has a threshold from configuration and an owner.
 * Rate alerts stay quiet below ALERT_MIN_RUNS so one failed run cannot page anyone.
 */
export function evaluateAlerts(w: StatusView['metrics']['last24h']): Alert[] {
  const owner = getConfig('ALERT_OWNER') || getConfig('OPS_EMAIL');
  const minRuns = getConfigInt('ALERT_MIN_RUNS');
  const enough = w.runs >= minRuns;
  const a = (id: Alert['id'], value: number | null, threshold: number, firing: boolean, detail: string): Alert => ({ id, firing, value, threshold, owner, detail });
  const errorRate = w.runs ? w.failedRuns / w.runs : null;
  return [
    a('error-rate', errorRate, getConfigNumber('ALERT_ERROR_RATE'), enough && errorRate !== null && errorRate > getConfigNumber('ALERT_ERROR_RATE'), `${w.failedRuns} of ${w.runs} runs failed${enough ? '' : ` (needs ${minRuns} runs)`}`),
    a('p95-latency', w.p95GenerateMs, getConfigInt('ALERT_P95_GENERATE_MS'), enough && w.p95GenerateMs !== null && w.p95GenerateMs > getConfigInt('ALERT_P95_GENERATE_MS'), 'p95 duration of the generate stage, in ms'),
    a('daily-cost', w.costUsd, getConfigNumber('ALERT_DAILY_COST_USD'), w.costUsd !== null && w.costUsd > getConfigNumber('ALERT_DAILY_COST_USD'), w.unpricedCalls ? `${w.unpricedCalls} model call(s) had no price, so the cost is a lower bound` : 'model cost in USD'),
    // any leak fires: there is no acceptable number
    a('guardrail-leak', w.guardrailLeaks, 0, w.guardrailLeaks > 0, 'runs where an output guardrail stripped or blocked a protected item'),
    a('judge-score', w.judgeMeanScore, getConfigNumber('ALERT_JUDGE_MIN_SCORE'), w.judgeMeanScore !== null && w.judgeMeanScore < getConfigNumber('ALERT_JUDGE_MIN_SCORE'), `mean live-judge score over ${w.judgedRuns} run(s)`),
    a('save-failures', w.saveFailures, getConfigInt('ALERT_SAVE_FAILURES'), w.saveFailures >= getConfigInt('ALERT_SAVE_FAILURES'), 'GitHub save failures'),
  ];
}

export function alertMail(firing: Alert[]): { subject: string; text: string } {
  return {
    subject: `Script Modernizer: ${firing.length} alert(s) firing`,
    text: `${firing.map((x) => `- ${x.id}: value ${x.value ?? 'unknown'}, threshold ${x.threshold}. ${x.detail}.`).join('\n')}\n\nOpen the Status view, then follow docs/runbooks/alerts.md.`,
  };
}
