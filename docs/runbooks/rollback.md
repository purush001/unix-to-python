# Runbook: rollback (S17)

**Status: written, not rehearsed.** Rehearse it once on a Preview deployment before relying on it.

## What can be rolled back

| Change | How | Notes |
|---|---|---|
| Application code, prompts, validators, guardrails | Vercel: Deployments, pick the last good deployment, "Promote to Production" (or `vercel rollback <deployment-url>`). | Instant; no build. Runs in progress continue from stored state: handlers are stateless. |
| A configuration value (model, effort, limits, prices) | Change the variable in Vercel and redeploy. | Model, effort and prompt versions are in every witness, so affected runs can be found. |
| A learned rule | `POST /api/rules/<id>/disable`, or the Status view. | Immediate; never needs a deployment. |
| Database schema | Migrations in `supabase/migrations/` are additive and run before the build. There are no down migrations. | Run records are JSON documents, and every field added in this change is optional, so older code reads newer records and newer code reads older ones. |

## Procedure

1. Decide: is it the deployment, a configuration value or a learned rule? The Status view (`failuresByCode`, alerts) and one trace usually answer this.
2. Roll back that one thing, as in the table.
3. Check `GET /api/health`, then convert one eval fixture and compare its codes with `evals/baseline.json`.
4. Open a complaint record and follow `docs/runbooks/complaint.md` so the cause gets a fixture.

## Before any release

`npm test`, `npm run eval` (no regression), `npm run build`, `npm run test:e2e`. CI runs all four.
