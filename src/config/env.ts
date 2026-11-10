/**
 * The ONLY module allowed to read process.env.
 *
 * - getSecret(name) reads a secret at the moment it is needed. Callers must not
 *   copy the value into module scope, caches or long-lived objects (section 5.1).
 * - getConfig(name) reads non-secret configuration.
 *
 * scripts/check-secrets.ts enforces both rules statically.
 */

export const SECRET_NAMES = [
  'APP_ACCESS_TOKEN',
  'CRON_SECRET',
  'ANTHROPIC_API_KEY',
  'GITHUB_TOKEN',
  'SMTP_USER',
  'SMTP_PASSWORD',
  'POSTGRES_URL',
  'POSTGRES_URL_NON_POOLING',
  'CHROMA_API_KEY',
  'VOYAGE_API_KEY',
] as const;
export type SecretName = (typeof SECRET_NAMES)[number];

const CONFIG_DEFAULTS = {
  NODE_ENV: 'development',
  LLM_PROVIDER: 'mock', // mock | anthropic
  LLM_MODEL: 'claude-opus-5-5',
  LLM_EFFORT: 'high', // low | medium | high | xhigh | max
  LLM_MAX_TOKENS: '32000', // generate and repair
  LLM_REVIEW_MAX_TOKENS: '4000',
  LLM_RULE_MAX_TOKENS: '2000', // learning loop: rule writer
  LLM_JUDGE_MAX_TOKENS: '4000',
  LLM_AUX_TIMEOUT_MS: '30000', // rule writer and judge calls
  LLM_TRANSIENT_RETRIES: '2',
  LLM_MAX_CONTINUATIONS: '3', // how often a pause_turn reply is resumed
  LLM_FALLBACK_BETA: 'server-side-fallback-2026-07-01', // "off" turns server-side refusal fallback off
  LLM_CACHE_TTL: '5m', // 5m | 1h | off
  // USD per million tokens: [input, output, cache write 5m, cache write 1h, cache read]
  LLM_PRICES: '{"claude-opus-5-5":[4,20,5,8,0.2],"claude-fable-5-2":[8,40,10,16,0.2],"claude-sonnet-5-5":[2,10,2.5,4,0.1],"claude-haiku-5-5":[0.1,0.5,0.125,0.2,0.01],"mock":[0,0,0,0,0],"scripted":[0,0,0,0,0]}',
  MAX_RUN_TOKENS: '1500000', // input + output tokens one run may spend before model calls stop
  JUDGE_MODEL: 'claude-opus-5-5', // pinned separately from LLM_MODEL
  LIVE_JUDGE_SAMPLE_PERCENT: '10', // share of finished runs the cron job scores
  LIVE_JUDGE_BATCH: '5',
  RETRIEVAL_TOP_RULES: '5',
  RETRIEVAL_TOP_EXAMPLES: '2',
  ALERT_OWNER: '', // defaults to OPS_EMAIL
  ALERT_ERROR_RATE: '0.2', // failed runs / runs, last 24 h
  ALERT_P95_GENERATE_MS: '120000',
  ALERT_DAILY_COST_USD: '50',
  ALERT_JUDGE_MIN_SCORE: '0.8', // mean live-judge score, last 24 h
  ALERT_SAVE_FAILURES: '1', // GitHub save failures, last 24 h
  ALERT_MIN_RUNS: '5', // rate alerts need at least this many runs
  GITHUB_PROVIDER: 'mock', // mock | github
  GITHUB_REPO: '', // owner/name
  GITHUB_DATA_BRANCH: 'conversions-data',
  VERCEL_GIT_COMMIT_REF: '', // deployed branch, set by Vercel
  DEPLOY_BRANCH: '',
  SMTP_PROVIDER: 'mock', // mock | smtp
  SMTP_HOST: '',
  SMTP_PORT: '587',
  SMTP_FROM: 'ops@script.com',
  OPS_EMAIL: 'ops@script.com',
  STORAGE_PROVIDER: 'mock', // mock | supabase
  MEMORY_PROVIDER: 'mock', // mock | chroma
  CHROMA_TENANT: '',
  CHROMA_DATABASE: '',
  EMBEDDINGS_PROVIDER: 'mock', // mock | voyage
  EMBEDDINGS_MODEL: 'voyage-code-4',
  EMBEDDINGS_BASE_URL: 'https://ai.mongodb.com/v1',
  MAX_INPUT_BYTES: '204800',
  MAX_INPUT_LINES: '5000',
  MAX_REPAIR_ATTEMPTS: '2',
  PROVIDER_TIMEOUT_MS: '60000',
  REQUEST_BUDGET_MS: '240000',
  RATE_LIMIT_PER_MINUTE: '20',
  LOG_RETENTION_DAYS: '14',
  DENYLIST_PATH: '',
  EVAL_REAL_PROVIDER: '',
  CRON_BATCH_SIZE: '2',
  LOG_TO_STDOUT: '',
  MOCK_GITHUB_FAILURES: '0', // mock only: fail the first N saves (used to test the Retry path)
  RETRY_BASE_MS: '400',
} as const;
export type ConfigName = keyof typeof CONFIG_DEFAULTS;

export function getSecret(name: SecretName): string | undefined {
  const v = process.env[name];
  return v && v.length > 0 ? v : undefined;
}

export function requireSecret(name: SecretName): string {
  const v = getSecret(name);
  if (!v) throw new Error(`Required secret ${name} is not configured`);
  return v;
}

export function getConfig(name: ConfigName): string {
  const v = process.env[name];
  return v && v.length > 0 ? v : CONFIG_DEFAULTS[name];
}

export function getConfigNumber(name: ConfigName): number {
  const n = Number.parseFloat(getConfig(name));
  return Number.isFinite(n) ? n : Number.parseFloat(CONFIG_DEFAULTS[name]);
}

export function getConfigInt(name: ConfigName): number {
  const n = Number.parseInt(getConfig(name), 10);
  return Number.isFinite(n) ? n : Number.parseInt(CONFIG_DEFAULTS[name], 10);
}

/** Current values of every configured secret. Used only for redaction; never stored. */
export function currentSecretValues(): string[] {
  const out: string[] = [];
  for (const n of SECRET_NAMES) {
    const v = getSecret(n);
    if (v && v.length >= 6) out.push(v);
  }
  return out;
}
