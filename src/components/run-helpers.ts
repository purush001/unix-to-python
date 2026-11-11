import type { DraftView, IssueView, RunView } from '@/lib/api-types';
import type { EditorLanguage } from './editor-setup';
import { emptyStages, type StageMap } from './StageTrack';

export const STATUS_TEXT: Record<DraftView['status'], string> = { ok: 'ok', ok_with_warnings: 'ok with warnings', failed: 'failed' };
export const STATUS_GLYPH: Record<DraftView['status'], string> = { ok: '✓', ok_with_warnings: '▲', failed: '✕' };

export function latestDraft(run: RunView | null): DraftView | null {
  if (!run || run.drafts.length === 0) return null;
  return run.drafts[run.drafts.length - 1];
}

export function sourceLanguageOf(run: RunView): EditorLanguage {
  return run.scriptType === 'shell' || run.scriptType === 'mixed' ? 'shell' : 'sql';
}

/** Stage display for a stored run: everything that produced the draft is done; repair is "skipped" when it never ran. */
export function stagesOf(run: RunView, repairSeen: boolean): StageMap {
  const map = emptyStages();
  if (run.drafts.length === 0) {
    for (const s of run.stages) map[s.stage] = 'done';
    return map;
  }
  const repaired = repairSeen || run.stages.some((s) => s.stage === 'repair') || (latestDraft(run)?.attempts ?? 0) > 0;
  return { intake: 'done', generate: 'done', validate: 'done', repair: repaired ? 'done' : 'skipped', review: 'done', results: 'done' };
}

export function downloadText(name: string, content: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export interface IssueEntry {
  i: IssueView;
  /** Index of the issue in the draft's issue list. */
  n: number;
}

/**
 * The same finding on several lines is one entry in the feedback panel: same code, severity,
 * message and file. Findings with different messages stay separate.
 */
export function groupIssues(entries: IssueEntry[]): { first: IssueEntry; others: IssueEntry[] }[] {
  const groups = new Map<string, { first: IssueEntry; others: IssueEntry[] }>();
  for (const e of entries) {
    const key = `${e.i.code}|${e.i.severity}|${e.i.file ?? ''}|${e.i.message}`;
    const g = groups.get(key);
    if (g) g.others.push(e);
    else groups.set(key, { first: e, others: [] });
  }
  return [...groups.values()];
}
