import { readFileSync } from 'node:fs';
import { getConfig } from '@/config/env';
import { Codes, issue, type Issue } from '@/pipeline/issue-codes';
import type { SanitizeCounts } from '@/pipeline/types';
import { Ctx, type Lang } from './context';
import { deobfuscate } from './deobfuscate';
import { hostPass } from './hosts';
import { namePass } from './names';
import { personalPass } from './personal';
import { secretPass } from './secrets';

export type { Lang } from './context';
export const SANITIZER_VERSION = '1.1.0';

export interface SanitizeResult {
  text: string;
  counts: SanitizeCounts;
  warnings: Issue[];
  highlightLines: number[];
}
export interface ScanHit {
  kind: 'sanitizer' | 'secret';
  line: number;
}

export class SanitizerLeakError extends Error {
  constructor(
    public where: string,
    public hits: ScanHit[],
  ) {
    super(`Sanitizer scan found ${hits.length} protected item(s) in ${where}`);
    this.name = 'SanitizerLeakError';
  }
}

/** Organisation deny-list: one name or term per line, from a server-side path. Never committed. */
export function loadDenyList(): string[] {
  const path = getConfig('DENYLIST_PATH');
  if (!path) return [];
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

function run(text: string, lang: Lang, denyList: string[]): { text: string; ctx: Ctx } {
  const ctx = new Ctx();
  let out = text.replace(/\r\n?/g, '\n');
  out = deobfuscate(out, ctx);
  out = secretPass(out, ctx, lang);
  out = hostPass(out, ctx, lang);
  out = namePass(out, ctx, lang, denyList);
  out = personalPass(out, ctx, lang);
  return { text: out, ctx };
}

/**
 * Deterministic sanitizer (section 8). The original-to-placeholder mapping lives
 * inside this call only. Throws on any internal failure so callers fail closed.
 */
export function sanitize(text: string, lang: Lang = 'text', denyList: string[] = loadDenyList()): SanitizeResult {
  const { text: out, ctx } = run(text, lang, denyList);
  const lines = out.split('\n');
  const warnings: Issue[] = [];
  const highlightLines: number[] = [];
  for (const ph of ctx.ambiguous) {
    const re = new RegExp(`(?<![\\w])${ph}(?![\\w])`);
    const hits = lines.map((l, i) => (re.test(l) ? i + 1 : 0)).filter(Boolean);
    highlightLines.push(...hits);
    warnings.push(issue(Codes.SANITIZE_HOST_ROLE_AMBIGUOUS, `Could not tell whether this host is a source or a target; used ${ph}.`, hits[0] ?? null, { sourceLine: hits[0] }));
  }
  if (ctx.obfuscated) warnings.push(issue(Codes.SANITIZE_OBFUSCATION_NORMALIZED, `${ctx.obfuscated} hidden item(s) were normalized before sanitizing: invisible characters removed, or an encoded e-mail address or host name decoded.`, null));
  // The sanitizer must be idempotent: a second pass over its own output changes nothing.
  const again = run(out, lang, denyList).text;
  if (again !== out) throw new Error('Sanitizer did not converge on a stable result');
  return { text: out, counts: ctx.counts, warnings, highlightLines: [...new Set(highlightLines)].sort((a, b) => a - b) };
}

function changedLines(before: string, after: string): number[] {
  const a = before.split('\n');
  const b = after.split('\n');
  const out: number[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) out.push(i + 1);
  return out;
}

/** Finds anything the sanitizer would still replace. An empty result means the text is clean. */
export function scanSanitized(text: string, lang: Lang = 'text', denyList: string[] = loadDenyList()): ScanHit[] {
  const norm = text.replace(/\r\n?/g, '\n');
  return changedLines(norm, run(norm, lang, denyList).text).map((line) => ({ kind: 'sanitizer' as const, line }));
}

/** Finds passwords, tokens and keys only. */
export function scanSecrets(text: string, lang: Lang = 'text'): ScanHit[] {
  const norm = text.replace(/\r\n?/g, '\n');
  const hits = new Set<number>();
  for (const l of new Set<Lang>([lang, 'text'])) for (const n of changedLines(norm, secretPass(norm, new Ctx(), l))) hits.add(n);
  return [...hits].sort((a, b) => a - b).map((line) => ({ kind: 'secret' as const, line }));
}

export function langOfFile(name: string): Lang {
  if (/\.py$/.test(name)) return 'python';
  if (/\.(sql|pls|pkb|pks)$/.test(name)) return 'sql';
  if (/\.(sh|ksh|bash)$/.test(name)) return 'shell';
  if (/\.(ini|template|cfg)$/.test(name)) return 'ini';
  return 'text';
}

/** Throws SanitizerLeakError if the text holds anything protected. Used before every write. */
export function assertClean(text: string, where: string, lang: Lang = 'text'): void {
  const hits = [...scanSanitized(text, lang), ...scanSecrets(text, lang)];
  if (hits.length) throw new SanitizerLeakError(where, hits);
}

export { countSummary } from './summary';
