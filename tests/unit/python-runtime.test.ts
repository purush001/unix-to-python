import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RUNTIME_FILE, runtimeExports, runtimeModule } from '@/adapters/shell-python/runtime';

let python: string | null = null;
try {
  execFileSync('python3', ['--version'], { stdio: 'ignore' });
  python = 'python3';
} catch {
  /* the test is skipped without an interpreter */
}

/**
 * The error-capture helper is tested with a SYNTHETIC failure written here.
 * No user-supplied script is ever executed.
 */
function harness(jobBody: string): string {
  return [
    '"""Synthetic failure harness."""',
    'from __future__ import annotations',
    '',
    'import argparse',
    'import sys',
    'from typing import Optional, Sequence',
    '',
    'from script_runtime import LOG, RunState, ScriptError, run_command, run_main, step',
    '',
    '',
    'def parse_args(argv: Optional[Sequence[str]] = None) -> argparse.Namespace:',
    '    parser = argparse.ArgumentParser()',
    '    parser.add_argument("--config", default=None)',
    '    parser.add_argument("mode", nargs="?", default="")',
    '    return parser.parse_args(argv)',
    '',
    '',
    'def job(state: RunState, args: argparse.Namespace) -> int:',
    jobBody,
    '',
    '',
    'def main(argv: Optional[Sequence[str]] = None) -> int:',
    '    return run_main(job, parse_args, argv)',
    '',
    '',
    'if __name__ == "__main__":',
    '    sys.exit(main())',
    '',
  ].join('\n');
}

const JOB = `    rc = 0
    if args.mode == "raise":
        raise ValueError("synthetic failure for the test")  # MARK-RAISE
    if args.mode == "exit7":
        raise ScriptError("handled failure", 7)  # MARK-EXIT7
    if args.mode == "handled":
        rc = step(state, "false", run_command, ["false"])  # MARK-HANDLED
        if rc != 0:
            return 9
    if args.mode == "cmd":
        rc = step(state, "sh", run_command, [sys.executable, "-c", "import sys; sys.stderr.write('disk is full\\\\n'); sys.exit(3)"])
        return rc
    LOG.info("all good")
    return 0`;

describe.skipIf(!python)('generated Python runtime: error capture', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'py-runtime-'));
  const script = path.join(dir, 'synthetic_job.py');
  const source = harness(JOB);
  writeFileSync(script, source);
  // the shared runtime sits next to the script, as it does in a delivered conversion
  writeFileSync(path.join(dir, RUNTIME_FILE), runtimeModule());
  // port 9 is closed: the failure email cannot be delivered
  writeFileSync(path.join(dir, 'config.ini'), `[smtp]\nhost = 127.0.0.1\nport = 9\nsender = ops@script.com\n[logging]\nlog_dir = ${dir}/logs\nlevel = INFO\n[source]\nhost = source_server\n`);
  const run = (mode: string) => {
    const r = spawnSync(python!, ['-E', '-s', script, '--config', path.join(dir, 'config.ini'), mode], { encoding: 'utf8', timeout: 60000 });
    return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
  };
  const lineOf = (mark: string) => source.split('\n').findIndex((l) => l.includes(mark)) + 1;

  it('the script and the shared runtime compile, and the runtime imports without oracledb or paramiko', () => {
    execFileSync(python!, ['-I', '-m', 'py_compile', script]);
    execFileSync(python!, ['-I', '-m', 'py_compile', path.join(dir, RUNTIME_FILE)]);
    expect(runtimeExports()).toEqual(expect.arrayContaining(['LOG', 'RunState', 'ScriptError', 'run_main', 'run_sql', 'run_command', 'sftp_client', 'ftp_session', 'send_mail', 'remove_paths']));
  });

  it('records the failing line and message for an unhandled exception and exits 1', () => {
    const r = run('raise');
    expect(r.code).toBe(1);
    expect(r.out).toContain(`FAILED line=${lineOf('MARK-RAISE')} message=synthetic failure for the test type=ValueError file=synthetic_job.py function=job`);
    // the email could not be sent: that is logged and the exit code is unchanged
    expect(r.out).toContain('Could not send failure email');
    expect(r.out).toMatch(/End synthetic_job\.py exit_code=1/);
  });

  it('keeps the exit code of a handled failure', () => {
    const r = run('exit7');
    expect(r.code).toBe(7);
    expect(r.out).toContain(`FAILED line=${lineOf('MARK-EXIT7')} message=handled failure`);
  });

  it('logs a survived error at WARNING with its line, and captures command name, exit code and stderr', () => {
    const handled = run('handled');
    expect(handled.code).toBe(9);
    expect(handled.out).toMatch(/WARNING .* false failed: line=\d+ message=false exited with code 1 .*command=false command_exit_code=1/);
    const cmd = run('cmd');
    expect(cmd.code).toBe(3);
    expect(cmd.out).toContain('command_exit_code=3 stderr_tail=disk is full');
  });

  it('succeeds quietly, writes the rotating log with run id and file:line, and never logs settings', () => {
    const r = run('ok');
    expect(r.code).toBe(0);
    const log = readFileSync(path.join(dir, 'logs', 'synthetic_job.log'), 'utf8');
    expect(log).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2},\d{3} INFO [0-9a-f]{12} script_runtime\.py:\d+ Start synthetic_job\.py$/m);
    // a line logged by the job itself carries the script's own file and line
    expect(log).toMatch(/INFO [0-9a-f]{12} synthetic_job\.py:\d+ all good$/m);
    expect(log).not.toContain('127.0.0.1');
    rmSync(dir, { recursive: true, force: true });
  });
});
