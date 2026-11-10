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
  'CHROMA_API_KEY',
  'VOYAGE_API_KEY',
] as const;
export type SecretName = (typeof SECRET_NAMES)[number];

const CONFIG_DEFAULTS = {
  NODE_ENV: 'development',
  LLM_PROVIDER: 'mock', // mock | anthropic
  LLM_MODEL: 'claude-opus-5-5',
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
