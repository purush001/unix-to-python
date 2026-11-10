import { OUTPUT_FORMAT } from '@/agents/format';
import { Codes } from '@/pipeline/issue-codes';
import { RUNTIME_FILE, RUNTIME_MODULE, RUNTIME_VERSION, runtimeApi } from './runtime';
import { PYTHON_VALIDATOR_VERSION, validatePython } from './validators';
import { DATA_GUARD, HONESTY_RULE, ruleIdBlock, UNKNOWN_SIGNAL_AGENT } from '@/agents/prompts';
import { guidanceBlock, type PlatformAdapter } from '../types';

const BUILTIN_RULE_IDS: Record<string, string> = {
  'python-standard-runtime': 'uses the shared runtime module (config file, rotating log, error capture, failure email)',
  'set-e': 'set -e / -u / pipefail became strict mode and explicit checks',
  'trap-to-finally': 'trap became try/finally cleanup',
  'args-to-argparse': 'positional arguments or getopts became argparse',
  'env-file': 'a sourced profile is not executed; variables come from the environment or the config file',
  'sqlplus-to-oracledb': 'sqlplus heredoc runs through python-oracledb on one reused connection',
  'spool-to-file': 'SPOOL written by a Python file writer',
  'shell-vars-to-binds': 'shell variables inside SQL text became bind variables',
  'ftp-to-python': 'ftp session converted to ftplib (protocol kept)',
  'sftp-to-python': 'sftp session converted to paramiko',
  'ssh-to-paramiko': 'ssh remote command runs through paramiko',
  'scp-to-paramiko': 'scp replaced by paramiko SFTP',
  'mailx-to-smtplib': 'mailx replaced by smtplib',
  'secret-to-config': 'password, host or user read from the environment or the config file',
  'external-program': 'program still run as an external process with subprocess.run and no shell',
  'pipeline-kept': 'command pipeline run as chained external programs with no shell',
  'pipeline-to-python': 'text pipeline rewritten in Python',
  'perf-batch': 'executemany, arraysize or a reused connection or session for speed',
};

const SYSTEM = `You are shell-agent. You convert one ksh/bash/sh script (Oracle and PeopleSoft operations) into ONE Python 3.11+ script. Embedded SQL has already been converted and must be used as given.

Rules
1. Preserve behaviour, arguments, file outputs and the exit-code contract exactly; schedulers read the exit code. Every "exit N" in the source must be returned as N.
2. Prefer Python libraries to processes. Where a program must run, use subprocess.run with an argument list, shell=False, check=True, a timeout, and captured output sent to the log. Never use shell=True, os.system or eval.
3. Mapping: set -e/-u/pipefail/trap -> exceptions, explicit checks, try/finally. Positional arguments and getopts -> argparse with the same names and defaults. Environment variables -> os.environ with a config fallback and a clear error. sqlplus heredocs -> python-oracledb with bind variables on one reused connection (SPOOL -> file writer with the same format; WHENEVER SQLERROR EXIT -> exception and the same non-zero exit; SQL*Plus commits at session end). psae, psdmtx, pssqr, COBOL, sqlldr, expdp, impdp, rman stay external calls. ssh -> paramiko exec_command; scp/sftp -> paramiko SFTP with host-key checking ON (RejectPolicy). ftp -> ftplib, protocol kept, with the comment "# SHELL_FTP_INSECURE" on that line. mailx/mail/sendmail -> smtplib + email.message. grep/sed/awk/cut/sort/uniq/wc pipelines -> Python (re, csv, collections), streaming line by line. find/cp/mv/rm/mkdir/tar/gzip -> pathlib, shutil, tarfile, gzip. date arithmetic -> datetime. Lock files -> fcntl or an atomic lock file. Background jobs with & and wait -> concurrent.futures with a capped worker count. Cron lines in comments -> the docstring only. A command with no safe mapping -> subprocess.run and the trailing comment "# SHELL_UNMAPPED_COMMAND". Anything you cannot convert -> raise NotImplementedError with the trailing comment "# SHELL_UNMAPPED_CONSTRUCT".
4. Performance: one pooled or reused database connection; executemany for batch DML; arraysize/prefetchrows for large fetches; stream files and result sets; reuse one SSH/SFTP session; compile regular expressions once; threads only for independent I/O-bound steps.
5. No host, user or credential in the script: read them from the config file sections [source], [target], [database], [smtp], [logging]; passwords from an environment variable first, then the file. If the script needs any of them, also return a <config> section with a config.ini template whose values are placeholders (source_server, source_user, CHANGE_ME) and whose header says: chmod 600, keep out of version control, prefer Oracle Wallet or a secrets manager. Return a <requirements> section listing third-party packages.
6. Structure: module docstring (purpose, origin, arguments, exit codes, original schedule), type hints, small functions, no global state beyond constants, main() returns the exit code, and the file ends with: if __name__ == "__main__": sys.exit(main())
7. The standard runtime is supplied as the module ${RUNTIME_MODULE} (file ${RUNTIME_FILE}), delivered next to your script. Do NOT copy, rewrite or re-implement any of it: import what you need with "from ${RUNTIME_MODULE} import ..." and keep the script to its own logic, because a short script is what the reviewer reads and the runtime is already tested. You write exactly three things: parse_args(argv) (argparse with --config), job(state, args) -> int, and main(argv=None) that returns run_main(job, parse_args, argv). Never open a database connection, an SSH session, a mail session or a log handler yourself: use db_connect/run_sql, ssh_client/sftp_client/remote_command, send_mail and LOG, so failures are captured with their line, Oracle code and exit code. This is the runtime's public interface:

${runtimeApi()}

${ruleIdBlock(BUILTIN_RULE_IDS)}

${HONESTY_RULE}

${DATA_GUARD}

${UNKNOWN_SIGNAL_AGENT}

${OUTPUT_FORMAT}
Optional extra sections: <config>…</config> and <requirements>…</requirements>.`;

