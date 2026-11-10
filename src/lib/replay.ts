import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { continueRun, intake } from '@/agents/orchestrator';
import { createLogger } from '@/lib/logger';
import { traceTotals } from '@/lib/trace';
import { sha256 } from '@/lib/util';
import type { SelectableType, Witness } from '@/pipeline/types';
import type { Providers } from '@/providers/types';

export interface ReplayResult {
  runId: string;
  /** True when the replay reproduced the committed output byte for byte. */
  identical: boolean;
  differences: string[];
  then: { outputHash: string; finalCodes: string[]; models: string[]; promptVersions: Record<string, string>; effort: string; validatorVersions: Record<string, string>; stageCodes: Witness['stageCodes'] };
  now: { outputHash: string; finalCodes: string[]; models: string[]; promptVersions: Record<string, string>; effort: string; validatorVersions: Record<string, string>; stageCodes: Witness['stageCodes']; llmCalls: number };
}

/**
 * S12 / S16. Replays a committed conversion offline from its stored, sanitized input and
 * compares the result with the witness. Nothing is persisted and no script is executed.
 * Differences are classified so the cause of a complaint can be narrowed down: a changed
 * prompt version points at the prompt, a changed model at the model, and so on.
 */
export async function replayDir(dir: string, providers: Providers): Promise<ReplayResult> {
  const names = readdirSync(dir);
  const read = (n: string) => readFileSync(path.join(dir, n), 'utf8');
  const witness = JSON.parse(read('witness.json')) as Witness;
  const sourceName = names.find((n) => n.startsWith('source.sanitized.'));
  if (!sourceName) throw new Error('source.sanitized.* is missing');
  const source = read(sourceName);
  const differences: string[] = [];
  if (sha256(source) !== witness.inputHash) differences.push('input: the stored sanitized source does not match the witness input hash');
  const deps = { providers, log: createLogger() };
  const limits = { budgetMs: 10 * 60 * 1000, persist: false, retryBaseMs: 1 };
  let run = await intake(source, witness.scriptType as SelectableType, { generateConfig: names.includes('config.ini.template') }, deps, limits);
  if (run.inputHash !== witness.inputHash) differences.push('input guardrail: sanitizing the stored source again changed it (sanitizer version differs)');
  run = await continueRun(run, deps, limits);
  const w = run.drafts[run.drafts.length - 1].result.witness;
  const then = { outputHash: witness.outputHash, finalCodes: witness.finalCodes, models: witness.models ?? [], promptVersions: witness.promptVersions ?? {}, effort: witness.effort ?? '', validatorVersions: witness.validatorVersions, stageCodes: witness.stageCodes };
  const now = { outputHash: w.outputHash, finalCodes: w.finalCodes, models: w.models, promptVersions: w.promptVersions, effort: w.effort, validatorVersions: w.validatorVersions, stageCodes: w.stageCodes, llmCalls: traceTotals(run.trace).llmCalls };
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  if (!same(then.models, now.models)) differences.push(`model: answered by [${then.models.join(', ') || 'not recorded'}] then, [${now.models.join(', ')}] now`);
  if (!same(then.promptVersions, now.promptVersions)) differences.push(`prompt: versions ${JSON.stringify(then.promptVersions)} then, ${JSON.stringify(now.promptVersions)} now`);
  if (then.effort !== now.effort) differences.push(`effort: "${then.effort || 'not recorded'}" then, "${now.effort}" now`);
  if (!same(then.validatorVersions, now.validatorVersions)) differences.push(`validator: versions ${JSON.stringify(then.validatorVersions)} then, ${JSON.stringify(now.validatorVersions)} now`);
  if (!same(witness.retrieved, w.retrieved)) differences.push(`retrieval: retrieved ${JSON.stringify(witness.retrieved)} then, ${JSON.stringify(w.retrieved)} now`);
  if (!same(then.stageCodes, now.stageCodes)) differences.push('stages: the issue codes per stage differ (compare "then" and "now")');
  if (!same(then.finalCodes, now.finalCodes)) differences.push(`final codes: [${then.finalCodes.join(', ')}] then, [${now.finalCodes.join(', ')}] now`);
  if (then.outputHash !== now.outputHash) differences.push('output: the converted script differs from the committed one');
  return { runId: witness.runId, identical: then.outputHash === now.outputHash && same(then.finalCodes, now.finalCodes), differences, then, now };
}
