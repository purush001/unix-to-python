# Phase 0: fact confirmation

Date: 2026-11-10. This file records how each row of `<facts>` in the build prompt was checked.

**How the facts were checked.** The coding agent did **not** fetch vendor documentation pages
in this session. Claude API rows were compared with the Claude API reference bundled with the
agent (cached 2026-11-03). Anything that reference does not state keeps the tag `VERIFY` and is
listed in [verify-register.md](verify-register.md). No real-provider call was made.

## Model provider: Claude API

| Fact | Result | Note |
|---|---|---|
| Primary model `claude-opus-5-5` | Confirmed | |
| 1M context, 128K output (synchronous) | Confirmed | |
| 300K output on Batches with `output-300k-2026-03-24` | VERIFY | Not in the reference. Not used by the code. |
| Price: input $4, output $20, cache read $0.20 | Confirmed | |
| Price: cache write $5 (5 min), $8 (1 hour) | VERIFY | The reference gives only "about 1.25x input" for a write, which matches $5. The 1-hour price is unconfirmed. |
| Batch API: 50% off | Confirmed | Not used by the code. |
| Thinking adaptive, always on; `disabled` and `budget_tokens` return 400 | Confirmed | The adapter sends `{"type":"adaptive"}`. |
| Effort: default `medium`, range `low` to `max` | Confirmed | Values are `low`, `medium`, `high`, `xhigh`, `max`. The application sets `high` explicitly. |
| `tool_choice` `any` and `tool` return 400 | Confirmed | The application sends no tools. |
| Structured outputs through `output_config.format`; `strict: true` on tools | Confirmed | Not used: see decision D7. |
| Refusal: HTTP 200, `stop_reason: "refusal"`, `stop_details` | Confirmed | |
| Refusals count against rate limits | VERIFY | Not in the reference. |
| Server-side fallback `fallbacks: "default"` | Confirmed | Needs the beta header `server-side-fallback-2026-07-01`. The prompt's fact table did not name the header; the code now reads it from `LLM_FALLBACK_BETA`. |
| Prompt caching minimum 512 tokens | VERIFY | The reference says the minimum is model-dependent, 512 to 4,096 tokens. Both agent system prompts are far longer than either bound; the reviewer and judge prompts may be below it. |
| Thinking blocks tied to model and conversation; append-only; select by `type` | Confirmed | The adapter appends only, and selects text blocks by type. |
| Other models: `claude-fable-5-2` $8/$40, `claude-sonnet-5-5` $2/$10, `claude-haiku-5-5` from $0.10/$0.50 | Confirmed | Not confirmed with `GET /v1/models` (needs a key). |
| Server tools `web_search_20260318`, `web_fetch_20260318` | **Differs: VERIFY** | The reference lists `web_search_20260209` and `web_fetch_20260209`. No server tool is used, so nothing depends on it. |
| Server tool `code_execution_20260521` | Confirmed | Not used (P8). |
| `advisor_20260301` with beta `advisor-tool-2026-03-01` | VERIFY | The reference describes the advisor tool but not this version string. |
| `stop_reason: "pause_turn"` on long server-tool turns | Confirmed | Handled by the adapter although no server tool is on. |
| MCP connector: `mcp_servers` + `mcp_toolset`, beta `mcp-client-2025-11-20` | Confirmed | Not used. |
| MCP connector not on Amazon Bedrock or Google Cloud | VERIFY | Not checked. |
| Rate limits per organisation and tier | VERIFY | Needs the Console. |

## Embeddings

| Fact | Result | Note |
|---|---|---|
| `voyage-code-4`, 32,000-token input limit, 1,024 dimensions | VERIFY | Not checked. The code sends the model name only; it neither sets nor enforces the dimension or the token limit. |
| Default base URL `https://ai.mongodb.com/v1` (in `src/config/env.ts`) | VERIFY | Found in the code, not in the prompt. Confirm it is the current Voyage endpoint. |

## Reference application limits

Each value was read from the code or `vercel.json` on this branch.

| Limit | Result | Where |
|---|---|---|
| 204,800 bytes, 5,000 lines | Confirmed | `MAX_INPUT_BYTES`, `MAX_INPUT_LINES` |
| `max_tokens` 32,000 generate and repair, 4,000 review; effort `high`; streaming; 60 s; SDK retries off | Confirmed, now configuration | `LLM_MAX_TOKENS`, `LLM_REVIEW_MAX_TOKENS`, `LLM_EFFORT`, `PROVIDER_TIMEOUT_MS` |
| 2 transient retries, base 400 ms; 2 repair attempts; separate counters | Confirmed, now configuration | `LLM_TRANSIENT_RETRIES`, `RETRY_BASE_MS`, `MAX_REPAIR_ATTEMPTS` |
| 240 s per request inside 300 s; approve and cleanup 60 s | Confirmed | `REQUEST_BUDGET_MS`, `vercel.json` |
| 20 per minute per token; other routes 10x | Confirmed | `RATE_LIMIT_PER_MINUTE`, `src/lib/http.ts` |
| Top 5 rules and 2 examples, platform and `promoted` filter | Confirmed, now configuration | `RETRIEVAL_TOP_RULES`, `RETRIEVAL_TOP_EXAMPLES` |
| Logs kept 14 days | Confirmed | `LOG_RETENTION_DAYS` |
| Region `iad1`; cron 03:17 and 04:47 UTC | Confirmed | `vercel.json` |

## Questions that would change the design

Asked once, here. Work continued on the stated assumption for each.

1. **Who approves?** S11 asks for a named person. The application has one shared access token, so it cannot say who approved. Assumption: left as is; needs an identity provider (decision D11).
2. **May sanitized real scripts be committed as eval samples?** Assumption: no. `evals/real-traffic/` is git-ignored except its README.
3. **May the real Claude API be called?** Assumption: no (accuracy rule). Nothing was run against a live provider.
