# Runbook: keys and rotation (S2)

**Rules.** One key per environment (Preview and Production never share a key). Least
privilege per key. A spend limit in the provider console. Keys exist only as environment
variables, are read through `getSecret()` at the moment of use, and never appear in logs,
traces, eval reports or commits (`npm run check-secrets` and the redaction tests enforce the code side).

| Secret | Least privilege | Spend or rate limit | Where to create it |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | A key in a workspace used only by this application | Workspace spend limit in the Claude Console | Claude Console, API keys |
| `GITHUB_TOKEN` | Fine-grained token: one repository, "Contents: read and write" only | n/a | GitHub, Developer settings |
| `POSTGRES_URL` | The application's own database role | n/a | Supabase (synced by the Vercel integration) |
| `CHROMA_API_KEY` | One database per environment | Plan limit | Chroma Cloud |
| `VOYAGE_API_KEY` | One key per environment | Usage limit in the Voyage dashboard | Voyage |
| `SMTP_PASSWORD` | A sender-only account | n/a | Mail provider |
| `APP_ACCESS_TOKEN`, `CRON_SECRET` | Random, 32+ characters | n/a | `openssl rand -hex 32` |

## Rotation (no downtime)

Secrets are read per request and no client is kept at module scope, so a new value is used by the next request after the deployment that carries it.

1. Create the new key at the provider. Do not revoke the old one yet.
2. Set it in Vercel: Project Settings, Environment Variables, for one environment, type Secret.
3. Redeploy that environment (`vercel deploy --prod`, or push for Preview).
4. Check `GET /api/health`, then run one conversion and one approval.
5. Revoke the old key at the provider.
6. Note the date. Rotate every 90 days, and at once when a key may have been exposed.

**If a key leaked:** revoke first, then follow steps 1 to 4. Search the logs for the key's last four characters to confirm redaction held; the `app_logs` table keeps 14 days.

Not rehearsed in this build (no real keys were available). See the VERIFY register.
