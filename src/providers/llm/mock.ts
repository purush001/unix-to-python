import { renderAgentOutput } from '@/agents/format';
import { code, tokenize } from '@/adapters/plsql/tokenizer';
import type { LlmProvider, LlmRequest, LlmResponse } from '../types';
import { mockConvertShell } from './mock-shell';
import { mockConvertSql } from './mock-sql';

function count(text: string, words: string[]): number {
  return code(tokenize(text).tokens).filter((t) => t.type === 'word' && words.includes(t.up)).length;
}

/**
 * Deterministic stand-in for the model. It reads the structured task (not the prompt)
 * and produces a conservative conversion, so the whole product flow, the evals and the
 * tests run without a provider key. It never calls the network.
 */
export function createMockLlm(): LlmProvider {
  return {
    name: 'mock',
    async complete(req: LlmRequest): Promise<LlmResponse> {
      const p = req.task.payload as { source?: string; draft?: string; note?: string | null; generateConfig?: boolean; embedded?: boolean; tags?: string[]; firstDraft?: string; finalDraft?: string; notes?: string[] };
      let text: string;
      if (req.task.kind === 'generate' || req.task.kind === 'repair') {
        if (req.task.platform === 'plsql') {
          // a repair starts again from the source: the converter is idempotent and rule based
          const r = mockConvertSql(p.source ?? '', { embedded: !!p.embedded, note: p.note });
          text = renderAgentOutput({ converted: r.sql, changes: r.changes, suggestions: r.suggestions, config: null, requirements: null });
        } else {
          const r = mockConvertShell(p.source ?? '', { generateConfig: !!p.generateConfig, note: p.note });
          text = renderAgentOutput({ converted: r.python, changes: r.changes, suggestions: r.suggestions, config: r.config, requirements: r.requirements });
        }
      } else if (req.task.kind === 'review') {
        const issues: { code: string; message: string; line: null }[] = [];
        if (req.task.platform === 'plsql') {
          const a = count(p.source ?? '', ['COMMIT', 'ROLLBACK']);
          const b = count(p.draft ?? '', ['COMMIT', 'ROLLBACK']);
          if (a !== b) issues.push({ code: 'REVIEW_TXN_BOUNDARY_CHANGED', message: `The source has ${a} COMMIT/ROLLBACK statements; the draft has ${b}.`, line: null });
        }
        text = `<review>\n${JSON.stringify(issues)}\n</review>`;
      } else {
        const tags = p.tags ?? [];
        const rule = {
          trigger: tags.slice(0, 4),
          guidance: (p.notes ?? []).length ? `Reviewer feedback to apply for ${tags.slice(0, 3).join(', ') || 'this kind of script'}: ${(p.notes ?? []).join(' | ').slice(0, 600)}` : `Follow the approved conversion pattern for ${tags.slice(0, 3).join(', ') || 'this kind of script'}.`,
          example: { before: (p.firstDraft ?? '').slice(0, 600), after: (p.finalDraft ?? '').slice(0, 600) },
        };
        text = `<rule>\n${JSON.stringify(rule)}\n</rule>`;
      }
      return { text, status: 200, model: 'mock', usage: { inputTokens: 0, outputTokens: 0 } };
    },
  };
}
