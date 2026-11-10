import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadFixtures, SEEDS } from '@evals/suite';
import { beginRevision, continueRun, intake } from '@/agents/orchestrator';
import { approveRun } from '@/lib/approval';
import { createLogger } from '@/lib/logger';
import { verifyWitnessDir } from '@/lib/witness';
import { proposeAfterApproval } from '@/learning/loop';
import { mockGitState } from '@/providers/github/mock';
import { mockOutbox } from '@/providers/smtp/mock';
import { mockDb } from '@/providers/storage/mock';
import { freshDb, testProviders } from '../helpers';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const find = (haystack: string) => SEEDS.filter((s) => haystack.includes(s));

describe('seeded secrets and personal data never leave the request', () => {
  const consoleLines: string[] = [];
  beforeAll(async () => {
    freshDb();
    process.env.LOG_TO_STDOUT = '1';
    const orig = console.log;
    console.log = (...a: unknown[]) => void consoleLines.push(a.join(' '));
    try {
      for (const fx of loadFixtures().filter((f) => !f.expectReject)) {
        const providers = testProviders();
        const log = createLogger();
        const deps = { providers, log };
        const run = await intake(fx.source, 'auto', { generateConfig: true }, deps, { budgetMs: 60000 });
        await continueRun(run, deps, { budgetMs: 60000 });
        // reviewer text is sanitized too
        beginRevision(run, 'Ask Margaret Okafor (margaret.okafor@northwind-hr.com) whether 10.44.12.7 is still right; password was Summ3r#Payroll');
        await continueRun(run, deps, { budgetMs: 60000 });
        if (run.drafts.at(-1)!.result.status !== 'failed') {
          await approveRun(run, deps);
          await proposeAfterApproval(run, deps);
        }
        await log.flush(providers.storage);
      }
    } finally {
      console.log = orig;
      delete process.env.LOG_TO_STDOUT;
    }
  }, 180000);

  it('storage holds none of them (runs, drafts, logs, rules, examples, feedback)', () => {
    const db = mockDb();
    expect(db.runs.size).toBeGreaterThanOrEqual(10);
    const dump = JSON.stringify([[...db.runs.values()], db.logs, [...db.rules.values()], [...db.examples.values()], db.feedback]);
    expect(find(dump)).toEqual([]);
  });

  it('logs and console output hold none of them, and no script content', () => {
    const logs = JSON.stringify(mockDb().logs) + consoleLines.join('\n');
    expect(consoleLines.length).toBeGreaterThan(20);
    expect(find(logs)).toEqual([]);
    expect(logs).not.toMatch(/PS_PERSONAL_DATA|sqlplus -s|SELECT J\.EMPLID/);
  });

  it('GitHub commits and outgoing mail hold none of them', () => {
    const commits = mockGitState().commits;
    expect(commits.length).toBeGreaterThanOrEqual(10);
    expect(commits.every((c) => c.branch === 'conversions-data')).toBe(true);
    expect(find(JSON.stringify(commits) + JSON.stringify(mockOutbox()))).toEqual([]);
    const paths = commits[0].files.map((f) => f.path.split('/').pop());
    expect(paths).toEqual(expect.arrayContaining(['witness.json', 'report.md']));
    expect(paths.some((p) => p?.startsWith('source.sanitized.'))).toBe(true);
    expect(paths.some((p) => p?.startsWith('target.'))).toBe(true);
  });

  it('every committed conversion verifies against its witness', async () => {
    for (const c of mockGitState().commits.filter((x) => x.files.some((f) => f.path.endsWith('witness.json')))) {
      const dir = mkdtempSync(path.join(tmpdir(), 'witness-'));
      for (const f of c.files) {
        mkdirSync(path.dirname(path.join(dir, f.path)), { recursive: true });
        writeFileSync(path.join(dir, f.path), f.content);
      }
      const conv = path.dirname(path.join(dir, c.files[0].path));
      const r = await verifyWitnessDir(conv);
      expect(r.problems, c.message).toEqual([]);
      // a tampered target no longer verifies
      const target = c.files.find((f) => /target\.(sql|py)$/.test(f.path))!;
      writeFileSync(path.join(dir, target.path), target.content + '\n-- edited after approval\n');
      expect((await verifyWitnessDir(conv)).ok).toBe(false);
    }
  }, 120000);

  it('the built client bundle holds none of them (checked when a build exists)', () => {
    const root = path.join(process.cwd(), '.next', 'static');
    if (!existsSync(root)) return;
    const files: string[] = [];
    const walk = (d: string) => readdirSync(d).forEach((n) => (statSync(path.join(d, n)).isDirectory() ? walk(path.join(d, n)) : files.push(path.join(d, n))));
    walk(root);
    for (const f of files.filter((x) => /\.(js|css|json|html)$/.test(x))) {
      const text = readFileSync(f, 'utf8');
      expect(find(text), f).toEqual([]);
      expect(text).not.toMatch(/ANTHROPIC_API_KEY|POSTGRES_URL|CHROMA_API_KEY|GITHUB_TOKEN|APP_ACCESS_TOKEN/);
    }
  });
});
