import { ProviderError } from '@/lib/errors';
import { ALL_CODES, issue, type Issue, type IssueCode } from '@/pipeline/issue-codes';
import type { Change, Suggestion } from '@/pipeline/types';

/** The tagged text format every agent reply uses. Code is never JSON-escaped. */
export const OUTPUT_FORMAT = `Reply with exactly these sections and nothing else:
<converted>
the complete converted script
</converted>
<changes>
a JSON array; each item is {"ruleId": string, "lines": string, "summary": string, "reason": string, "risk": "low" | "medium" | "high"}
</changes>
<suggestions>
a JSON array of {"title": string, "detail": string}; ideas that were NOT applied (may be [])
</suggestions>`;

export interface AgentOutput {
  converted: string;
  changes: Change[];
  suggestions: Suggestion[];
  config: string | null;
  requirements: string | null;
}

function section(text: string, tag: string): string | null {
  const open = text.indexOf(`<${tag}>`);
  const close = text.lastIndexOf(`</${tag}>`);
  if (open === -1 || close === -1 || close < open) return null;
  return text.slice(open + tag.length + 2, close).replace(/^\n/, '').replace(/\n$/, '');
}
function json<T>(raw: string | null, what: string): T[] {
  if (raw === null || raw.trim() === '') return [];
  try {
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) throw new Error('not an array');
    return v as T[];
  } catch {
    throw new ProviderError('llm', 'malformed', 200, `Model output has an invalid <${what}> section`);
  }
}

export function renderAgentOutput(o: AgentOutput): string {
  return [
    `<converted>\n${o.converted}\n</converted>`,
    `<changes>\n${JSON.stringify(o.changes, null, 1)}\n</changes>`,
    `<suggestions>\n${JSON.stringify(o.suggestions, null, 1)}\n</suggestions>`,
    ...(o.config ? [`<config>\n${o.config}\n</config>`] : []),
    ...(o.requirements ? [`<requirements>\n${o.requirements}\n</requirements>`] : []),
  ].join('\n');
}

/** Parses an agent reply. Empty or malformed output is a transient provider error (section 7.2). */
export function parseAgentOutput(text: string): AgentOutput {
  if (!text.trim()) throw new ProviderError('llm', 'empty', 200, 'Model returned empty output');
  const converted = section(text, 'converted');
  if (converted === null || converted.trim() === '') throw new ProviderError('llm', 'malformed', 200, 'Model output has no <converted> section');
  const risk = new Set(['low', 'medium', 'high']);
  const changes = json<Change>(section(text, 'changes'), 'changes').map((c) => ({
    ruleId: String(c.ruleId ?? 'unspecified'),
    lines: String(c.lines ?? ''),
    summary: String(c.summary ?? ''),
    reason: String(c.reason ?? ''),
    risk: (risk.has(c.risk) ? c.risk : 'medium') as Change['risk'],
  }));
  const suggestions = json<Suggestion>(section(text, 'suggestions'), 'suggestions').map((s) => ({ title: String(s.title ?? ''), detail: String(s.detail ?? '') }));
  return { converted: converted.replace(/\r\n?/g, '\n'), changes, suggestions, config: section(text, 'config'), requirements: section(text, 'requirements') };
}

export function parseReviewOutput(text: string): Issue[] {
  if (!text.trim()) throw new ProviderError('llm', 'empty', 200, 'Reviewer returned empty output');
  const raw = section(text, 'review');
  if (raw === null) throw new ProviderError('llm', 'malformed', 200, 'Reviewer output has no <review> section');
  const items = json<{ code: string; message: string; line?: number | null; sourceLine?: number }>(raw, 'review');
  const allowed = new Set<IssueCode>(ALL_CODES.filter((c) => c.startsWith('REVIEW_')));
  return items
    .filter((i) => allowed.has(i.code as IssueCode))
    .map((i) => issue(i.code as IssueCode, String(i.message ?? ''), typeof i.line === 'number' ? i.line : null, typeof i.sourceLine === 'number' ? { sourceLine: i.sourceLine } : {}));
}
