# Workflow and agent patterns (S10)

Rule: use the simplest pattern that passes the evals. Every pattern has a recorded decision.

| Pattern | Decision | Reason | Where |
|---|---|---|---|
| Prompt chaining | **Used** | The stages are known in advance: generate, validate, repair, review. Code checks the output between every stage. | `src/pipeline/engine.ts` |
| Router | **Used, rules only** | Script type is decided by rules in `classify()`. No light model is called: the rules are cheap, deterministic and testable, and a model here would see the script before it is sanitized, which P7 forbids. An unsure router does not guess: it rejects with `INPUT_UNSUPPORTED_TYPE`, and the person can pick the type in the selector, which is the escalation path. A wrong content type (HTML, JSON, Python, binary) cannot be overridden by the selector. | `src/agents/orchestrator.ts` |
| Parallel calls | **Not used** | Units split from one script run one after another. The shell unit depends on the converted SQL units (their result is spliced in first), and SQL units in one script are few. Sequential runs keep the trace and the resumable state simple. Revisit if p95 latency of mixed scripts becomes a problem; cap concurrency and merge in source order if so. | `continueRun()` |
| Orchestrator | **Used, in code** | The split is mechanical (each `sqlplus` heredoc is one unit), so code does it. Agents never call each other. | `src/agents/orchestrator.ts` |
| Evaluator and optimizer | **Used** | The reviewer has its own system prompt and can only report codes. Repair stops when the set of error codes stops changing (`REPAIR_NO_PROGRESS`), when attempts run out, or when the run token budget is spent (`RUN_TOKEN_BUDGET_REACHED`). | `REVIEWER_SYSTEM`, `advanceUnit()` |
| ReAct agent (tool loop) | **Not used** | Every step is known in advance, so an autonomous loop adds risk and cost for no gain. | — |
| Handoff | **Used** | The converted SQL is passed as explicit state: it is spliced into the shell unit's source. The shell agent never sees the SQL agent's conversation. | `compose()` |
| Agent as a tool | **Not used** | The orchestrator always knows which specialist a unit needs, so nothing has to be decided by a model. | — |

## Tools, server tools and MCP

| Topic | Decision | Reason |
|---|---|---|
| S5 tool calling | **No tools in the conversion path** | The task is text in, text out. With no tools, the model cannot compose SQL, shell or URLs that run, which is the strongest way to keep P8. `tool_choice` is therefore never sent. A reply that asks for a tool is treated as unusable. |
| S6 web search | **Off everywhere** | Only sanitized text may leave the server, and a search query built from a script could leak its structure. Nothing in a conversion needs the web. |
| S6 web fetch | **Off everywhere** | Same reason; also a fetch target could be chosen by injected text. |
| S6 code execution | **Off everywhere** | P8: no user script is ever executed. Validation is static (parsers, `py_compile` compiles only). |
| S8 consuming MCP servers | **No** | No external system needs to be read during a conversion, and each server would be a new route for unsanitized data and injected instructions. |
| S8 exposing an MCP server | **Not now** | Recommendation: if DBAs later want this from an IDE, expose read-only tools first (`get_run`, `get_trace`, `list_issue_codes`). Never expose `approve`: approval must stay a separate, authenticated request by a person (S11). Reuse the existing bearer-token check and rate limit. |
