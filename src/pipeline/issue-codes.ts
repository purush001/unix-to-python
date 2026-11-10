/**
 * Every issue code the pipeline can emit, defined once.
 * Code compares codes (never message text). The catalogue feeds the
 * feedback panel (plain-language explanation + suggested next step) and the README.
 */
export type Severity = 'error' | 'warning';

interface CodeInfo {
  severity: Severity;
  explanation: string;
  nextStep: string;
}

export const ISSUE_CATALOGUE = {
  INPUT_TOO_LARGE: { severity: 'error', explanation: 'The script is larger than the configured input limit.', nextStep: 'Split the script into smaller scripts and convert each one.' },
  INPUT_EMPTY: { severity: 'error', explanation: 'Nothing was pasted, or the input contains only whitespace.', nextStep: 'Paste a SQL, PL/SQL, SQL*Plus or shell script.' },
  INPUT_UNSUPPORTED_TYPE: { severity: 'error', explanation: 'The input is not a script type this tool converts (for example PeopleCode, SQR source, COBOL source, an Application Engine definition, a Data Mover .dms body, or plain prose).', nextStep: 'Convert the shell or SQL wrapper that launches the program instead; the program source itself is out of scope.' },
  SANITIZE_LEAK_DETECTED: { severity: 'error', explanation: 'A host, user, email address, personal value or other protected item was found in text that should already be sanitized. The run was stopped.', nextStep: 'Remove the item from the source script and convert again. If it is a false positive, report it with the feedback button.' },
  SANITIZE_HOST_ROLE_AMBIGUOUS: { severity: 'warning', explanation: 'The sanitizer could not tell whether a host is the source or the target, so it used target_server.', nextStep: 'Check the highlighted line and correct the placeholder if this host is really the source.' },
  SECRET_IN_OUTPUT: { severity: 'error', explanation: 'Something that looks like a password, token or key appears in the output.', nextStep: 'Replace it with a config or environment reference. Never approve output that contains a secret.' },
  SQL_PARSE_ERROR: { severity: 'error', explanation: 'The SQL or PL/SQL does not parse: an unbalanced block, quote, comment, parenthesis or a missing terminator.', nextStep: 'Look at the line shown, fix the structure, or request changes with a note.' },
  SQL_DESUPPORTED_FEATURE: { severity: 'error', explanation: 'The script uses a feature that is desupported in Oracle AI Database 26ai and would fail after the upgrade.', nextStep: 'Use the replacement named in the message; it must work on both 19c and 26ai.' },
  SQL_DEPRECATED_FEATURE: { severity: 'warning', explanation: 'The script uses a feature that is deprecated in 26ai. It still works but should be replaced.', nextStep: 'Plan the replacement named in the message.' },
  SQL_OBJECT_RENAMED: { severity: 'warning', explanation: 'An object referenced in the source is referenced under a different name in the output.', nextStep: 'Confirm that the change list explains the rename; PeopleSoft-delivered objects must never be renamed.' },
  SQL_STATEMENT_LOST: { severity: 'error', explanation: 'A table, view or PL/SQL object used by the source is no longer referenced in the output, and the change list does not say why.', nextStep: 'Compare the diff around the missing object and request changes.' },
  SQL_NOT_DUAL_COMPATIBLE: { severity: 'error', explanation: 'The output uses syntax that exists only in 26ai (or only in later 19c release updates). It would fail on 19c.', nextStep: 'Rewrite to the form that works on both releases. The 26ai form may be listed under "After 19c is retired".' },
  SQL_NO_COMMON_FORM: { severity: 'error', explanation: 'No single SQL form works on both 19c and 26ai for this statement. The 19c form was kept.', nextStep: 'Read both alternatives in the message and decide which to deploy, or wrap the statement in PL/SQL conditional compilation.' },
  SQL_NO_ERROR_CAPTURE: { severity: 'error', explanation: 'The converted SQL does not record the failing line and error message as required.', nextStep: 'Add the standard error-capture handler (PL/SQL) or SET SERVEROUTPUT ON (SQL*Plus).' },
  SQL_ERROR_SWALLOWED: { severity: 'warning', explanation: 'The source catches an error and carries on (for example WHEN OTHERS THEN NULL). That behaviour was kept, and the error is now written to the log.', nextStep: 'Decide whether the error should really be ignored.' },
  SQL_OUTPUT_NOT_SPOOLED: { severity: 'warning', explanation: 'The SQL*Plus script has no SPOOL, so the error report only reaches standard output.', nextStep: 'Make sure the caller redirects standard output to a log file, or add a SPOOL.' },
  SQL_COMMIT_IN_LOOP: { severity: 'warning', explanation: 'A COMMIT sits inside a loop. The behaviour was kept; it can cause ORA-01555 and leaves partial work after a failure.', nextStep: 'Consider committing once after the loop if the business process allows it.' },
  SQL_SUBSTITUTION_LOST: { severity: 'error', explanation: 'A substitution (&name) or bind (:name) variable from the source is missing in the output.', nextStep: 'Restore the variable; callers pass values through it.' },
  PY_SYNTAX_ERROR: { severity: 'error', explanation: 'The generated Python does not parse.', nextStep: 'Look at the line shown, or request changes.' },
  PY_SHELL_TRUE: { severity: 'error', explanation: 'The Python runs a command through a shell (shell=True, os.system or eval). That is not allowed.', nextStep: 'Use subprocess.run with an argument list and shell=False.' },
  PY_NO_LOGGING: { severity: 'error', explanation: 'The Python script does not set up the standard rotating log.', nextStep: 'Add the standard logging setup (RotatingFileHandler plus console).' },
  PY_NO_ERROR_EMAIL: { severity: 'error', explanation: 'The Python script does not send the failure email to ops@script.com.', nextStep: 'Add the standard error-email wrapper around main().' },
  PY_NO_ERROR_CAPTURE: { severity: 'error', explanation: 'The Python script does not build the standard error record (line number and message).', nextStep: 'Add the central error handler around main().' },
  PY_NO_CONFIG: { severity: 'error', explanation: 'The Python script needs hosts, users or passwords but does not load them from the config file.', nextStep: 'Load them through the standard config loader (--config or SCRIPT_CONFIG).' },
  PY_EXIT_CODE_CHANGED: { severity: 'error', explanation: 'An exit code used by the shell script is not returned by the Python script. Schedulers depend on exit codes.', nextStep: 'Return the same exit code for the same failure.' },
  PY_HARDCODED_ENDPOINT: { severity: 'error', explanation: 'A host, user or credential is written directly in the Python script.', nextStep: 'Move it to the config file.' },
  PY_STRUCTURE: { severity: 'warning', explanation: 'The Python script does not follow the standard structure (docstring, main() returning the exit code, sys.exit(main())).', nextStep: 'Restore the standard structure.' },
  SHELL_UNMAPPED_COMMAND: { severity: 'warning', explanation: 'A shell command has no safe Python mapping and is run as an external program with subprocess.run.', nextStep: 'Check that the program exists on the target host and that its arguments are correct.' },
  SHELL_UNMAPPED_CONSTRUCT: { severity: 'error', explanation: 'A shell construct could not be converted automatically.', nextStep: 'Convert this part by hand or request changes with guidance.' },
  SHELL_DESUPPORTED_TOOL: { severity: 'error', explanation: 'The script calls an Oracle utility that is desupported in 26ai and will not exist after the upgrade.', nextStep: 'Use the replacement named in the message (for example Data Pump expdp instead of original Export exp).' },
  SHELL_ORACLE_ENV_REVIEW: { severity: 'warning', explanation: 'The script connects through ORACLE_SID or operating-system authentication. The non-CDB architecture is desupported, so on 26ai that connection reaches the container root, not the PeopleSoft pluggable database.', nextStep: 'Connect to the PDB through its service name (the [database] dsn setting) and confirm the account exists there.' },
  SHELL_FTP_INSECURE: { severity: 'warning', explanation: 'The script transfers files with FTP, which sends data and passwords in clear text. The protocol was kept.', nextStep: 'Move the transfer to SFTP when the partner supports it.' },
  REVIEW_SEMANTIC_DRIFT: { severity: 'error', explanation: 'The reviewer found that the converted script does something different from the source.', nextStep: 'Read the reviewer message and request changes.' },
  REVIEW_TXN_BOUNDARY_CHANGED: { severity: 'error', explanation: 'A COMMIT or ROLLBACK was added, removed or moved.', nextStep: 'Restore the original transaction boundaries.' },
  REVIEW_STATEMENT_LOST: { severity: 'error', explanation: 'The reviewer found a source statement with no equivalent in the output.', nextStep: 'Restore the statement or explain its removal in the change list.' },
  REVIEW_EXIT_CODE_CHANGED: { severity: 'error', explanation: 'The reviewer found that an exit code changed.', nextStep: 'Restore the original exit code.' },
  REVIEW_UNKNOWN: { severity: 'warning', explanation: 'The reviewer could not determine whether part of the draft is faithful to the source.', nextStep: 'Check the line named in the message by hand before approving.' },
  REVIEW_UNAVAILABLE: { severity: 'warning', explanation: 'The independent review could not be completed.', nextStep: 'Review the diff by hand with extra care before approving.' },
  CONVERT_UNKNOWN: { severity: 'warning', explanation: 'The converter could not convert part of the script with certainty, so it left that part as it was and said what is missing.', nextStep: 'Read the message, supply the missing information in a "request changes" note, or convert that part by hand.' },
  CHANGE_RULE_UNKNOWN: { severity: 'error', explanation: 'The change list cites a rule ID that was neither supplied to the model nor built in, so the stated reason for a change cannot be traced.', nextStep: 'Request changes, or check the change by hand: its rule ID was invented.' },
  RUN_TOKEN_BUDGET_REACHED: { severity: 'warning', explanation: 'The run reached its token budget, so no further model calls were made for it.', nextStep: 'Review the draft and its remaining issues by hand, or split the script and convert the parts.' },
  REPAIR_NO_PROGRESS: { severity: 'warning', explanation: 'An automatic repair attempt did not change the set of errors, so repairing stopped early.', nextStep: 'Fix the remaining errors by hand or request changes with a note.' },
  REPAIR_FAILED_KEPT_DRAFT: { severity: 'warning', explanation: 'A repair call failed. The last usable draft was kept.', nextStep: 'Review the remaining errors; convert again later if the provider was unavailable.' },
  MEMORY_UNAVAILABLE: { severity: 'warning', explanation: 'The skill memory could not be reached. The conversion used the built-in rules only.', nextStep: 'No action needed for this run. Check the memory provider if it keeps happening.' },
} as const satisfies Record<string, CodeInfo>;

