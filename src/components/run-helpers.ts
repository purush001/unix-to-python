import type { DraftView, RunView } from '@/lib/api-types';
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
