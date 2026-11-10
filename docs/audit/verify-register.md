# VERIFY register

Every unverified item, in one place, with how to confirm it. Format:
`VERIFY: <item> | how to confirm`. Updated 2026-11-10.

## Claude API

- VERIFY: the request shape sent by `src/providers/llm/real.ts` is accepted by the live API (adaptive thinking, `output_config.effort`, `betas` + `fallbacks: "default"`, cache-marked system block) | set `LLM_PROVIDER=anthropic` and a key in a non-production environment, convert one fixture, and check for HTTP 200. Tested so far only against stubbed HTTP (`tests/unit/real-providers.test.ts`).
- VERIFY: `server-side-fallback-2026-07-01` is still the beta header for `fallbacks: "default"` | Claude API docs, "Refusals and fallback". If it changed, set `LLM_FALLBACK_BETA`.
- VERIFY: refusals count against rate limits | Claude API docs, "Refusals and fallback" and "Rate limits".
- VERIFY: minimum cacheable prompt for `claude-opus-5-5` (512 tokens in the prompt; 512 to 4,096 in the agent's reference) | Claude API docs, "Prompt caching". Then check `cacheReadTokens` is above zero on the second of two conversions in the Status view.
- VERIFY: cache write price for 1-hour lifetime ($8 per million for Opus 5.5) | Claude pricing page. Used by `LLM_PRICES` when `LLM_CACHE_TTL=1h`.
- VERIFY: cache write and cache read prices for `claude-fable-5-2`, `claude-sonnet-5-5` and `claude-haiku-5-5` in the built-in `LLM_PRICES` table | Claude pricing page. Cache writes were derived as 1.25x (5 minutes) and 2x (1 hour) of the input price, and the Haiku cache read as 0.1x; only the Opus 5.5 row and the Fable and Sonnet cache-read prices come from a source.
- VERIFY: Haiku 5.5 price above 100K-token prompts ($0.50 / $2.50) is not modelled in `src/lib/cost.ts` | pricing page; only matters if a Haiku model is configured.
- VERIFY: 300K output on the Message Batches API with `output-300k-2026-03-24` | Claude API docs, "Batch processing". Not used.
- VERIFY: server tool versions (`web_search_20260318` and `web_fetch_20260318` in the prompt; `web_search_20260209` and `web_fetch_20260209` in the agent's reference) | Claude API docs, "Web search tool" and "Web fetch tool". Not used.
- VERIFY: `advisor_20260301` and beta `advisor-tool-2026-03-01` | Claude API docs, "Advisor tool". Not used.
- VERIFY: MCP connector availability on Amazon Bedrock and Google Cloud | Claude API docs, platform availability. Not used.
- VERIFY: model IDs `claude-fable-5-2`, `claude-sonnet-5-5`, `claude-haiku-5-5` | `GET /v1/models` with a key.
- VERIFY: organisation rate limits | Claude Console, and the `anthropic-ratelimit-*` response headers.
- VERIFY: the effort level. `high` is configured; the model's default is `medium` | run `EVAL_REAL_PROVIDER=1 LLM_EFFORT=<level> npm run eval` for `low`, `medium` and `high` and compare (the effort sweep S14 asks for). Not run.

## Observability

- VERIFY: OpenTelemetry GenAI attribute names used in `src/lib/trace.ts` (`gen_ai.operation.name`, `gen_ai.request.model`, `gen_ai.response.model`, `gen_ai.request.max_tokens`, `gen_ai.response.finish_reasons`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.usage.cache_read.input_tokens`, `gen_ai.usage.cache_creation.input_tokens`) | OpenTelemetry semantic conventions for generative AI, current version. Also confirm whether `gen_ai.usage.input_tokens` should include cached tokens (it does here).
- VERIFY: the two Vercel cron jobs run, and the daily alert mail arrives | Vercel dashboard, Cron Jobs, after a production deployment; then `/api/status`.

Confirmed since the first draft of this register: the CI workflow `.github/workflows/ci.yml` ran on GitHub and passed (run 1, commit `7967bbd`).

## Embeddings and other providers

- VERIFY: `voyage-code-4`, 32,000-token input limit, 1,024 dimensions | Voyage documentation.
- VERIFY: embeddings base URL `https://ai.mongodb.com/v1` | Voyage documentation.
- VERIFY: real GitHub, Chroma, Voyage and SMTP providers against live services | set each `*_PROVIDER` in a non-production environment and run one approval.
- VERIFY: Vercel limits and names in the README "Vercel deployment" section | Vercel documentation (already flagged in the README).

## Evals

- VERIFY: the judge agrees with people | add at least 30 human-labelled cases to `evals/judge/labels.json`, then `EVAL_REAL_PROVIDER=1 npm run eval:calibrate -- --write`. Today: 0 cases, status "not calibrated".
- VERIFY: guardrail false-positive rate | put sanitized genuine scripts in `evals/real-traffic/`, then `npm run eval`. Today: no samples, rate not measured.
- VERIFY: eval results on the real model | `EVAL_REAL_PROVIDER=1 LLM_PROVIDER=anthropic npm run eval -- --update-baseline`. The committed baseline covers the mock provider only.

## Operations

- VERIFY: the rollback procedure works | rehearse `docs/runbooks/rollback.md` on a preview deployment. Not rehearsed.
- VERIFY: key rotation works without downtime | rehearse `docs/runbooks/key-rotation.md` with a non-production key.
