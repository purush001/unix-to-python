# Release readiness (Phase 5)

Date: 2026-11-10. Branch `claude/optimistic-newton-5wgu9a`. Everything below ran on **mock
providers**. No real-provider call was made and production was not touched.

**Verdict: not ready for production on the real model.** Ready to continue on mocks and in a
non-production environment. The blocking items are listed at the end.

## Acceptance list

| # | Line | Result | Evidence |
|---|---|---|---|
| 1 | Install and run succeed with no keys, on mocks | **True** | `npm ci` completed; `npm run build` listed all 12 API routes; the browser test starts the built server with only `APP_ACCESS_TOKEN` set |
| 2 | Static secret check, unit tests, browser test and eval suite pass | **True** | See "Commands and summary lines" |
| 3 | Every hard gate passes and no metric is below the baseline | **True on the mock provider** | `hard gates: zeroLeaks=PASS zeroSecrets=PASS allSyntaxOk=PASS zeroDualCompatHits=PASS zeroInventedRuleIds=PASS`; `baseline: no regression against evals/baseline.json` |
| 4 | The attack suite and the real-traffic sample both have reported rates | **Half true** | Attack: `11/11 blocked (block rate 100%)`. Real traffic: `no samples ... (false-positive rate not measured)` |
| 5 | One complaint has been debugged end to end with the runbook | **True, on a seeded case** | `tests/unit/operate.test.ts`, "finds the cause from the trace, reproduces it offline and classifies it"; written up in `docs/runbooks/complaint.md` |
| 6 | A trace for one run shows every span with tokens, cost and latency | **True** | `tests/unit/trace.test.ts`, "one run has a span for each stage, model call, retrieval and guardrail, with tokens, cost and latency"; served by `GET /api/runs/:id/trace` |
| 7 | Every pattern in S10 has a recorded decision | **True** | `docs/design/patterns.md` |
| 8 | Every `VERIFY` tag is listed in one register with how to confirm it | **True** | `docs/audit/verify-register.md` |
| 9 | The README section "Known limits and unverified items" is current | **True** | Updated in this change |

## Commands and summary lines

```
$ npm test
Secret-handling check passed.
 Test Files  13 passed (13)
      Tests  130 passed (130)

$ npm run eval
Eval (mock provider): 21/21 fixtures passed
  validator pass rate 100%   repair rate 0%   transient retries 0
  hard gates: zeroLeaks=PASS  zeroSecrets=PASS  allSyntaxOk=PASS  zeroDualCompatHits=PASS  zeroInventedRuleIds=PASS
  attack suite: 11/11 blocked (block rate 100%)
  real-traffic sample: no samples in evals/real-traffic (false-positive rate not measured)
  judge (mock, prompt ae90d258d328): mean score 1 over 5 of 13 judged drafts; 73 criteria answered "unknown"; failed criteria {}
  baseline: no regression against evals/baseline.json

$ npm run eval:calibrate
  status: not calibrated: 0 of 30 human-labelled cases

$ npm run typecheck          (no output: passed)
$ npm run build              (passed; 12 API routes)
$ npm run test:e2e
  1 passed
```

CI on GitHub: workflow `ci`, run 1, on commit `7967bbd`, concluded `success`
(https://github.com/purush001/unix-to-python/actions/runs/42901137663).

**Read the judge line with care.** The mock judge can decide one criterion (F2, transaction
boundaries) for SQL and answers "unknown" for the rest. "Mean score 1" therefore means: for 5
SQL drafts, the count of COMMIT and ROLLBACK statements matched. It says nothing about the
other criteria or about shell conversions.

## What the new evals found

Adding the attack cases exposed two real defects, both fixed in code, not by changing a test:

1. The classifier accepted HTML, JSON, PDF and Python text as SQL when they contained SQL words.
2. The sanitizer missed an e-mail address or host name hidden by percent-encoding or full-width characters, and left text split by zero-width characters.

## Blocking items before production on the real model

1. **Real provider never exercised.** The request shape is tested against stubbed HTTP only.
2. **Judge not calibrated** (0 of 30 human labels), so faithfulness on the real model is unmeasured.
3. **False-positive rate not measured** (no real-traffic samples).
4. **No named approver** (S11): one shared access token.
5. **Rollback and key rotation not rehearsed.**
6. **No effort sweep**; `high` is an assumption (D10).

## Non-blocking gaps

Retrieval recall at k (S9); no external tracing backend; daily alerts; the Status page does not show the new metrics; Batch API not used for evals; values hidden by base64, hex or a cipher are not found by the sanitizer.

Full list of unverified items: `docs/audit/verify-register.md` (25 items).
