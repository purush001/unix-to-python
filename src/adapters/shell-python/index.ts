import { OUTPUT_FORMAT } from '@/agents/format';
import { Codes } from '@/pipeline/issue-codes';
import { referenceRuntime, RUNTIME_VERSION } from './runtime';
import { PYTHON_VALIDATOR_VERSION, validatePython } from './validators';
import { DATA_GUARD, guidanceBlock, REVIEW_FORMAT, type PlatformAdapter } from '../types';

const SYSTEM = `You are shell-agent. You convert one ksh/bash/sh script (Oracle and PeopleSoft operations) into ONE Python 3.11+ script. Embedded SQL has already been converted and must be used as given.

${DATA_GUARD}

Rules
1. Preserve behaviour, arguments, file outputs and the exit-code contract exactly; schedulers read the exit code. Every "exit N" in the source must be returned as N.
2. Prefer Python libraries to processes. Where a program must run, use subprocess.run with an argument list, shell=False, check=True, a timeout, and captured output sent to the log. Never use shell=True, os.system or eval.
3. Mapping: set -e/-u/pipefail/trap -> exceptions, explicit checks, try/finally. Positional arguments and getopts -> argparse with the same names and defaults. Environment variables -> os.environ with a config fallback and a clear error. sqlplus heredocs -> python-oracledb with bind variables on one reused connection (SPOOL -> file writer with the same format; WHENEVER SQLERROR EXIT -> exception and the same non-zero exit; SQL*Plus commits at session end). psae, psdmtx, pssqr, COBOL, sqlldr, expdp, impdp, rman stay external calls. ssh -> paramiko exec_command; scp/sftp -> paramiko SFTP with host-key checking ON (RejectPolicy). ftp -> ftplib, protocol kept, with the comment "# SHELL_FTP_INSECURE" on that line. mailx/mail/sendmail -> smtplib + email.message. grep/sed/awk/cut/sort/uniq/wc pipelines -> Python (re, csv, collections), streaming line by line. find/cp/mv/rm/mkdir/tar/gzip -> pathlib, shutil, tarfile, gzip. date arithmetic -> datetime. Lock files -> fcntl or an atomic lock file. Background jobs with & and wait -> concurrent.futures with a capped worker count. Cron lines in comments -> the docstring only. A command with no safe mapping -> subprocess.run and the trailing comment "# SHELL_UNMAPPED_COMMAND". Anything you cannot convert -> raise NotImplementedError with the trailing comment "# SHELL_UNMAPPED_CONSTRUCT".
4. Performance: one pooled or reused database connection; executemany for batch DML; arraysize/prefetchrows for large fetches; stream files and result sets; reuse one SSH/SFTP session; compile regular expressions once; threads only for independent I/O-bound steps.
5. No host, user or credential in the script: read them from the config file sections [source], [target], [database], [smtp], [logging]; passwords from an environment variable first, then the file. If the script needs any of them, also return a <config> section with a config.ini template whose values are placeholders (source_server, source_user, CHANGE_ME) and whose header says: chmod 600, keep out of version control, prefer Oracle Wallet or a secrets manager. Return a <requirements> section listing third-party packages.
6. Structure: module docstring (purpose, origin, arguments, exit codes, original schedule), type hints, small functions, no global state beyond constants, main() returns the exit code, and the file ends with: if __name__ == "__main__": sys.exit(main())
7. Use this standard runtime VERBATIM (include only the helper groups you need; keep function names). You write parse_args(argv) and job(state, args) -> int:

${referenceRuntime()}

${OUTPUT_FORMAT}
Optional extra sections: <config>…</config> and <requirements>…</requirements>.`;

const HINTS: PlatformAdapter['repairHints'] = {
  [Codes.PY_SYNTAX_ERROR]: 'Fix the Python syntax at the reported line; return the complete script.',
  [Codes.PY_SHELL_TRUE]: 'Replace with subprocess.run([...], shell=False, check=True, timeout=…, capture_output=True).',
  [Codes.PY_NO_LOGGING]: 'Restore setup_logging from the standard runtime (RotatingFileHandler + StreamHandler, format with run ID and %(filename)s:%(lineno)d).',
  [Codes.PY_NO_ERROR_EMAIL]: 'Restore send_failure_email and the main() wrapper from the standard runtime.',
  [Codes.PY_NO_ERROR_CAPTURE]: 'Restore build_error_record / SqlError / run_command from the standard runtime.',
  [Codes.PY_NO_CONFIG]: 'Restore load_config, get_setting and get_password; read settings through them.',
  [Codes.PY_EXIT_CODE_CHANGED]: 'Return the same exit code as the shell script for the same failure.',
  [Codes.PY_HARDCODED_ENDPOINT]: 'Read the value with get_setting(state.cfg, section, key) instead of writing it in the script.',
  [Codes.SECRET_IN_OUTPUT]: 'Remove the literal secret; read it with get_password().',
  [Codes.SANITIZE_LEAK_DETECTED]: 'Use only the placeholders present in the source; do not introduce hosts, users, names or email addresses.',
  [Codes.SHELL_UNMAPPED_CONSTRUCT]: 'Convert the construct to Python following the mapping rules.',
  [Codes.REVIEW_SEMANTIC_DRIFT]: 'Make the flagged part behave exactly like the source.',
  [Codes.REVIEW_STATEMENT_LOST]: 'Restore the step the reviewer found missing.',
  [Codes.REVIEW_EXIT_CODE_CHANGED]: 'Restore the original exit code.',
  [Codes.REVIEW_TXN_BOUNDARY_CHANGED]: 'Commit and roll back exactly where the SQL*Plus session did.',
};

export const shellPythonAdapter: PlatformAdapter = {
  platform: 'shell-python',
  agentName: 'shell-agent',
  outputExt: 'py',
  validatorVersion: `${PYTHON_VALIDATOR_VERSION}+runtime.${RUNTIME_VERSION}`,
  systemPrompt: () => SYSTEM,
  generatePrompt: (i) =>
    `${guidanceBlock(i.guidance)}${i.generateConfig ? '\nThe user asked for a config.ini template: always return <config>.\n' : ''}${i.note ? `\nReviewer note for this revision (apply it unless it conflicts with the rules): ${i.note}\n` : ''}\nConvert this script (sqlplus heredocs already hold the converted SQL):\n<source>\n${i.source}\n</source>`,
  repairPrompt: (i) =>
    `Your previous draft failed validation. Fix every issue below and return the complete corrected script.\n\nIssues:\n${i.issues.map((x) => `- ${x.code}${x.line ? ` (line ${x.line})` : ''}: ${x.message}${HINTS[x.code] ? `\n  How to fix: ${HINTS[x.code]}` : ''}`).join('\n')}\n${guidanceBlock(i.guidance)}\n<source>\n${i.source}\n</source>\n<draft>\n${i.draft}\n</draft>`,
  reviewPrompt: (i) =>
    `You are an independent reviewer. You cannot edit the script. Compare the sanitized shell source with the Python draft and report only real problems: semantic drift, lost steps, changed transaction boundaries, changed exit codes. The standard runtime (logging, config, error email) is expected and is not a problem.\n${DATA_GUARD}\n\n${REVIEW_FORMAT}\n\n<source>\n${i.source}\n</source>\n<draft>\n${i.draft}\n</draft>`,
  validate: async (v) => validatePython({ source: v.source, draft: v.draft }),
  repairHints: HINTS,
  parses: (issues) => !issues.some((i) => i.code === Codes.PY_SYNTAX_ERROR),
};
