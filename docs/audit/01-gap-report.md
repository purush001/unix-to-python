# Gap report: standards S1 to S17

Date: 2026-11-10. Branch `claude/optimistic-newton-5wgu9a`. Mode `audit-and-upgrade`.
"Before" is the state found by the audit; "Now" is the state after this change.
Scores: **meets**, **partial**, **missing**.

| Std | Before | Now | Evidence | What is still open |
|---|---|---|---|---|
| S1 Setup | meets | meets | `npm ci`, `npm run dev` on mocks; six providers with `mock.ts` and `real.ts` in `src/providers/`; exact versions in `package.json`; `package-lock.json`; `.env.example` now lists every variable `src/config/env.ts` reads | Node is pinned to the major (`22.x`), which is what Vercel accepts |
| S2 Secrets | partial | meets | `src/config/env.ts`; `scripts/check-secrets.ts` in `test` and `build`; `docs/runbooks/key-rotation.md` | Spend limits and rotation are console actions; not rehearsed |
| S3 LLM adapter | partial | meets | `src/providers/llm/real.ts`: model, effort, caps, cache lifetime and fallback beta from configuration; cache-marked system block; cache tokens returned; `pause_turn` resumed; `tool_use`, `max_tokens`, `refusal` and unknown stop reasons explicit; `tests/unit/real-providers.test.ts` (7 tests) | Tested against stubbed HTTP only. Batch API not used for evals |
| S4 System prompts | partial | meets | `src/agents/prompts.ts`; `tests/unit/prompts-contract.test.ts` checks `HONESTY_RULE`, the data guard and the fixed order in all five prompts | — |
| S5 Tools | decision not recorded | meets | `docs/design/patterns.md`: no tools; adapter test asserts no `tools` or `tool_choice` is sent | — |
| S6 Server tools | not addressed | meets | `docs/design/patterns.md`: all off, with reasons | — |
| S7 Structured outputs | partial | meets | `src/agents/format.ts` zod schemas; malformed is transient; closed code set | `output_config.format` deliberately not used (D7) |
| S8 MCP | not addressed | meets | `docs/design/patterns.md`: not consumed, not exposed, with a recommendation | — |
| S9 RAG | partial | partial | Top-k now configuration (`RETRIEVAL_TOP_*`); retrieved IDs in the trace span and witness | **No labelled retrieval set and no recall-at-k measurement** |
| S10 Patterns | no record | meets | `docs/design/patterns.md`: all eight patterns | Router has no light-model branch, by decision |
| S11 Human in the loop | partial | partial | Unchanged flow; run ID now shown in the review panel | **No named approver** (D11): needs an identity provider |
| S12 Harness | partial | meets | Token budget (`MAX_RUN_TOKENS`); witness has models, prompt versions and effort; `npm run replay`; `tests/unit/trace.test.ts`, `operate.test.ts` | — |
| S13 Guardrails | partial | partial | 11 attack fixtures; classifier and sanitizer fixes they forced; HTTP 415; block rate reported (11 of 11 on the mock) | **False-positive rate not measured**: no real-traffic samples. Values hidden by base64, hex or a cipher are not found |
| S14 Evals | partial | partial | `evals/baseline.json` and regression gate; rule-ID gate; judge with rubric and structured verdict; calibration harness; `.github/workflows/ci.yml` (first run passed) | **Judge not calibrated** (0 of 30 labels). Nothing run on the real model; no effort sweep. A brand-new identifier is checked only by the judge |
| S15 Observability | partial | partial | Spans for every stage, model call, retrieval and guardrail (`src/lib/trace.ts`); cost (`src/lib/cost.ts`); `GET /api/runs/:id/trace`; dashboard metrics and six alerts in `/api/status`; live judge in the cron job; `docs/dashboards/status-dashboard.json` | No external tracing backend (D13). Alerts are daily (D17). The Status page in the browser does not show the new metrics yet; they are in the API |
| S16 Complaint runbook | missing | meets | `docs/runbooks/complaint.md`; seeded case in `tests/unit/operate.test.ts` | — |
| S17 Production readiness | mostly meets | partial | `docs/runbooks/rollback.md`; uniform errors; health endpoint; README "Known limits" updated | **Rollback not rehearsed** |

## Architecture differences that remain

- **Router:** rules only; an unsure input is rejected, not escalated to a model (decision in `patterns.md`).
- **Parallel units:** sequential, by decision.
- **Run states:** a run is first stored as `sanitized`; `received` exists in the type but is never persisted, because nothing is stored before sanitizing (P7).
- **Traces:** kept in the run record and served by the API, not sent to a tracing product.

## Ordered plan for what is open

1. Decide on identity for approvals (S11). Owner decision.
2. Run one real-provider conversion in a non-production environment, then the eval suite and an effort sweep (S3, S14).
3. Label 30 judge cases and calibrate (S14).
4. Add sanitized real scripts and measure false positives (S13).
5. Rehearse rollback and key rotation (S17, S2).
6. Add a labelled retrieval set and recall at k (S9).
7. Show cost, alerts and judge scores in the Status page (S15).
