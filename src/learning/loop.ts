import { runFixture, loadFixtures, summarize, type FixtureResult, type EvalSummary } from '@evals/suite';
import { parseRuleOutput } from '@/agents/format';
import { RULE_WRITER_SYSTEM } from '@/agents/prompts';
import { getConfigInt } from '@/config/env';
import { dataBranch } from '@/lib/approval';
import type { Logger } from '@/lib/logger';
import { newId, nowIso } from '@/lib/util';
import { detectConstructs } from '@/pipeline/constructs';
import type { ConversionExample, Feedback, RunRecord, SkillRule } from '@/pipeline/types';
import type { Providers } from '@/providers/types';
import { sanitize } from '@/sanitizer';
import { indexExamples, indexRules } from './memory';

interface Deps {
  providers: Providers;
  log: Logger;
}

export interface VerifyState {
  state: 'running' | 'complete';
  next: number;
  fixtureHashes: Record<string, string>;
  baseline: FixtureResult[];
  withRule: FixtureResult[];
  report?: { baseline: EvalSummary; withRule: EvalSummary; regressions: string[]; improvements: string[]; decidedAt: string };
}

const clean = (s: string, max: number) => sanitize(String(s ?? '').slice(0, max), 'text').text;

/** PROPOSE: derive a candidate rule. Never throws; a failed proposal must not affect the user. */
export async function deriveCandidate(run: RunRecord, notes: string[], deps: Deps): Promise<SkillRule | null> {
  const log = deps.log.child({ runId: run.id, stage: 'propose' });
  try {
    const main = run.units[run.units.length - 1];
    const final = run.drafts[run.drafts.length - 1];
    const tags = detectConstructs(run.sanitizedSource, run.platform);
    const first = run.drafts[0]?.files[0]?.content ?? main?.firstDraft ?? '';
    const res = await deps.providers.llm.complete({
      system: RULE_WRITER_SYSTEM,
      user: `Platform: ${run.platform}\nConstructs: ${tags.join(', ')}\nReviewer notes and feedback:\n${notes.map((n) => `- ${n}`).join('\n') || '- (none)'}\n\nFirst draft (excerpt):\n${first.slice(0, 3000)}\n\nApproved draft (excerpt):\n${final.files[0].content.slice(0, 3000)}`,
      timeoutMs: getConfigInt('LLM_AUX_TIMEOUT_MS'),
      maxTokens: getConfigInt('LLM_RULE_MAX_TOKENS'),
      task: { kind: 'derive-rule', platform: run.platform, payload: { tags, notes, firstDraft: first.slice(0, 1500), finalDraft: final.files[0].content.slice(0, 1500) } },
    });
    // schema-checked; the "unknown" signal and anything malformed produce no rule
    const raw = parseRuleOutput(res.text);
    if (!raw) return null;
    // every rule is sanitized before it is saved
    const rule: SkillRule = {
      id: newId(`learned-${run.platform}`),
      version: 1,
      platform: run.platform,
      trigger: (raw.trigger.length ? raw.trigger : tags).map((t) => clean(String(t), 60)).filter(Boolean).slice(0, 8),
      guidance: clean(raw.guidance, 1500),
      example: { before: clean(raw.example.before, 2000), after: clean(raw.example.after, 2000) },
      sourceRunId: run.id,
      evalWitness: null,
      status: 'candidate',
      createdAt: nowIso(),
      updatedAt: nowIso(),
      indexed: true, // nothing to index until promoted
    };
    if (!rule.guidance) return null;
    await deps.providers.storage.upsertRule(rule);
    log.info('candidate rule proposed', { ruleId: rule.id, platform: rule.platform, triggers: rule.trigger.length });
    return rule;
  } catch (e) {
    log.warn('candidate rule proposal failed', { error: e instanceof Error ? e.name : 'unknown' });
    return null;
  }
}

