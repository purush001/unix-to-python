import { sourceFileName } from '@/agents/orchestrator';
import { getConfig } from '@/config/env';
import { AppError, redact } from '@/lib/errors';
import type { Logger } from '@/lib/logger';
import { nowIso } from '@/lib/util';
import { ISSUE_CATALOGUE } from '@/pipeline/issue-codes';
import type { DraftVersion, RunRecord } from '@/pipeline/types';
import type { Providers } from '@/providers/types';
import { assertClean, countSummary, langOfFile, SanitizerLeakError } from '@/sanitizer';

export function conversionPath(run: RunRecord): string {
  return `conversions/${(run.final?.approvedAt ?? run.createdAt).slice(0, 10)}-${run.id}`;
}

export function buildReport(run: RunRecord, d: DraftVersion): string {
  const r = d.result;
  const lines = [
    `# Conversion report ${run.id}`,
    '',
    `- Script type: ${run.scriptType} → ${run.platform === 'plsql' ? 'SQL/PL/SQL for Oracle 19c and 26ai' : 'Python 3.11+'}`,
    `- Status: ${r.status}`,
    `- Draft version approved: ${d.version} of ${run.drafts.length}`,
    `- Approved: ${run.final?.approvedAt ?? 'not yet'}`,
    `- Repair attempts: ${r.attempts}`,
    `- Sanitization: ${countSummary(run.sanitization.counts)}`,
    ...(run.rating ? [`- Rating: ${run.rating.rating}/5${run.rating.comment ? ` — ${run.rating.comment}` : ''}`] : []),
    '',
    '## Change list',
    '',
    ...(r.changes.length ? ['| Rule | Lines | Change | Reason | Risk |', '|---|---|---|---|---|', ...r.changes.map((c) => `| ${c.ruleId} | ${c.lines} | ${c.summary.replace(/\|/g, '/')} | ${c.reason.replace(/\|/g, '/')} | ${c.risk} |`)] : ['No changes were needed.']),
    '',
    '## Issues and warnings',
    '',
    ...(r.issues.length ? r.issues.map((i) => `- **${i.code}** (${i.severity}${i.line ? `, line ${i.line}` : ''}): ${i.message} _${ISSUE_CATALOGUE[i.code].nextStep}_`) : ['None.']),
    '',
    '## Suggestions (not applied)',
    '',
    ...(d.suggestions.length ? d.suggestions.map((s) => `- **${s.title}** — ${s.detail}`) : ['None.']),
    '',
    '## Reviewer notes',
    '',
    ...(run.reviewerNotes.length ? run.reviewerNotes.map((n) => `- ${n.at}: ${n.note}`) : ['None.']),
    '',
    '## Verification',
    '',
    'Run `npm run verify-witness <this directory>` in the application repository to re-run the validators on these files and compare the issue codes and hashes with `witness.json`.',
    '',
  ];
  return lines.join('\n');
}

export function commitFiles(run: RunRecord): { path: string; content: string }[] {
  const d = run.drafts.find((x) => x.version === run.final?.version) ?? run.drafts[run.drafts.length - 1];
  const dir = conversionPath(run);
  return [
    { path: `${dir}/${sourceFileName(run.scriptType)}`, content: run.sanitizedSource },
    ...d.files.map((f) => ({ path: `${dir}/${f.name}`, content: f.content })),
    { path: `${dir}/witness.json`, content: JSON.stringify(d.result.witness, null, 2) + '\n' },
    { path: `${dir}/report.md`, content: buildReport(run, d) },
  ];
}

export function dataBranch(): string {
  const branch = getConfig('GITHUB_DATA_BRANCH');
  const deployed = getConfig('DEPLOY_BRANCH') || getConfig('VERCEL_GIT_COMMIT_REF');
  if (deployed && deployed === branch) throw new AppError('CONFIG_ERROR', 'GITHUB_DATA_BRANCH must differ from the deployed branch so an approval never triggers a deployment.', 500);
  return branch;
}

/**
 * Approve (or retry the save of) a run. The human decision is recorded first; if the
 * GitHub save then fails the run stays approved with the save pending and can be retried.
 */
export async function approveRun(run: RunRecord, deps: { providers: Providers; log: Logger }): Promise<RunRecord> {
  const log = deps.log.child({ runId: run.id, stage: 'approve' });
  if (run.state === 'saved') return run;
  if (run.state !== 'draft_ready' && run.state !== 'approved') throw new AppError('INVALID_STATE', `A run in state "${run.state}" cannot be approved.`, 409, run.id);
  if (run.state === 'draft_ready') {
    const d = run.drafts[run.drafts.length - 1];
    run.final = { version: d.version, approvedAt: nowIso() };
    run.state = 'approved';
    run.save = { status: 'pending' };
    run.updatedAt = nowIso();
    await deps.providers.storage.saveRun(run);
    log.info('run approved', { version: d.version, status: d.result.status });
  }
  try {
    const branch = dataBranch();
    const files = commitFiles(run);
    // scan every file immediately before commit; abort on any hit
    for (const f of files) assertClean(f.content, f.path, langOfFile(f.path));
    const res = await deps.providers.github.commitFiles({ branch, files, message: `Add conversion ${run.id} (${run.scriptType})` });
    run.save = { status: 'saved', commit: { sha: res.sha, url: res.url, branch: res.branch, path: conversionPath(run) } };
    run.state = 'saved';
    log.info('conversion saved', { branch: res.branch, files: files.length });
  } catch (e) {
    const leak = e instanceof SanitizerLeakError;
    run.save = { status: 'failed', error: leak ? 'The pre-commit scan found a protected item, so nothing was committed.' : redact(e instanceof Error ? e.message : 'GitHub save failed') };
    log.error('github save failed', { leak, error: run.save.error });
    try {
      await deps.providers.smtp.send({ to: getConfig('OPS_EMAIL'), subject: `Script Modernizer: GitHub save failed for ${run.id}`, text: `Run ${run.id} is approved but could not be saved: ${run.save.error}\nRetry from the application.` });
    } catch {
      log.warn('ops notification failed');
    }
  }
  run.updatedAt = nowIso();
  await deps.providers.storage.saveRun(run);
  return run;
}
