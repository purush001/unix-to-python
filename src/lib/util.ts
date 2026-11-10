import { createHash, randomBytes } from 'node:crypto';

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
export function newRunId(): string {
  return 'run_' + randomBytes(8).toString('hex');
}
export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(6).toString('hex')}`;
}
export function nowIso(): string {
  return new Date().toISOString();
}
export function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}