/** PROPOSE after an approved conversion: store the example, and a candidate rule when there is a signal. */
export async function proposeAfterApproval(run: RunRecord, deps: Deps): Promise<void> {
  if (run.learned || (run.state !== 'approved' && run.state !== 'saved') || !run.final) return;
  const log = deps.log.child({ runId: run.id, stage: 'propose' });
  try {
    const d = run.drafts.find((x) => x.version === run.final!.version) ?? run.drafts[run.drafts.length - 1];
    const ex: ConversionExample = { runId: run.id, platform: run.platform, tags: detectConstructs(run.sanitizedSource, run.platform), before: run.sanitizedSource, after: d.files[0].content, createdAt: nowIso(), indexed: false };
    await deps.providers.storage.upsertExample(ex); // system of record first
    try {
      await indexExamples(deps.providers, [ex]);
      await deps.providers.storage.upsertExample({ ...ex, indexed: true });
    } catch {
      log.warn('example index write failed; the cron job will retry');
    }
    const repaired = run.units.some((u) => u.attempts > 0);
    if (run.reviewerNotes.length || run.drafts.length > 1 || repaired) await deriveCandidate(run, run.reviewerNotes.map((n) => n.note), deps);
    run.learned = true;
    await deps.providers.storage.saveRun(run);
  } catch (e) {
    log.warn('learning proposal failed', { error: e instanceof Error ? e.name : 'unknown' });
  }
}

export async function proposeAfterFeedback(run: RunRecord, fb: Feedback, deps: Deps): Promise<void> {
  if (!fb.comment || run.drafts.length === 0) return;
  if ((fb.rating !== null && fb.rating <= 2) || fb.errorCode) await deriveCandidate(run, [`${fb.errorCode ? `[${fb.errorCode}${fb.line ? ` line ${fb.line}` : ''}] ` : ''}${fb.comment}`], deps);
}

export function compare(baseline: FixtureResult[], withRule: FixtureResult[]): { regressions: string[]; improvements: string[]; leaks: number } {
  const regressions: string[] = [];
  const improvements: string[] = [];
  let leaks = 0;
  for (const b of baseline) {
    const w = withRule.find((x) => x.id === b.id);
    if (!w) {
      regressions.push(`${b.id}: missing result`);
      continue;
    }
    leaks += w.leaks + w.secrets;
    if (b.pass && !w.pass) regressions.push(`${b.id}: passed before, fails with the rule`);
    else if (w.errorCodes.length > b.errorCodes.length) regressions.push(`${b.id}: more error codes (${b.errorCodes.length} → ${w.errorCodes.length})`);
    else if (w.dualHits > b.dualHits) regressions.push(`${b.id}: new dual-compatibility hits`);
    else {
      if (!b.pass && w.pass) improvements.push(`${b.id}: now passes`);
      if (w.errorCodes.length < b.errorCodes.length) improvements.push(`${b.id}: fewer error codes (${b.errorCodes.length} → ${w.errorCodes.length})`);
      if (w.warningCodes.length < b.warningCodes.length) improvements.push(`${b.id}: fewer warnings (${b.warningCodes.length} → ${w.warningCodes.length})`);
      if (w.attempts < b.attempts) improvements.push(`${b.id}: fewer repair attempts (${b.attempts} → ${w.attempts})`);
    }
  }
  return { regressions, improvements, leaks };
}

/**
 * VERIFY + IMPROVE for one candidate. Runs the eval suite without and with the rule in
 * small batches, saving progress so a later cron invocation continues where this one stopped.
 */
export async function verifyCandidate(rule: SkillRule, deps: Deps, deadline: number): Promise<SkillRule> {
  const log = deps.log.child({ stage: 'verify' });
  const fixtures = loadFixtures();
  const st: VerifyState = (rule.evalWitness as VerifyState | null) ?? { state: 'running', next: 0, fixtureHashes: Object.fromEntries(fixtures.map((f) => [f.id, f.hash])), baseline: [], withRule: [] };
  while (st.next < fixtures.length && Date.now() < deadline) {
    const fx = fixtures[st.next];
    st.baseline.push(await runFixture(fx, deps.providers, {}));
    st.withRule.push(await runFixture(fx, deps.providers, { extraRules: [rule] }));
    st.next++;
  }
  rule.evalWitness = st;
  rule.updatedAt = nowIso();
  if (st.next < fixtures.length) {
    await deps.providers.storage.upsertRule(rule);
    log.info('verification in progress', { ruleId: rule.id, done: st.next, total: fixtures.length });
    return rule;
  }
  const c = compare(st.baseline, st.withRule);
  st.state = 'complete';
  st.report = { baseline: summarize(st.baseline), withRule: summarize(st.withRule), regressions: c.regressions, improvements: c.improvements, decidedAt: nowIso() };
  if (c.regressions.length === 0 && c.leaks === 0 && c.improvements.length > 0) {
    rule.status = 'promoted';
    rule.indexed = false;
    rule.mirrored = false;
    await deps.providers.storage.upsertRule(rule); // Supabase first
    await finishPromotion(rule, deps);
    log.info('rule promoted', { ruleId: rule.id, improvements: c.improvements.length });
  } else {
    rule.status = 'rejected';
    rule.rejectReason = c.leaks > 0 ? 'Sanitizer evals found a leak.' : c.regressions.length ? `Regression: ${c.regressions[0]}` : 'No eval metric improved.';
    await deps.providers.storage.upsertRule(rule);
    log.info('rule rejected', { ruleId: rule.id, reason: rule.rejectReason });
  }
  return rule;
}