export type IssueCode = keyof typeof ISSUE_CATALOGUE;

/** Constant lookup: Codes.SQL_PARSE_ERROR === 'SQL_PARSE_ERROR'. */
export const Codes = Object.fromEntries(Object.keys(ISSUE_CATALOGUE).map((k) => [k, k])) as { [K in IssueCode]: K };

export const ALL_CODES = Object.keys(ISSUE_CATALOGUE) as IssueCode[];

export interface Issue {
  code: IssueCode;
  /** The parser's or checker's own error text. */
  message: string;
  severity: Severity;
  /** Line in the output script; null only for whole-script issues. */
  line: number | null;
  column?: number;
  /** Matching line in the sanitized source, when it can be traced. */
  sourceLine?: number;
  /** Output file the line refers to, when a run has more than one. */
  file?: string;
}

export function issue(code: IssueCode, message: string, line: number | null = null, extra: Partial<Issue> = {}): Issue {
  return { code, message, severity: ISSUE_CATALOGUE[code].severity, line, ...extra };
}

export function isBlockingReview(code: IssueCode): boolean {
  return code.startsWith('REVIEW_') && ISSUE_CATALOGUE[code].severity === 'error';
}

export function errorCodes(issues: Issue[]): IssueCode[] {
  return [...new Set(issues.filter((i) => i.severity === 'error').map((i) => i.code))].sort();
}

export function sameCodeSet(a: IssueCode[], b: IssueCode[]): boolean {
  return a.length === b.length && a.every((c, i) => c === b[i]);
}
