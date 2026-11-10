# Script Modernizer

**SQL and Shell ==> SQL and Python**

A single-tenant internal web app for DBAs. Paste a legacy Oracle 19c SQL, PL/SQL, SQL\*Plus or
ksh/bash script; receive a sanitized, reviewed, faster equivalent:

- **SQL and PL/SQL that run unchanged on both Oracle Database 19c and Oracle AI Database 26ai.**
- **Python 3.11+** (python-oracledb, paramiko, standard library) in place of the shell.

Flow: paste → convert → **draft** review → approve or request changes → save to GitHub → rate.
Nothing is final until a person approves it. No user script is ever executed, and no database,
server or mail system is contacted on the user's behalf: all validation is static.

> **Status of this build.** Everything runs and is tested on mock providers. The real providers
> (Anthropic, GitHub, Supabase, Chroma, Voyage, SMTP) are implemented but, apart from the Postgres
> storage (tested against a local PostgreSQL 16), have **not** been exercised against live services.
> See [Known limits and unverified items](#known-limits-and-unverified-items).

---

## Quick start (mocks, no keys)

```bash
npm ci
cp .env.example .env.local      # set APP_ACCESS_TOKEN to any long string
npm run dev                     # http://localhost:3000
```

Enter the access token in the page, paste a script (or use *Load example*) and press **Convert**.

| Command | What it does |
|---|---|
| `npm run dev` | Development server |
| `npm run build && npm start` | Production build and server |
| `npm test` | Static secret-handling check, then the unit tests (Vitest) |
| `npm run test:e2e` | Browser flow against the mocks (Playwright) |
| `npm run typecheck` | TypeScript check |
| `npm run eval` | Eval suite; writes `eval-report.json`; exits non-zero if a hard gate fails, a fixture fails, or a metric is below `evals/baseline.json` |
| `npm run eval -- --update-baseline` | Rewrites the committed baseline (refused while anything fails) |
| `npm run eval:calibrate` | Judge agreement with the human labels in `evals/judge/labels.json` |
| `npm run replay <dir>` | Replays a committed conversion offline from its sanitized input and lists every difference from `witness.json` |
| `npm run verify-witness <dir>` | Re-runs the validators on a committed conversion and compares with `witness.json` |
| `npm run reindex-memory` | Rebuilds the Chroma collections from Supabase |
| `npm run db:migrate` | Applies `supabase/migrations/*.sql` |
| `npm run check-secrets` | The static secret-handling check on its own |
| `npm run audit` | `npm audit` (part of verification) |

## How it works

```
browser ──► /api/convert ──► orchestrator
                               │ intake: size limit → classify → SANITIZE → split into units
                               ▼
                    pipeline engine (one implementation)
        generate → validate → repair → review → per-script results
                               │
              adapters supply prompts, validators, repair hints
              ┌────────────────┴────────────────┐
        src/adapters/plsql               src/adapters/shell-python
           (sql-agent)                        (shell-agent)
```

- **Agents** (`src/agents/`): `sql-agent`, `shell-agent`, `orchestrator`. Agents never call each
  other. A mixed script is split: each `sqlplus` heredoc goes to the sql-agent first, the converted
  SQL is spliced back, then the shell-agent converts the whole script.
- **Pipeline** (`src/pipeline/engine.ts`): transient provider failures (malformed or empty output,
  HTTP 5xx, timeout, network) are retried twice with backoff and jitter and never consume a repair
  attempt. A refusal is never retried. Two repair attempts by default. A run also has a token
  budget (`MAX_RUN_TOKENS`); when it is spent no further model call starts
  (`RUN_TOKEN_BUDGET_REACHED`). Repair stops early when the set of error **codes** is
  unchanged (`REPAIR_NO_PROGRESS`). If a repair call fails, the last usable draft is kept
  (`REPAIR_FAILED_KEPT_DRAFT`). If nothing could be drafted, the provider error is returned with its
  real HTTP status. Run state is saved after every stage; a request that runs out of time returns
  `resumable: true` and `POST /api/runs/:id/resume` continues from the next stage.
- **Run states:** `received → sanitized → drafting → draft_ready → changes_requested → approved → saved`, plus `failed`.

### Repository layout

```
src/pipeline/               engine, issue codes, types, construct tagging
src/adapters/plsql/         tokenizer, splitter, block analysis, dual-compat rules, validators, prompts
src/adapters/shell-python/  shell parser, WASM Python parser, validators, the standard Python runtime, prompts
src/agents/                 sql-agent, shell-agent, orchestrator, reply format, shared prompt parts (HONESTY_RULE)
src/judge/                  LLM-as-judge (rubric, verdict schema) and the live judge used by the cron job
src/sanitizer/              secrets, hosts and users, names and emails, personal values, scans
src/providers/              llm, github, smtp, storage (Supabase), memory (Chroma), embeddings — each mock + real
src/learning/               memory retrieval and the propose → verify → improve loop
src/app/                    the page and one route handler per API endpoint
src/config/env.ts           the only module that reads process.env (getSecret / getConfig)
skills/base/                hand-written rules (learned rules live in the database)
evals/fixtures/, evals/     golden and adversarial fixtures, suite and runner
supabase/migrations/        schema with Row Level Security
scripts/                    check-secrets, verify-witness, replay, reindex-memory, migrate, vercel-ignore-build
docs/                       audit (facts, gap report, VERIFY register), design decisions, evals, runbooks, release readiness
.github/workflows/ci.yml    typecheck, tests, evals against the baseline, build and browser flow, all on mocks
vercel.json                 function durations, cron schedules, data-branch rules, region
```

## The 19c and 26ai dual-compatibility rule

Every converted statement and PL/SQL unit must compile and behave the same on **any 19c release
update** and on **26ai**, from one source file, with no edits in between.

- Allowed syntax is the **intersection** of the two releases. Features that exist only in 26ai, or
  that were back-ported to 19c only in a later release update, are rejected by the validator with
  `SQL_NOT_DUAL_COMPATIBLE` (error) and rewritten by the repair step. Examples: `IF [NOT] EXISTS` in
  DDL (26ai; 19c only from RU 19.28), `SELECT` without `FROM DUAL`, `UPDATE`/`DELETE … FROM` joins,
  `GROUP BY` on a column alias, `GROUP BY ALL`, `QUALIFY`, multi-row `VALUES`, the SQL `BOOLEAN`,
  `VECTOR` and `JSON` data types, SQL macros (19.7), blockchain and immutable tables (19.10/19.11),
  `EXCEPT`, schema-level grants, annotations, and functions such as `ANY_VALUE`, `JSON_TRANSFORM`,
  `BIT_AND_AGG`, `CHECKSUM`, `UUID`, `DATEADD`.
- Features **desupported in 26ai** are `SQL_DESUPPORTED_FEATURE` (error) and must be replaced by a
  form that works on both, for example traditional `AUDIT`/`NOAUDIT` statements → unified audit
  policies, `DBMS_OBFUSCATION_TOOLKIT` → `DBMS_CRYPTO`, `UTL_FILE_DIR` → directory objects,
  `DBMS_XSLPROCESSOR.CLOB2FILE` → `DBMS_LOB.CLOB2FILE`. Deprecated features are
  `SQL_DEPRECATED_FEATURE` (warning), for example `DBMS_JOB` (still supported; jobs run as
  `DBMS_SCHEDULER` jobs and need `CREATE JOB`).
- Where PL/SQL has no single common form: conditional compilation on
  `DBMS_DB_VERSION` (`$IF DBMS_DB_VERSION.VER_LE_19 $THEN … $ELSE … $END`; `VER_LE_19` exists and is
  `TRUE` on 19c — higher `VER_LE_nn` constants do not exist in 19c and must never be referenced
  unguarded). Where plain SQL has none: the 19c form is kept and `SQL_NO_COMMON_FORM` asks the
  reviewer to decide.
- 26ai-only improvements appear in the report under **"After 19c is retired"** as suggestions and are
  never applied. PeopleTools 8.62 certification of any 26ai feature is **unknown**: check My Oracle
  Support first; the report says so.
- **Error capture** (works on both releases): the outermost block of every owned PL/SQL unit records
  `SQLCODE`, `DBMS_UTILITY.FORMAT_ERROR_STACK` and `DBMS_UTILITY.FORMAT_ERROR_BACKTRACE` in its
  `WHEN OTHERS` handler, writes one line `ERROR|unit=…|line=…|code=…|message=…` through `DBMS_OUTPUT`,
  then re-raises with `RAISE`. Handlers that already swallowed errors keep doing so
  (`SQL_ERROR_SWALLOWED`). SQL\*Plus scripts get `SET SERVEROUTPUT ON` before the first statement.

The rule tables are in `src/adapters/plsql/compat.ts`, matched on parsed tokens (including SQL
inside `EXECUTE IMMEDIATE` strings). Sources read for this build: the 26ai Upgrade Guide chapter
"Oracle Database Changes, Desupports, and Deprecations", the 26ai New Features guide, the 21c SQL
Language Reference change list, the 19c New Features release-update pages, and the
`DBMS_DB_VERSION` and `DBMS_UTILITY` pages of the PL/SQL Packages and Types Reference for both
releases. Two points could **not** be confirmed in the documentation and are flagged in code:
the exact `DBMS_DB_VERSION.VERSION` value 26ai reports (its page still shows the 21c package), and
that a re-raise resets the error backtrace (the capture therefore always happens first).

## Sanitization

A deterministic sanitizer runs before any provider call and again on every output before it is
shown, stored or committed. Only sanitized text reaches the provider, the logs, storage, Chroma,
the embedding provider or GitHub. If the sanitizer or a scan fails, the run stops (fail closed).

| What | Replaced with |
|---|---|
| Email addresses | `ops@script.com` |
| Person names (header comments, change-log lines, mail display names, dotted email local parts, home directories, optional deny-list) | `dev1`, `dev2`, … in order of first appearance; one placeholder per person per run |
| Hosts, FQDNs, IP addresses (commands, EZConnect, TNS, JDBC, URLs, mounts) | `source_server` (runs on / reads from) or `target_server` (pushes to / runs remote commands on); `_2`, `_3` for more; ambiguous → `target_server` + `SANITIZE_HOST_ROLE_AMBIGUOUS` and a highlighted line |
| Remote users in ssh, scp, sftp, ftp, rsync | `source_user` / `target_user` |
| Passwords, tokens, keys, passphrases (including `sqlplus user/pw@db` and passwords read from files) | an environment or config reference such as `${DB_PASSWORD}` or `&&db_password` |
| Personal values in literals (employee, operator and national IDs, names, dates of birth, phones, addresses) | synthetic values of the same type, e.g. `'EMPLID_1'`, `DATE '1900-01-01'` |
| Encoding tricks: invisible characters (zero-width, bidirectional controls); an e-mail address hidden by `%40` or full-width characters; a host name with `%2E` dots | invisible characters are removed; the hidden address or host is decoded, then replaced as above; warning `SANITIZE_OBFUSCATION_NORMALIZED` |

Database schema names (`SYSADM`), identifiers, column and record names are never changed. The user
sees a count summary only ("3 emails, 2 hosts, 1 user, 1 password replaced"); the mapping lives in
memory for the sanitizing request and is discarded.

**Deny-list.** Set `DENYLIST_PATH` to a server-side file with one name or term per line. Never commit it.

**Limits of a deterministic sanitizer.** A value hidden by base64, hex or a cipher is not found;
the script is never decoded as a whole, because that would change legitimate text such as
`date +%Y%m%d`. Names are found by context. A name that appears only in
free text with no cue (no header keyword, change-log shape, email or home directory) is not found
unless it is on the deny-list. A bare user ID cannot be tied to a full name, so `jsmith` and
`John Smith` get different placeholders unless a `j.smith`/`jsmith` spelling can be derived.

## Standard for generated Python

Every generated script uses the same runtime, delivered as **one shared file, `script_runtime.py`**,
next to the script (`src/adapters/shell-python/runtime.ts` holds its text). The script itself is
short: a docstring, its imports, `parse_args`, `job`, and a three-line `main` that calls
`run_main(job, parse_args, argv)`. For the eval fixtures that is 50 to 110 lines, where the earlier
self-contained form was 340 to 520. Deploy `script_runtime.py` in the same directory as the scripts;
it is identical for every conversion, is written by the application and never by the model, and
loads without `oracledb` or `paramiko` unless a script uses the database or SSH helpers.

What the runtime provides:

- Module docstring (purpose, origin, arguments, exit codes, original schedule); `main()` returns the
  exit code; ends with `if __name__ == "__main__": sys.exit(main())`.
- **Error email:** any unhandled exception, and any handled failure with a non-zero exit code, mails
  `ops@script.com` (subject: script name, `FAILED`, failing line, run ID; body: the error record,
  traceback, last 50 log lines, host, start and end time). If the mail fails, that is logged and the
  exit code is unchanged.
- **Logs:** `RotatingFileHandler` (10 MB × 5) plus console; format `timestamp level runId file:line message`.
- **Error capture:** one central handler builds an error record (type, message, file, function, the
  deepest line inside the script, traceback). Database errors add the Oracle code and message, the
  offset converted to a line within the statement, and a statement label — never bind values.
  `DBMS_OUTPUT` is enabled and read after a failure so the PL/SQL capture line is included. External
  commands add the command name, exit code and the last lines of stderr.
- No `shell=True`, `os.system` or `eval`; SSH host-key checking stays on (`RejectPolicy`).

### Config file convention

A `config.ini.template` is generated when the script needs a host, user or password, or when
"Generate config file" is ticked. Sections: `[source]`, `[target]`, `[database]`, `[smtp]`,
`[logging]` (plus `[target_2]` … when a script has several hosts). All values are placeholders
(`source_server`, `source_user`, `CHANGE_ME`). The script reads the path from `--config` or the
`SCRIPT_CONFIG` environment variable, and reads each password from an environment variable first
(`DB_PASSWORD`, `SOURCE_PASSWORD`, `TARGET_PASSWORD`), then from the file. Set `chmod 600`, keep
`config.ini` out of version control (it is in `.gitignore`; commit only `config.ini.template`), and
prefer Oracle Wallet or a secrets manager in production.

## API

Every route is a stateless Node.js route handler (`src/app/api/**/route.ts`) and so its own Vercel
function: authenticate → validate (zod) → load state from storage → work → save → respond.

| Route | Purpose |
|---|---|
| `POST /api/convert` `{ source, scriptType?, options: { generateConfig } }` | Run result with the draft |
| `POST /api/runs/:id/revise` `{ note }` | New draft using the reviewer's note |
| `POST /api/runs/:id/resume` | Continue a cut-off run (addition to the spec) |
| `POST /api/runs/:id/edit` `{ file, content, note? }` | Save a hand edit of the latest draft as a new draft version. It passes the output guardrails and the code validators; no model is called |
| `POST /api/runs/:id/dismiss` `{ version, kind, index, dismissed }` | Remove a change-list item or a warning from view, or restore it. Nothing is deleted; an error cannot be removed |
| `POST /api/runs/:id/approve` | Mark final, save to GitHub; call again to retry a failed save |
| `POST /api/runs/:id/feedback` `{ rating?, comment?, errorCode?, line? }` | Rating or problem report |
| `GET /api/runs/:id` | Stored state (page recovery) |
| `GET /api/runs/:id/trace` | The run's trace: every span with tokens, cost and latency, the witness, and the attached scores. No script text |
| `GET /api/status` | Recent runs, dashboard metrics, alerts, learned rules with witnesses |
| `POST /api/rules/:id/disable` | A human disables a learned rule (addition to the spec) |
| `GET /api/health` | Which providers are mock or real; no configuration values |
| `GET /api/cron/learn`, `GET /api/cron/cleanup` | Vercel Cron only; reject requests without `CRON_SECRET` |

All routes except `/api/health` and the cron routes need `Authorization: Bearer <APP_ACCESS_TOKEN>`.
`convert`, `revise` and `resume` stream stage progress as NDJSON when the request sends
`Accept: application/x-ndjson`. Headers are held back until the first unit has been drafted, so a
provider failure before any draft still returns its real status. Errors:
`{ "error": { "code", "message", "status", "runId?" } }` — 400 bad input, 401 missing token,
413 oversize, 415 body not sent as `application/json`, 422 unsupported type, 429 rate limit, and the
provider's own status (a model refusal is 422).

## Switching from mocks to real providers

Each provider is chosen by one variable; anything not set stays on its mock.

| Provider | Variable | Real value | Also needs |
|---|---|---|---|
| Model | `LLM_PROVIDER` | `anthropic` | `ANTHROPIC_API_KEY`, optional `LLM_MODEL` (default `claude-opus-5-5`) |
| GitHub | `GITHUB_PROVIDER` | `github` | `GITHUB_TOKEN`, `GITHUB_REPO`, `GITHUB_DATA_BRANCH` |
| Storage | `STORAGE_PROVIDER` | `supabase` | `POSTGRES_URL` |
| Skill memory | `MEMORY_PROVIDER` | `chroma` | `CHROMA_API_KEY`, `CHROMA_TENANT`, `CHROMA_DATABASE` |
| Embeddings | `EMBEDDINGS_PROVIDER` | `voyage` | `VOYAGE_API_KEY`, optional `EMBEDDINGS_MODEL`, `EMBEDDINGS_BASE_URL` |
| SMTP | `SMTP_PROVIDER` | `smtp` | `SMTP_HOST`, `SMTP_PORT`, `SMTP_FROM`, optional `SMTP_USER`, `SMTP_PASSWORD` |

The model provider uses the official Anthropic SDK with adaptive thinking, streaming, prompt
caching of the system prompt, and server-side refusal fallbacks (`fallbacks: "default"`). Effort,
token caps, retries, cache lifetime and the fallback beta header are configuration (`LLM_*` in
`.env.example`), never literals. The default provider timeout is 60 seconds per call; raise
`PROVIDER_TIMEOUT_MS` for very large scripts. Before the first real call, read
`docs/audit/verify-register.md`: the request shape has only been tested against stubbed HTTP.

**Prompts.** Every system prompt (two agents, reviewer, rule writer, judge) is built in
`src/agents/prompts.ts` in a fixed order and carries the same `HONESTY_RULE` constant. Each has a
version hash that is written to every trace, log line and witness. When a model cannot comply it
says so with a structured "unknown" signal (`CONVERT_UNKNOWN`, `REVIEW_UNKNOWN`) and does not guess.

**The mock model is a deterministic converter, not a language model.** It applies the mechanical
rules (error capture, `SERVEROUTPUT`, shell-to-Python mapping for common wrapper constructs) and
marks what it cannot convert (`SHELL_UNMAPPED_COMMAND`, `SHELL_UNMAPPED_CONSTRUCT`). It does not do
judgement rewrites (set-based SQL, bind conversion, text pipelines to Python); it lists them as
suggestions. Those need the real provider.

### Secret handling

- Secrets exist only as environment variables and are read through `getSecret()` at the moment of
  use, inside the request. Provider clients are created per request and never stored at module scope.
- `npm run check-secrets` (part of `npm test` and `npm run build`) fails if any file other than
  `src/config/env.ts` reads `process.env`, or if a secret or provider client is assigned at module scope.
- No key is ever accepted from the browser. Errors are redacted before they are logged or returned.

## Vercel deployment

**Current state (2026-11-10).** A Vercel project `unix-to-python` is linked to this repository.
`main` is an intentionally empty production branch, so every push to `claude/script-modernizer`
creates a **preview** deployment. Production (`unix-to-python.vercel.app`) was deployed from this
branch with `vercel deploy --prod` and is **not** updated by pushes; redeploy the same way, or merge
into `main`. Both are protected by Vercel Authentication.
`APP_ACCESS_TOKEN` and `CRON_SECRET` are set as sensitive variables for Preview and Production.

**Storage is Supabase** (Vercel Marketplace, free plan, `us-east-1`, resource `script-modernizer-db`),
shared by Preview and Production, with `STORAGE_PROVIDER=supabase`. The schema is applied during the
Vercel build. The model, GitHub, SMTP, memory and embeddings are still mocks, so an approval is
"saved" to the mock GitHub and shows a placeholder commit link.

Verified on a preview with the database: `/api/health`, `/api/convert`, `GET /api/runs/:id`,
`revise`, `approve`, `feedback` and `/api/status`.

Two things to know when creating a project like this one: Vercel sends a new project's **first**
deployment to production whatever flags are used, and it takes the repository's only branch as the
production branch. Create the production branch first.

> Limits and names below were checked against Vercel documentation **through search summaries and
> the published `@vercel/config` types, not by reading the pages directly** (the documentation hosts
> were not reachable from the build environment). Re-check them in your account.

1. **Create the project** from this repository with the Git integration (framework: Next.js). Pushes
   to the working branch create preview deployments. Do not promote to production or attach a domain
   until you decide to.
2. **Functions.** Each route handler is a serverless function on the Node.js runtime. There is no
   custom server, no WebSocket server and no state between requests. `maxDuration` is set in
   `vercel.json` and in the route files (300 s for `convert`, `revise`, `resume` and `cron/learn`;
   60 s for `approve` and `cron/cleanup`). 300 s is the Hobby ceiling with Fluid compute; Pro allows
   more. **Memory** cannot be set per function in `vercel.json` when Fluid compute is on (it is a
   project setting: Settings → Functions); the default 2 GB / 1 vCPU is sufficient.
   Vercel may bundle routes with identical settings into one function; the code does not depend on
   either behaviour.
3. **Region.** `vercel.json` pins `iad1`. Put it next to your Supabase region and change both together.
4. **Environment variables.** Add everything from `.env.example` per environment; mark secrets as
   type *Secret*. Preview: leave every `*_PROVIDER` unset (mocks) — but see the note on storage
   below. Production: set the real providers.
5. **Cron.** `vercel.json` schedules `/api/cron/learn` (03:17 UTC daily) and `/api/cron/cleanup`
   (04:47 UTC daily). Set `CRON_SECRET` (16+ characters); Vercel sends it as a bearer token. Crons
   run on production deployments only. Hobby allows one run per day per job; on Pro you can run
   `learn` more often.
6. **Data branch and ignored build step.** Approved conversions and learned-rule mirrors are
   committed to `GITHUB_DATA_BRANCH` (default `conversions-data`), never to the deployed branch.
   `vercel.json` disables deployments for that branch (`git.deploymentEnabled`) and
   `scripts/vercel-ignore-build.sh` (the ignored build step; exit 0 skips) also skips any commit that
   only touches `conversions/` or `skills/learned/`. The app refuses to save if the data branch
   equals the deployed branch.
7. **Access.** The API needs the shared `APP_ACCESS_TOKEN`. Put the app behind your organisation's
   SSO. Keep Deployment Protection (Vercel Authentication) on for preview deployments.

**Preview deployments and storage (decision needed).** The mock storage is in-memory. On Vercel,
function instances do not share memory, so a preview that is fully on mocks can lose a run between
`convert` and `approve`. For a preview that runs the whole flow, set `STORAGE_PROVIDER=supabase`
with a preview database and leave every other provider on its mock.

Deploying from a terminal instead:

```bash
npm i -g vercel
vercel link
vercel env add APP_ACCESS_TOKEN preview
vercel build && vercel deploy --prebuilt     # preview deployment
```

## Supabase setup

1. Add Supabase from the Vercel Marketplace to the project; it syncs `POSTGRES_URL` (pooled,
   transaction mode, port 6543) and other variables. The app uses **only** `POSTGRES_URL`. The
   `NEXT_PUBLIC_SUPABASE_*` variables the integration adds are not used; the browser never talks to
   Supabase. Supabase Auth, Storage, Realtime and Edge Functions are not used.
2. Apply the schema. On Vercel this happens automatically: the `vercel-build` script runs the
   migrations before `next build` whenever `STORAGE_PROVIDER=supabase` (it uses
   `POSTGRES_URL_NON_POOLING` when present). By hand: `POSTGRES_URL=… npm run db:migrate`.
3. **Row Level Security** is enabled on every table and no policies are created, so the publishable
   key grants nothing. The server connects as the table owner through the pooled string, with
   prepared statements off (`prepare: false`), which the transaction pooler requires.
4. Tables: `runs` (drafts are stored inside the run document), `feedback`, `app_logs`,
   `skill_rules`, `conversion_examples`, `rate_limits`. Rate limiting uses the `rate_limits` table.
5. Set `STORAGE_PROVIDER=supabase`.

## Chroma setup

1. Create a Chroma Cloud database for each environment (separate ones for preview and production).
   Set `CHROMA_API_KEY`, `CHROMA_TENANT`, `CHROMA_DATABASE` and `MEMORY_PROVIDER=chroma`.
2. Collections are created on first use with no server-side embedding function (the app always
   supplies embeddings): `skill_rules` (base rules and promoted learned rules) and
   `conversion_examples` (sanitized before-and-after pairs of approved conversions). Metadata on
   every record: platform, status, rule or run ID, version, construct tags, embedding model.
3. Embeddings sit behind their own interface (`EMBEDDINGS_PROVIDER=voyage`, default model
   `voyage-code-4`). One model per collection; if you change the model, reindex.
4. `npm run reindex-memory` rebuilds both collections from Supabase at any time. Run it once after
   first setup so the base rules are indexed.
5. At generation time the top 5 rules and 2 examples (filtered by platform and status `promoted`)
   are passed to the agent and recorded in the witness. If Chroma is unreachable the conversion
   continues with the base rules and warning `MEMORY_UNAVAILABLE`.

## Reviewing a draft

- **Edit the target.** "Edit" under the target editor makes the file editable. "Save as version N"
  stores the edit as a new draft version and keeps the earlier one. The edit goes through the same
  output guardrails as model output (hosts, names and secrets are replaced and reported) and the
  same code validators. No model is called, so the independent review does not run on a hand edit;
  the new version carries the warning `DRAFT_EDITED_BY_REVIEWER`. `script_runtime.py` cannot be edited.
- **Remove from view.** Each change-list item and each warning has a "Remove" button. Removed items
  move to a "Removed from view" list and can be restored. Nothing is deleted: they stay in the
  stored draft and are marked as removed in the saved `report.md`. An error cannot be removed; it
  has to be fixed. After approval the lists are a fixed record.
- **Change the output from the feedback panel.** Each entry has two actions. "Change output" opens
  the target editor at that entry's line so you can fix it yourself. "Ask for a fix" requests a
  new draft with a note built from the entry (its code, line, message and next step).
- **Request changes** sends a note to the model and produces a new draft, as before.

## Human approval and GitHub

On approval the app commits to `conversions/<YYYY-MM-DD>-<runId>/` on the data branch:
`source.sanitized.<ext>`, `target.<ext>`, `config.ini.template` and `requirements.txt` when
generated, `script_runtime.py` for Python output, `witness.json`, `report.md`. Every file is scanned again immediately before the commit;
any hit aborts it. If the save fails the run stays approved with the save pending, the error is
shown with a Retry button, and the final output is not lost. No pull request is opened.

## Self-improvement and the witness

**Witness.** `witness.json` records the run ID, input and output hashes (of sanitized text),
platform, validator versions, issue codes at each stage, sanitizer counts before and hits after,
syntax-check results, rule IDs applied, retrieved memory IDs, the model IDs that answered, the
version of each system prompt, the effort level, attempt counts and timestamps.

```bash
npm run verify-witness conversions/2026-11-10-run_1a2b3c4d5e6f7a8b
```

re-runs the validators on the committed files and fails if a hash or the issue codes differ.
`npm run replay <dir>` goes further: it runs the whole pipeline again from the stored sanitized
input and reports each difference from the witness by kind (input, retrieval, prompt, model,
effort, validator, output).

**Loop: propose → verify → improve.**

- *Propose.* After each approved conversion the before-and-after pair is stored as an example.
  A candidate rule is derived when there is a signal: a reviewer note, more than one draft, a
  repair, a low rating with a comment, or a problem report. Rules are sanitized before saving.
- *Verify.* `/api/cron/learn` (never a user request) runs the full eval suite without and with the
  candidate, in small batches that continue across invocations. The before-and-after report with
  fixture hashes is the rule's witness.
- *Improve.* The rule is promoted only if no eval regresses, the sanitizer evals show zero leaks and
  at least one metric improves. It is saved in Supabase first, indexed in Chroma, and mirrored to
  `skills/learned/<platform>/<ruleId>.json` on the data branch. Otherwise it is rejected with a reason.
- Learned rules guide generation only. They cannot change the sanitizer, validators or guardrails.
- The status view lists rules with their witnesses; a person can disable any rule.

## Evals

`npm run eval` runs 10 golden fixtures (one per use case and router branch) and 11 adversarial
ones: hidden instructions, personal data in many formats, encoding tricks, oversize, empty, prose,
PeopleCode, and HTML, JSON, Python and binary input. All personal data is synthetic and seeded.

- **Hard gates (code graders):** zero sanitizer leaks, zero secrets in output, every output passes
  its syntax check (`python3 -m py_compile` too when an interpreter is present; it compiles, never
  runs), zero `SQL_NOT_DUAL_COMPATIBLE` hits, zero invented rule IDs.
- **Regression gate:** `evals/baseline.json` is committed; any fixture or metric worse than the
  baseline fails the run. CI runs it on every push and pull request.
- **Reported rates:** attack block rate, and guardrail false-positive rate on the scripts in
  `evals/real-traffic/` (none yet, so that rate is not measured).
- **Judge:** an LLM judge scores faithfulness on six yes-or-no criteria, with evidence before each
  answer. It is never a gate on its own, and it is **not calibrated** until 30 human-labelled cases exist.

A real-provider run is opt-in and never part of `npm test`:
`EVAL_REAL_PROVIDER=1 LLM_PROVIDER=anthropic ANTHROPIC_API_KEY=… npm run eval`. Details: `docs/evals/README.md`.

## Observability

- **Trace.** One trace per run; the trace ID is the run ID, which is shown in the review panel and
  written to every log line. Every stage, model call, retrieval and guardrail adds a span.
  Model-call spans carry the model that answered, prompt version, effort, stop reason, input,
  output and cache tokens, cost and latency, using OpenTelemetry GenAI attribute names. Spans are
  stored in the run record and served by `GET /api/runs/:id/trace`; they are not exported to an
  external tracing product.
- **Cost.** Computed per call from usage and the `LLM_PRICES` table. A model with no configured
  price is reported as "cost unknown", never as zero.
- **Logs.** Structured JSON to stdout (Vercel runtime logs) and to the `app_logs` table, kept
  `LOG_RETENTION_DAYS` (default 14). Script content is never logged, and log values are redacted.
- **Scores.** The user's rating and the live judge's verdict are attached to the trace. The learn
  cron job scores a sample of finished runs (`LIVE_JUDGE_SAMPLE_PERCENT`); a user request never waits for a judge.
- **Dashboard metrics** (`GET /api/status`; panel definitions in `docs/dashboards/status-dashboard.json`):
  volume, success rate, stage and model-call latency (p50, p95), tokens, cost per model and per
  day, cache hit rate, repair and retry rates, guardrail block rate, judge scores, rating
  distribution, top issue codes, rate-limit responses, save failures. The Status page in the
  browser still shows the earlier subset.
- **Alerts** (`alerts` in `GET /api/status`; mailed daily by the cleanup cron to `ALERT_OWNER`):
  error rate, p95 latency, daily cost, any guardrail leak, judge score drop, save failures. Each
  has a threshold variable. See `docs/runbooks/alerts.md`.

Runbooks: `docs/runbooks/complaint.md` (debugging a complaint from a run ID),
`alerts.md`, `key-rotation.md`, `rollback.md`.

## Issue-code catalogue

All codes are defined once in `src/pipeline/issue-codes.ts`. Code compares codes, never message text.

| Code | Severity | Meaning | Next step |
|---|---|---|---|
| `INPUT_TOO_LARGE` | error | The script is larger than the configured input limit. | Split the script into smaller scripts and convert each one. |
| `INPUT_EMPTY` | error | Nothing was pasted, or the input contains only whitespace. | Paste a SQL, PL/SQL, SQL*Plus or shell script. |
| `INPUT_UNSUPPORTED_TYPE` | error | The input is not a script type this tool converts (for example PeopleCode, SQR source, COBOL source, an Application Engine definition, a Data Mover .dms body, or plain prose). | Convert the shell or SQL wrapper that launches the program instead; the program source itself is out of scope. |
| `SANITIZE_LEAK_DETECTED` | error | A host, user, email address, personal value or other protected item was found in text that should already be sanitized. The run was stopped. | Remove the item from the source script and convert again. If it is a false positive, report it with the feedback button. |
| `SANITIZE_HOST_ROLE_AMBIGUOUS` | warning | The sanitizer could not tell whether a host is the source or the target, so it used target_server. | Check the highlighted line and correct the placeholder if this host is really the source. |
| `SANITIZE_OBFUSCATION_NORMALIZED` | warning | The script contained invisible characters, or an e-mail address or host name hidden by percent-encoding or full-width characters. They were removed or decoded so the sanitizer could replace them. | Check that the script still reads as intended. Invisible characters in a script are unusual and can hide text from a reviewer. |
| `SECRET_IN_OUTPUT` | error | Something that looks like a password, token or key appears in the output. | Replace it with a config or environment reference. Never approve output that contains a secret. |
| `SQL_PARSE_ERROR` | error | The SQL or PL/SQL does not parse: an unbalanced block, quote, comment, parenthesis or a missing terminator. | Look at the line shown, fix the structure, or request changes with a note. |
| `SQL_DESUPPORTED_FEATURE` | error | The script uses a feature that is desupported in Oracle AI Database 26ai and would fail after the upgrade. | Use the replacement named in the message; it must work on both 19c and 26ai. |
| `SQL_DEPRECATED_FEATURE` | warning | The script uses a feature that is deprecated in 26ai. It still works but should be replaced. | Plan the replacement named in the message. |
| `SQL_OBJECT_RENAMED` | warning | An object referenced in the source is referenced under a different name in the output. | Confirm that the change list explains the rename; PeopleSoft-delivered objects must never be renamed. |
| `SQL_STATEMENT_LOST` | error | A table, view or PL/SQL object used by the source is no longer referenced in the output, and the change list does not say why. | Compare the diff around the missing object and request changes. |
| `SQL_NOT_DUAL_COMPATIBLE` | error | The output uses syntax that exists only in 26ai (or only in later 19c release updates). It would fail on 19c. | Rewrite to the form that works on both releases. The 26ai form may be listed under "After 19c is retired". |
| `SQL_NO_COMMON_FORM` | error | No single SQL form works on both 19c and 26ai for this statement. The 19c form was kept. | Read both alternatives in the message and decide which to deploy, or wrap the statement in PL/SQL conditional compilation. |
| `SQL_NO_ERROR_CAPTURE` | error | The converted SQL does not record the failing line and error message as required. | Add the standard error-capture handler (PL/SQL) or SET SERVEROUTPUT ON (SQL*Plus). |
| `SQL_ERROR_SWALLOWED` | warning | The source catches an error and carries on (for example WHEN OTHERS THEN NULL). That behaviour was kept, and the error is now written to the log. | Decide whether the error should really be ignored. |
| `SQL_OUTPUT_NOT_SPOOLED` | warning | The SQL*Plus script has no SPOOL, so the error report only reaches standard output. | Make sure the caller redirects standard output to a log file, or add a SPOOL. |
| `SQL_COMMIT_IN_LOOP` | warning | A COMMIT sits inside a loop. The behaviour was kept; it can cause ORA-01555 and leaves partial work after a failure. | Consider committing once after the loop if the business process allows it. |
| `SQL_SUBSTITUTION_LOST` | error | A substitution (&name) or bind (:name) variable from the source is missing in the output. | Restore the variable; callers pass values through it. |
| `PY_SYNTAX_ERROR` | error | The generated Python does not parse. | Look at the line shown, or request changes. |
| `PY_SHELL_TRUE` | error | The Python runs a command through a shell (shell=True, os.system or eval). That is not allowed. | Use subprocess.run with an argument list and shell=False. |
| `PY_NO_LOGGING` | error | The Python script does not set up the standard rotating log. | Add the standard logging setup (RotatingFileHandler plus console). |
| `PY_NO_ERROR_EMAIL` | error | The Python script does not send the failure email to ops@script.com. | Add the standard error-email wrapper around main(). |
| `PY_NO_ERROR_CAPTURE` | error | The Python script does not build the standard error record (line number and message). | Add the central error handler around main(). |
| `PY_NO_CONFIG` | error | The Python script needs hosts, users or passwords but does not load them from the config file. | Load them through the standard config loader (--config or SCRIPT_CONFIG). |
| `PY_EXIT_CODE_CHANGED` | error | An exit code used by the shell script is not returned by the Python script. Schedulers depend on exit codes. | Return the same exit code for the same failure. |
| `PY_HARDCODED_ENDPOINT` | error | A host, user or credential is written directly in the Python script. | Move it to the config file. |
| `PY_STRUCTURE` | warning | The Python script does not follow the standard structure (docstring, main() returning the exit code, sys.exit(main())). | Restore the standard structure. |
| `SHELL_UNMAPPED_COMMAND` | warning | A shell command has no safe Python mapping and is run as an external program with subprocess.run. | Check that the program exists on the target host and that its arguments are correct. |
| `SHELL_UNMAPPED_CONSTRUCT` | error | A shell construct could not be converted automatically. | Convert this part by hand or request changes with guidance. |
| `SHELL_DESUPPORTED_TOOL` | error | The script calls an Oracle utility that is desupported in 26ai and will not exist after the upgrade. | Use the replacement named in the message (for example Data Pump expdp instead of original Export exp). |
| `SHELL_ORACLE_ENV_REVIEW` | warning | The script connects through ORACLE_SID or operating-system authentication. The non-CDB architecture is desupported, so on 26ai that connection reaches the container root, not the PeopleSoft pluggable database. | Connect to the PDB through its service name (the [database] dsn setting) and confirm the account exists there. |
| `SHELL_FTP_INSECURE` | warning | The script transfers files with FTP, which sends data and passwords in clear text. The protocol was kept. | Move the transfer to SFTP when the partner supports it. |
| `REVIEW_SEMANTIC_DRIFT` | error | The reviewer found that the converted script does something different from the source. | Read the reviewer message and request changes. |
| `REVIEW_TXN_BOUNDARY_CHANGED` | error | A COMMIT or ROLLBACK was added, removed or moved. | Restore the original transaction boundaries. |
| `REVIEW_STATEMENT_LOST` | error | The reviewer found a source statement with no equivalent in the output. | Restore the statement or explain its removal in the change list. |
| `REVIEW_EXIT_CODE_CHANGED` | error | The reviewer found that an exit code changed. | Restore the original exit code. |
| `REVIEW_UNKNOWN` | warning | The reviewer could not determine whether part of the draft is faithful to the source. | Check the line named in the message by hand before approving. |
| `REVIEW_UNAVAILABLE` | warning | The independent review could not be completed. | Review the diff by hand with extra care before approving. |
| `CONVERT_UNKNOWN` | warning | The converter could not convert part of the script with certainty, so it left that part as it was and said what is missing. | Read the message, supply the missing information in a "request changes" note, or convert that part by hand. |
| `CHANGE_RULE_UNKNOWN` | error | The change list cites a rule ID that was neither supplied to the model nor built in, so the stated reason for a change cannot be traced. | Request changes, or check the change by hand: its rule ID was invented. |
| `DRAFT_EDITED_BY_REVIEWER` | warning | This version was edited by hand in the target editor. The code checks ran on the edit; the independent review did not. | Read the diff against the previous version before approving. Use "Request changes" if you want the reviewer step to run again. |
| `RUN_TOKEN_BUDGET_REACHED` | warning | The run reached its token budget, so no further model calls were made for it. | Review the draft and its remaining issues by hand, or split the script and convert the parts. |
| `REPAIR_NO_PROGRESS` | warning | An automatic repair attempt did not change the set of errors, so repairing stopped early. | Fix the remaining errors by hand or request changes with a note. |
| `REPAIR_FAILED_KEPT_DRAFT` | warning | A repair call failed. The last usable draft was kept. | Review the remaining errors; convert again later if the provider was unavailable. |
| `MEMORY_UNAVAILABLE` | warning | The skill memory could not be reached. The conversion used the built-in rules only. | No action needed for this run. Check the memory provider if it keeps happening. |

## Palette

"Aurora": a midnight-indigo hero lit by violet, pink, cyan and amber, over a light lavender
workbench with white cards. The headline, primary buttons and stage track use a violet-to-pink
gradient. Contrast ratios were computed, not estimated; the full list (including every editor
token colour) is in the comment block at the top of `src/app/globals.css`.

| Role | Hex | Contrast |
|---|---|---|
| Page lavender | `#F5F3FF` | background |
| Card surface | `#FFFFFF` | background |
| Tint | `#EDE9FE` | background (hover, soft fills) |
| Hero night | `#120B33` to `#2E1065` | background |
| Brand violet (titles) | `#5B21B6` | 8.98 on white, 8.19 on lavender |
| Accent violet (links, UI) | `#6D28D9` | 7.10 on white, 6.48 on lavender |
| Primary button gradient | `#6D28D9` → `#A21CAF` → `#BE185D` | white text 7.10 / 6.32 / 6.04 |
| Body ink | `#1A1433` | 17.62 on white, 16.07 on lavender |
| Muted text | `#57527A` | 7.26 on white, 6.62 on lavender |
| Line (inputs, UI shapes) | `#7466CC` | 4.65 on white, 4.24 on lavender |
| Hero text | `#ECE9FF` | 12.54 or better on the hero |
| Error | `#BE123C` | 6.29 on white |
| Warning | `#92400E` | 7.09 on white |
| OK | `#046648` | 7.00 on white |
| Source editor | white `#FFFFFF` | text 17.62; keyword `#6D28D9` 7.10; string `#9D174D` 7.88; comment `#5F5985` 6.45 |
| Target editor | night `#140F2E` | text `#ECE9FF` 15.53; keyword `#C4B5FD` 10.00; string `#F9A8D4` 10.18; comment `#A5A1C8` 7.50 |

System font stacks only; no third-party fonts, scripts or analytics. The first-load animation lasts
under 6 seconds, can be skipped (button or Escape), plays once per session and is replaced by its
end state when `prefers-reduced-motion` is set.

## Known limits and unverified items

The full list, with how to confirm each item, is `docs/audit/verify-register.md`. The state of
every standard is in `docs/audit/01-gap-report.md`; the release verdict is `docs/release/readiness.md`.

- **Real providers** other than Postgres storage were not run against live services (no keys in the
  build environment). Postgres storage runs on Supabase in the Vercel deployments. The Claude
  request shape (adaptive thinking, effort, prompt caching, refusal fallback) is tested against
  stubbed HTTP only.
- **Evals ran on the mock provider only.** The committed baseline covers the mock. No effort sweep
  was run; effort `high` is an assumption.
- **The judge is not calibrated** (0 of 30 human-labelled cases). The mock judge decides one
  criterion for SQL and answers "unknown" for the rest, so its score is not a quality measure.
- **Guardrail false-positive rate is not measured:** there are no real-traffic samples yet.
- **No named approver.** Approval is authenticated by one shared access token, so the application
  cannot record who approved. This needs an identity provider.
- **Sanitizer.** Values hidden by base64, hex or a cipher are not found. See "Sanitization" for
  the limits on names.
- **Hallucination checks.** Code catches lost or renamed objects, lost variables and invented rule
  IDs. A brand-new identifier that replaces nothing is checked only by the judge.
- **Retrieval quality is not measured:** there is no labelled set and no recall at k.
- **Tracing and alerts.** Spans stay in the run record; nothing is exported to a tracing product.
  Alerts are evaluated daily, not in real time. Cache prices for models other than
  `claude-opus-5-5` in the built-in price table are derived, not confirmed.
- **Rollback and key rotation** are written down but were not rehearsed.
- **Vercel:** the full API flow was verified on a preview with Supabase storage before this change. Production runs an earlier build and was checked only through the Vercel API (ready and aliased), not by calling it. The two cron jobs are registered there; their runs have not been observed.
- **Documentation checks.** Oracle facts were read on docs.oracle.com. Claude API facts were checked
  against the reference bundled with the coding agent, not the vendor pages. Vercel, Supabase,
  Chroma and Voyage facts came from package sources and search summaries.
- **Shared Python runtime.** A converted Python script needs `script_runtime.py` beside it. Conversions
  saved before this change are self-contained and still verify.
- **Hand edits are not reviewed by the model.** The code checks run on an edit; the reviewer step does not.
- **Mock converter scope** — see "Switching from mocks to real providers".
- **SQL parse check** is a structure check (quotes, comments, parentheses, blocks, terminators), the
  minimum the specification allows; it is not a full Oracle grammar.
- **Handlers in PeopleSoft-delivered code.** The tool cannot tell delivered objects from custom ones;
  it adds error capture to every unit the script itself defines. Review units that redefine delivered objects.
- **Spool format.** A Python file writer honours `COLSEP` and `HEADING`/`PAGESIZE 0` only. Compare
  one output file with the original before go-live when a downstream system parses it.
