# Runbook: debugging a customer complaint (S16)

Use this when a DBA says a conversion is wrong. You need the **run ID**. It is shown in the
review panel ("Run ID run_...") and is in every log line and in the conversion's directory name.

## 1. Get the run ID

Ask the user for it. Without one, find the run in the Status view by time and script type.

## 2. Open the trace

```bash
curl -s -H "Authorization: Bearer $APP_ACCESS_TOKEN" "$APP_URL/api/runs/<runId>/trace"
```

Read, in this order:

| What | Where in the trace |
|---|---|
| Input guardrail summary | span `guardrail.input`: `app.sanitizer.replaced`, `app.sanitizer.warnings`, `app.sanitizer.version` |
| Router decision | same span: `app.router.decision`, `app.router.method` (`rules` or `user-selected`) |
| Retrieved IDs | span `retrieval`: `app.retrieved.rule_ids`, `app.retrieved.example_ids`, `app.retrieval.unavailable` |
| Prompt version and model | each `llm.*` span: `app.prompt.version`, `gen_ai.response.model` (a fallback model shows here), `app.effort` |
| Cost and latency | `totals`, and `ms` on each span |
| Scores | `scores.userRating`, `scores.judge` |

The trace holds no script text. For the text, use `GET /api/runs/<runId>` (sanitized source and drafts).

## 3. Walk the stages

`witness.stageCodes` (in the trace response, and in `witness.json` of a saved conversion) lists the error codes after generate and validate, after each repair, and after review, per unit. Look for:

- an error code that appears after a repair but not before: the repair made it worse;
- `REPAIR_NO_PROGRESS`, `REPAIR_FAILED_KEPT_DRAFT`, `RUN_TOKEN_BUDGET_REACHED`, `REVIEW_UNAVAILABLE`: the loop stopped early;
- a `REVIEW_*` error with attempts already used: the reviewer saw the problem and the draft was shown as failed;
- `error` status on an `llm.*` span: a failed attempt, with `error.type` and the provider status.

## 4. Replay offline and compare with the witness

For a saved conversion, check out its directory from the data branch. For an unsaved run, build the same directory by hand: `source.sanitized.sql` (or `.sh`) and the output files from `GET /api/runs/<runId>` (`sanitizedSource`, `drafts[].files`), and `witness.json` from the `witness` field of the trace response.

```bash
npm run verify-witness conversions/<date>-<runId>   # do the committed files still match their hashes and codes?
npm run replay conversions/<date>-<runId>           # run the pipeline again from the stored sanitized input
```

`replay` uses mocks for storage, GitHub, memory and mail, and the mock model unless you set `LLM_PROVIDER=anthropic` on purpose. It prints every difference from the witness, labelled by kind. Exit code 0 means identical, 2 means different.

## 5. Classify the cause

| Cause | Evidence |
|---|---|
| Input | The sanitized source itself is wrong or incomplete; `replay` reports an `input` difference; the user pasted a different script than they think. |
| Retrieval | A wrong or missing rule in `app.retrieved.rule_ids`; `MEMORY_UNAVAILABLE`; `replay` reports a `retrieval` difference. Disable a bad learned rule with `POST /api/rules/<id>/disable`. |
| Prompt | `replay` reports a `prompt` difference and the result changes with it; the complaint started after a prompt version change. |
| Model | Same input, prompt and validators, different output; a different `gen_ai.response.model` (fallback); `replay` reports a `model` difference. |
| Validator | The draft is wrong and no code flagged it, or a correct draft was flagged; `replay` reports a `validator` version difference. |
| Guardrail | A `guardrail.*` span with status `error` stripped something the script needed, or `SANITIZE_*` warnings point at the changed line. |
| Interface | The stored run is right but the page showed something else (wrong draft version, stale reload). |

## 6. Fix, and stop it coming back

1. Add the case to `evals/fixtures/` as a golden (a behaviour that must hold) or an adversarial fixture (an input that must be blocked), with seeded synthetic data only, and register it in `evals/fixtures/index.ts`.
2. Run `npm run eval`. The new fixture must fail before the fix.
3. Fix the cause. Never weaken a guardrail, validator or test to make it pass.
4. Run `npm test` and `npm run eval`; then `npm run eval -- --update-baseline` in the same commit.
5. Put the run ID in the commit message so the change is linked to the complaint.

## Worked example (the seeded case)

`tests/unit/operate.test.ts`, "finds the cause from the trace, reproduces it offline and classifies it", runs this runbook on a seeded complaint: *"my purge job used to commit every row; the converted one never commits."*

1. **Trace:** router decided `sqlplus`; rule `base-plsql-cursor-loop` was retrieved; the generate call has a prompt version and the answering model.
2. **Stages:** `validate: []`, then `review: [REVIEW_TXN_BOUNDARY_CHANGED]`. No code validator flagged the dropped `COMMIT`; the reviewer did. The run had no repair attempt left, so the draft was shown as failed.
3. **Replay:** no `input`, `prompt` or `validator` difference; a `model` difference; the replayed review is clean and the `SQL_COMMIT_IN_LOOP` warning is back.
4. **Cause:** model. The reviewer caught it and the draft was marked failed, so the guardrails worked; the run's repair budget was the limiting factor.

Run it: `npx vitest run tests/unit/operate.test.ts -t "seeded case"`.