/** Index a promoted rule in Chroma and mirror it to the data branch. Each step is retried by the cron job. */
export async function finishPromotion(rule: SkillRule, deps: Deps): Promise<void> {
  const log = deps.log.child({ stage: 'promote' });
  if (!rule.indexed) {
    try {
      await indexRules(deps.providers, [rule]);
      rule.indexed = true;
    } catch {
      log.warn('rule index write failed; will retry', { ruleId: rule.id });
    }
  }
  if (!rule.mirrored) {
    try {
      await deps.providers.github.commitFiles({ branch: dataBranch(), message: `Promote learned rule ${rule.id}`, files: [{ path: `skills/learned/${rule.platform}/${rule.id}.json`, content: JSON.stringify({ ...rule, indexed: undefined, mirrored: undefined }, null, 2) + '\n' }] });
      rule.mirrored = true;
    } catch {
      log.warn('rule mirror failed; will retry', { ruleId: rule.id });
    }
  }
  await deps.providers.storage.upsertRule(rule);
}

/** The background job: verify candidates in small batches, then retry pending index and mirror writes. */
export async function learnTick(deps: Deps, opts: { batch: number; deadline: number }): Promise<{ verified: number; pending: number }> {
  const candidates = (await deps.providers.storage.listRules({ status: 'candidate' })).slice(0, opts.batch);
  let verified = 0;
  for (const c of candidates) {
    if (Date.now() >= opts.deadline) break;
    const r = await verifyCandidate(c, deps, opts.deadline);
    if (r.status !== 'candidate') verified++;
  }
  for (const r of await deps.providers.storage.listRules({ status: 'promoted' })) if (!r.indexed || r.mirrored === false) await finishPromotion(r, deps);
  return { verified, pending: (await deps.providers.storage.listRules({ status: 'candidate' })).length };
}

/** A human switches a rule off: it stops guiding generation and leaves the index. */
export async function disableRule(id: string, deps: Deps): Promise<SkillRule | null> {
  const rule = await deps.providers.storage.getRule(id);
  if (!rule) return null;
  rule.status = 'disabled';
  rule.indexed = false;
  rule.updatedAt = nowIso();
  await deps.providers.storage.upsertRule(rule);
  try {
    await deps.providers.memory.remove('skill_rules', [rule.id]);
    rule.indexed = true;
    await deps.providers.storage.upsertRule(rule);
  } catch {
    deps.log.warn('rule removal from the index failed; the cron job will retry', { ruleId: id });
  }
  return rule;
}

/**
 * A human deletes a learned rule for good. It leaves the index first, so a deleted rule can
 * never keep guiding conversions: if the index cannot be reached the rule is kept and the
 * caller is told to disable it instead. The copy mirrored to the data branch is not removed.
 */
export async function deleteRule(id: string, deps: Deps): Promise<{ rule: SkillRule; mirroredCopyKept: boolean } | 'index-unavailable' | null> {
  const rule = await deps.providers.storage.getRule(id);
  if (!rule) return null;
  if (rule.status === 'promoted' || rule.indexed === false) {
    try {
      await deps.providers.memory.remove('skill_rules', [rule.id]);
    } catch {
      deps.log.warn('rule delete refused: the index could not be reached', { ruleId: id });
      return 'index-unavailable';
    }
  }
  await deps.providers.storage.deleteRule(id);
  deps.log.info('rule deleted', { ruleId: id, status: rule.status, platform: rule.platform });
  return { rule, mirroredCopyKept: rule.mirrored === true };
}
