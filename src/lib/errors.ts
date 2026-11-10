import { currentSecretValues } from '@/config/env';

/** Removes configured secret values and common credential shapes from text. */
export function redact(text: string): string {
  let out = text;
  for (const s of currentSecretValues()) out = out.split(s).join('[REDACTED]');
  return out
    .replace(/(postgres(?:ql)?:\/\/[^:\s/]+:)[^@\s]+@/gi, '$1[REDACTED]@')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, '$1 [REDACTED]')
    .replace(/\b(sk-ant-[A-Za-z0-9_-]{6,}|gh[pousr]_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,}|sb_secret_[A-Za-z0-9_-]{6,})/g, '[REDACTED]');
}

export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
    public runId?: string,
  ) {
    super(redact(message));
    this.name = 'AppError';
  }
}

export type ProviderFailure = 'malformed' | 'empty' | 'http' | 'timeout' | 'network';

/** Error from an external provider. `transient` errors are retried (section 7.2). */
export class ProviderError extends Error {
  constructor(
    public provider: string,
    public failure: ProviderFailure,
    public status: number,
    message: string,
  ) {
    super(redact(message));
    this.name = 'ProviderError';
  }
  get transient(): boolean {
    return this.failure !== 'http' || this.status >= 500;
  }
}

export function errorBody(e: { code: string; message: string; status: number; runId?: string }) {
  return { error: { code: e.code, message: redact(e.message), status: e.status, ...(e.runId ? { runId: e.runId } : {}) } };
}
