# Runbook: alerts (S15)

Alerts are evaluated over the last 24 hours, once a day by `/api/cron/cleanup` (which mails
the owner) and on every `GET /api/status` (the `alerts` array). The owner is `ALERT_OWNER`,
or `OPS_EMAIL` when that is unset. Rate alerts need at least `ALERT_MIN_RUNS` runs.

| Alert | Fires when | Variable | First thing to do |
|---|---|---|---|
| `error-rate` | failed runs / runs is above the threshold | `ALERT_ERROR_RATE` (0.2) | Status view, "failures by code". A provider code (429, 5xx, refusal) means the provider; a validator code means a prompt or model change. |
| `p95-latency` | p95 of the generate stage is above the threshold | `ALERT_P95_GENERATE_MS` (120000) | Check `llmLatency` and the retry rate. Timeouts show as `error.type: timeout` on `llm.*` spans. |
| `daily-cost` | model cost in USD is above the threshold | `ALERT_DAILY_COST_USD` (50) | `costByModel`, repair rate and cache hit rate. A fallback model or a low cache hit rate are the usual causes. If `unpricedCalls` is above zero the cost is a lower bound: add the model to `LLM_PRICES`. |
| `guardrail-leak` | any run where an output guardrail stripped or blocked a protected item | none: any leak fires | Open the run's trace, find the `guardrail.*` span with status `error`, and follow `docs/runbooks/complaint.md`. Add the case to the attack set. |
| `judge-score` | mean live-judge score is below the threshold | `ALERT_JUDGE_MIN_SCORE` (0.8) | `judge.failedCriteria` says which criterion. Read the evidence in `scores.judge` of the affected traces. The judge is not calibrated yet, so confirm by hand. |
| `save-failures` | GitHub save failures reach the threshold | `ALERT_SAVE_FAILURES` (1) | The run stays approved; use Retry in the application. Check the GitHub token and the data branch. |

Limits: alerts are daily, not real-time; there is no paging. Change this when volume justifies it (decision D17).