const HINTS: PlatformAdapter['repairHints'] = {
  [Codes.PY_SYNTAX_ERROR]: 'Fix the Python syntax at the reported line; return the complete script.',
  [Codes.PY_SHELL_TRUE]: 'Replace with subprocess.run([...], shell=False, check=True, timeout=…, capture_output=True).',
  [Codes.PY_NO_LOGGING]: 'Import from script_runtime and let run_main set up logging; log through LOG.',
  [Codes.PY_NO_ERROR_EMAIL]: 'main() must return run_main(job, parse_args, argv) from script_runtime; it sends the failure email.',
  [Codes.PY_NO_ERROR_CAPTURE]: 'Use run_main, run_sql and run_command from script_runtime instead of calling oracledb or subprocess directly.',
  [Codes.PY_NO_CONFIG]: 'Read settings through get_setting and get_password from script_runtime (state.cfg).',
  [Codes.PY_EXIT_CODE_CHANGED]: 'Return the same exit code as the shell script for the same failure.',
  [Codes.PY_HARDCODED_ENDPOINT]: 'Read the value with get_setting(state.cfg, section, key) instead of writing it in the script.',
  [Codes.SECRET_IN_OUTPUT]: 'Remove the literal secret; read it with get_password().',
  [Codes.SANITIZE_LEAK_DETECTED]: 'Use only the placeholders present in the source; do not introduce hosts, users, names or email addresses.',
  [Codes.SHELL_UNMAPPED_CONSTRUCT]: 'Convert the construct to Python following the mapping rules.',
  [Codes.CHANGE_RULE_UNKNOWN]: 'Cite only a guidance id you were given, a built-in rule id, "reviewer-note" or "unspecified".',
  [Codes.REVIEW_SEMANTIC_DRIFT]: 'Make the flagged part behave exactly like the source.',
  [Codes.REVIEW_STATEMENT_LOST]: 'Restore the step the reviewer found missing.',
  [Codes.REVIEW_EXIT_CODE_CHANGED]: 'Restore the original exit code.',
  [Codes.REVIEW_TXN_BOUNDARY_CHANGED]: 'Commit and roll back exactly where the SQL*Plus session did.',
};

export const shellPythonAdapter: PlatformAdapter = {
  platform: 'shell-python',
  agentName: 'shell-agent',
  builtinRuleIds: BUILTIN_RULE_IDS,
  outputExt: 'py',
  validatorVersion: `${PYTHON_VALIDATOR_VERSION}+runtime.${RUNTIME_VERSION}`,
  systemPrompt: () => SYSTEM,
  generatePrompt: (i) =>
    `${guidanceBlock(i.guidance)}${i.generateConfig ? '\nThe user asked for a config.ini template: always return <config>.\n' : ''}${i.note ? `\nReviewer note for this revision (apply it unless it conflicts with the rules): ${i.note}\n` : ''}\nConvert this script (sqlplus heredocs already hold the converted SQL):\n<source>\n${i.source}\n</source>`,
  repairPrompt: (i) =>
    `Your previous draft failed validation. Fix every issue below and return the complete corrected script.\n\nIssues:\n${i.issues.map((x) => `- ${x.code}${x.line ? ` (line ${x.line})` : ''}: ${x.message}${HINTS[x.code] ? `\n  How to fix: ${HINTS[x.code]}` : ''}`).join('\n')}\n${guidanceBlock(i.guidance)}\n<source>\n${i.source}\n</source>\n<draft>\n${i.draft}\n</draft>`,
  reviewPrompt: (i) => `Platform: ksh/bash shell converted to Python 3.11+. Review this conversion.

<source>
${i.source}
</source>
<draft>
${i.draft}
</draft>`,
  validate: async (v) => validatePython({ source: v.source, draft: v.draft }),
  repairHints: HINTS,
  parses: (issues) => !issues.some((i) => i.code === Codes.PY_SYNTAX_ERROR),
};
