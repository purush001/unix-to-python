import { z } from 'zod';
import { ProviderError } from '@/lib/errors';
import { ALL_CODES, issue, type Issue, type IssueCode } from '@/pipeline/issue-codes';
import type { Change, Suggestion, Unknown } from '@/pipeline/types';

/**
 * S7. The tagged text format every agent reply uses. The code payload is never
 * JSON-escaped; the metadata around it is JSON checked against the schemas below.
 */
export const OUTPUT_FORMAT = `Reply with exactly these sections and nothing else:
<converted>
the complete converted script
</converted>
<changes>
a JSON array; each item is {"ruleId": string, "lines": string, "summary": string, "reason": string, "risk": "low" | "medium" | "high"}
</changes>
<suggestions>
a JSON array of {"title": string, "detail": string}; ideas that were NOT applied (may be [])
</suggestions>
<unknown>
a JSON array of {"sourceLine": number | null, "missing": string}; parts you left unconverted because something was missing or ambiguous (may be [])
</unknown>

Example of the three JSON sections:
<changes>
[{"ruleId": "sqlplus-serveroutput", "lines": "1", "summary": "SET SERVEROUTPUT ON SIZE UNLIMITED added", "reason": "The error-capture line is written through DBMS_OUTPUT.", "risk": "low"}]
</changes>
<suggestions>
[]
</suggestions>
<unknown>
[{"sourceLine": 42, "missing": "The script calls ./load_env.sh, which was not supplied, so the variables it sets are not known."}]
</unknown>`;

export interface AgentOutput {
  converted: string;
  changes: Change[];
  suggestions: Suggestion[];
  unknowns: Unknown[];
  config: string | null;
  requirements: string | null;
}

const ChangeSchema = z.object({
  ruleId: z.string().trim().min(1).max(120),
  lines: z.union([z.string(), z.number()]).transform(String),
  summary: z.string(),
  reason: z.string(),
  risk: z.enum(['low', 'medium', 'high']),
});
const SuggestionSchema = z.object({ title: z.string(), detail: z.string() });
const UnknownSchema = z.object({ sourceLine: z.number().int().positive().nullable().optional(), missing: z.string().trim().min(1) });

const REVIEW_CODES = ALL_CODES.filter((c) => c.startsWith('REVIEW_') && c !== 'REVIEW_UNAVAILABLE') as [IssueCode, ...IssueCode[]];
const ReviewSchema = z.object({
  code: z.enum(REVIEW_CODES),
  message: z.string(),
  line: z.number().int().nullable().optional(),
  sourceLine: z.number().int().nullable().optional(),
});

export const RuleSchema = z.union([
  z.object({ unknown: z.literal(true) }),
  z.object({ trigger: z.array(z.string()).max(20), guidance: z.string().trim().min(1), example: z.object({ before: z.string(), after: z.string() }) }),
]);

function section(text: string, tag: string): string | null {
  const open = text.indexOf(`<${tag}>`);
  const close = text.lastIndexOf(`</${tag}>`);
  if (open === -1 || close === -1 || close < open) return null;
  return text.slice(open + tag.length + 2, close).replace(/^\n/, '').replace(/\n$/, '');
}

/**
 * Parses a JSON array section and checks every item against its schema. A reply that does
 * not match is a transient provider error: it triggers a retry, never a repair attempt.
 */
function list<S extends z.ZodType>(raw: string | null, what: string, schema: S): z.output<S>[] {
  if (raw === null || raw.trim() === '') return [];
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    throw new ProviderError('llm', 'malformed', 200, `Model output has an invalid <${what}> section (not JSON)`);
  }
  const parsed = z.array(schema).safeParse(v);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ProviderError('llm', 'malformed', 200, `Model output has an invalid <${what}> section (${first ? `${first.path.join('.')}: ${first.code}` : 'schema'})`);
  }
  return parsed.data;
}

export function renderAgentOutput(o: Omit<AgentOutput, 'unknowns'> & { unknowns?: Unknown[] }): string {
  return [
    `<converted>\n${o.converted}\n</converted>`,
    `<changes>\n${JSON.stringify(o.changes, null, 1)}\n</changes>`,
    `<suggestions>\n${JSON.stringify(o.suggestions, null, 1)}\n</suggestions>`,
    `<unknown>\n${JSON.stringify(o.unknowns ?? [], null, 1)}\n</unknown>`,
    ...(o.config ? [`<config>\n${o.config}\n</config>`] : []),
    ...(o.requirements ? [`<requirements>\n${o.requirements}\n</requirements>`] : []),
  ].join('\n');
}

/** Parses an agent reply. Empty or malformed output is a transient provider error. */
export function parseAgentOutput(text: string): AgentOutput {
  if (!text.trim()) throw new ProviderError('llm', 'empty', 200, 'Model returned empty output');
  const converted = section(text, 'converted');
  if (converted === null || converted.trim() === '') throw new ProviderError('llm', 'malformed', 200, 'Model output has no <converted> section');
  const changes = list(section(text, 'changes'), 'changes', ChangeSchema);
  const suggestions = list(section(text, 'suggestions'), 'suggestions', SuggestionSchema);
  const unknowns = list(section(text, 'unknown'), 'unknown', UnknownSchema).map((u) => ({ sourceLine: u.sourceLine ?? null, missing: u.missing }));
  return { converted: converted.replace(/\r\n?/g, '\n'), changes, suggestions, unknowns, config: section(text, 'config'), requirements: section(text, 'requirements') };
}

/** Parses a reviewer reply. A code outside the closed set is malformed output, not something to drop silently. */
export function parseReviewOutput(text: string): Issue[] {
  if (!text.trim()) throw new ProviderError('llm', 'empty', 200, 'Reviewer returned empty output');
  const raw = section(text, 'review');
  if (raw === null) throw new ProviderError('llm', 'malformed', 200, 'Reviewer output has no <review> section');
  return list(raw, 'review', ReviewSchema).map((i) => issue(i.code, i.message, typeof i.line === 'number' ? i.line : null, typeof i.sourceLine === 'number' ? { sourceLine: i.sourceLine } : {}));
}

/** Parses the rule writer's reply. Returns null for the "unknown" signal. */
export function parseRuleOutput(text: string): { trigger: string[]; guidance: string; example: { before: string; after: string } } | null {
  const raw = section(text, 'rule');
  if (raw === null) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = RuleSchema.safeParse(v);
  if (!parsed.success || 'unknown' in parsed.data) return null;
  return parsed.data;
}
