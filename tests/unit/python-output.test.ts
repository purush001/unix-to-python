import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { loadFixtures, runFixture } from '@evals/suite';
import { RUNTIME_FILE, runtimeApi, runtimeExports, runtimeModule, usesRuntimeModule } from '@/adapters/shell-python/runtime';
import { validatePython } from '@/adapters/shell-python/validators';
import { ADAPTERS } from '@/adapters';
import { Codes } from '@/pipeline/issue-codes';
import { freshDb, testProviders } from '../helpers';

let python: string | null = null;
try {
  execFileSync('python3', ['--version'], { stdio: 'ignore' });
  python = 'python3';
} catch {
  /* interpreter checks are skipped without one */
}

/**
 * Lists global names a script loads but never defines or imports. It compiles the file and
 * reads the bytecode; it never runs the script.
 */
const UNDEFINED_NAMES = `
import builtins, dis, sys, types
src = open(sys.argv[1], encoding="utf-8").read()
code = compile(src, sys.argv[1], "exec")
defined = {i.argval for i in dis.get_instructions(code) if i.opname in ("STORE_NAME", "STORE_GLOBAL", "IMPORT_NAME", "IMPORT_FROM")} | set(dir(builtins)) | {"__file__", "__name__", "__doc__", "__annotations__"}
missing, todo = set(), [code]
while todo:
    c = todo.pop()
    todo += [k for k in c.co_consts if isinstance(k, types.CodeType)]
    missing |= {i.argval for i in dis.get_instructions(c) if i.opname in ("LOAD_GLOBAL", "LOAD_NAME") and i.argval not in defined}
print(",".join(sorted(missing)))
`;

const shellFixtures = () => loadFixtures().filter((f) => /\.(sh|ksh)$/.test(f.title) || f.source.startsWith('#!'));

beforeEach(freshDb);

describe('generated Python uses the shared runtime', () => {
  it('every converted script is short, imports the runtime, and comes with script_runtime.py', async () => {
    const sizes: Record<string, [number, number]> = {};
    for (const fx of shellFixtures().filter((f) => !f.expectReject)) {
      const r = await runFixture(fx, testProviders(), { keepOutputs: true });
      const target = r.outputs.find((o) => o.name === 'target.py')!;
      const lines = target.content.split('\n').length;
      sizes[fx.id] = [fx.source.split('\n').length, lines];
      expect(usesRuntimeModule(target.content), fx.id).toBe(true);
      expect(target.content, fx.id).toContain('return run_main(job, parse_args, argv)');
      // none of the runtime's body is repeated in the script
      for (const body of ['def setup_logging', 'def build_error_record', 'def send_failure_email', 'RotatingFileHandler', 'import smtplib']) expect(target.content, `${fx.id}: ${body}`).not.toContain(body);
      expect(r.outputs.find((o) => o.name === RUNTIME_FILE)?.content, fx.id).toBe(runtimeModule());
      // before the shared runtime these scripts were 340 to 520 lines
      expect(lines, fx.id).toBeLessThan(140);
      expect(target.content, fx.id).not.toMatch(/\n {4}return [^\n]*\n {4}return rc\n/);
    }
    expect(Object.keys(sizes).length).toBeGreaterThanOrEqual(8);
  });

  it.skipIf(!python)('no converted script uses a name it does not define or import', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'py-names-'));
    const checker = path.join(dir, 'undefined_names.py');
    writeFileSync(checker, UNDEFINED_NAMES);
    const problems: string[] = [];
    for (const fx of shellFixtures().filter((f) => !f.expectReject)) {
      const r = await runFixture(fx, testProviders(), { keepOutputs: true });
      const file = path.join(dir, `${fx.id}.py`);
      writeFileSync(file, r.outputs.find((o) => o.name === 'target.py')!.content);
      const missing = execFileSync(python!, ['-I', checker, file], { encoding: 'utf8' }).trim();
      if (missing) problems.push(`${fx.id}: ${missing}`);
    }
    const rt = path.join(dir, RUNTIME_FILE);
    writeFileSync(rt, runtimeModule());
    const missing = execFileSync(python!, ['-I', checker, rt], { encoding: 'utf8' }).trim();
    if (missing) problems.push(`${RUNTIME_FILE}: ${missing}`);
    rmSync(dir, { recursive: true, force: true });
    expect(problems).toEqual([]);
  });

  it('the model is shown the runtime interface, not its body', () => {
    const prompt = ADAPTERS['shell-python'].systemPrompt();
    expect(prompt).toContain('def run_main(job');
    expect(prompt).toContain('def run_sql(state: RunState');
    expect(prompt).not.toContain('RotatingFileHandler(');
    expect(runtimeApi().split('\n').length).toBeLessThan(60);
    expect(prompt.length).toBeLessThan(runtimeModule().length);
    expect(runtimeExports()).not.toContain('_require');
  });
});

describe('validators with the shared runtime', () => {
  const script = (main: string, extra = '') => `"""Job."""
from __future__ import annotations

import argparse
import sys
${extra}
from script_runtime import LOG, RunState, run_main


def parse_args(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", default=None)
    return parser.parse_args(argv)


def job(state: RunState, args) -> int:
    LOG.info("hello")
    return 0


def main(argv=None) -> int:
${main}


if __name__ == "__main__":
    sys.exit(main())
`;
  const codes = async (draft: string) => (await validatePython({ source: '#!/bin/sh\necho hello\n', draft })).map((i) => i.code);

  it('accepts a short script that hands its job to run_main', async () => {
    expect(await codes(script('    return run_main(job, parse_args, argv)'))).toEqual([]);
  });

  it('importing the runtime is not enough: a script that skips run_main loses logging, capture and the failure email', async () => {
    const c = await codes(script('    return job(None, parse_args(argv))'));
    expect(c).toEqual(expect.arrayContaining([Codes.PY_STRUCTURE, Codes.PY_NO_LOGGING, Codes.PY_NO_ERROR_EMAIL, Codes.PY_NO_ERROR_CAPTURE]));
  });

  it('a script that talks to the database itself must capture database errors itself', async () => {
    expect(await codes(script('    return run_main(job, parse_args, argv)', 'import oracledb'))).toContain(Codes.PY_NO_ERROR_CAPTURE);
  });
});
