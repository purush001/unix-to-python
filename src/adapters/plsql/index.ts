import { OUTPUT_FORMAT } from '@/agents/format';
import { Codes } from '@/pipeline/issue-codes';
import { captureBlock } from './blocks';
import { COMPAT_RULES_VERSION } from './compat';
import { PLSQL_VALIDATOR_VERSION, validatePlsql } from './validators';
import { DATA_GUARD, guidanceBlock, REVIEW_FORMAT, type PlatformAdapter } from '../types';

const SYSTEM = `You are sql-agent, an Oracle and PeopleSoft migration specialist. You convert one Oracle 19c SQL, PL/SQL or SQL*Plus unit so that the SAME text compiles and behaves identically on Oracle Database 19c (any release update) and Oracle AI Database 26ai.

${DATA_GUARD}

Rules
1. Dual compatibility is mandatory. Allowed syntax is the intersection of both releases. Never emit syntax that exists only in 26ai or only in later 19c release updates: IF [NOT] EXISTS in DDL, SELECT without FROM DUAL, UPDATE/DELETE with a FROM join, GROUP BY on a column alias, GROUP BY ALL, QUALIFY, multi-row VALUES, the SQL BOOLEAN, VECTOR and JSON data types, SQL macros, EXCEPT, schema-level grants, annotations, and functions added after base 19c (for example ANY_VALUE, JSON_TRANSFORM, BIT_AND_AGG, CHECKSUM, UUID, DATEADD).
2. Replace features that are desupported in 26ai with a form that works on both releases (traditional AUDIT/NOAUDIT statements -> unified audit policies; DBMS_OBFUSCATION_TOOLKIT -> DBMS_CRYPTO; UTL_FILE_DIR paths -> directory objects; DBMS_XMLSAVE/DBMS_XMLQUERY -> SQL/XML; DBMS_XSLPROCESSOR.CLOB2FILE -> DBMS_LOB.CLOB2FILE). If PL/SQL has no single common form, use conditional compilation on DBMS_DB_VERSION ($IF DBMS_DB_VERSION.VER_LE_19 $THEN ... $ELSE ... $END; never reference VER_LE_20 or higher) and explain the branch. If plain SQL has no common form, keep the 19c form and say so in the change list.
3. Preserve results, side effects, transaction boundaries (never add, remove or move COMMIT/ROLLBACK; keep a COMMIT inside a loop), error behaviour and SQL*Plus exit codes. Keep every & substitution variable and bind variable. Never rename PeopleSoft objects (PS_* records, SYSADM objects, PeopleTools tables) or columns.
4. Make the smallest change that achieves the goal. Code that is already valid on both releases and efficient stays as it is.
5. Performance, only with techniques that behave the same on both releases: set-based SQL instead of row-by-row loops where the logic allows; otherwise BULK COLLECT with LIMIT and FORALL (SAVE EXCEPTIONS when the original continued past row errors); bind variables instead of concatenated literals in dynamic SQL; sargable predicates; joins, analytic functions or MERGE instead of repeated scalar subqueries; EXISTS instead of COUNT(*) existence checks. Do NOT add hints, parallel clauses, indexes or other DDL - list those as suggestions.
6. Error capture. In the outermost block of every PL/SQL unit the script owns, the WHEN OTHERS handler must start with exactly this block, then RAISE (unless the source handler deliberately swallowed the error, in which case keep that behaviour and still add the block):
${captureBlock('    ')}
    RAISE;
   Create no tables or other objects for logging. For SQL*Plus scripts put SET SERVEROUTPUT ON SIZE UNLIMITED before the first statement and keep the SPOOL. Do not add WHENEVER SQLERROR EXIT where the original continued past errors - suggest it instead.
7. 26ai-only improvements go in <suggestions> with a title starting "After 19c is retired:". For PeopleSoft-delivered objects add that certification with PeopleTools 8.62 must be checked on My Oracle Support first. Never apply them.
8. Every change appears in <changes> with a rule id, the output lines, a one-line summary, the reason and a risk level.

${OUTPUT_FORMAT}`;

const HINTS: PlatformAdapter['repairHints'] = {
  [Codes.SQL_PARSE_ERROR]: 'Fix the structure reported: balance BEGIN/END, IF/END IF, LOOP/END LOOP, quotes and parentheses; end SQL statements with ";" and PL/SQL units with a line containing only "/".',
  [Codes.SQL_NOT_DUAL_COMPATIBLE]: 'Rewrite the flagged construct to the form that works on every 19c release update and on 26ai, exactly as the message says. Move the 26ai form to <suggestions>.',
  [Codes.SQL_DESUPPORTED_FEATURE]: 'Replace the desupported feature with the replacement named in the message; it must exist on 19c and 26ai.',
  [Codes.SQL_NO_ERROR_CAPTURE]: 'Add the standard capture block at the start of the WHEN OTHERS handler of the outermost block and re-raise with RAISE; add SET SERVEROUTPUT ON SIZE UNLIMITED before the first statement.',
  [Codes.SQL_STATEMENT_LOST]: 'Restore the statement that references the missing object, or explain its removal in the change list naming the object.',
  [Codes.SQL_SUBSTITUTION_LOST]: 'Restore the missing & substitution or : bind variable exactly as in the source.',
  [Codes.SECRET_IN_OUTPUT]: 'Remove the literal secret; use the &&db_password substitution variable or an environment reference.',
  [Codes.SANITIZE_LEAK_DETECTED]: 'Use only the placeholders present in the source; do not introduce hosts, users, names or email addresses.',
  [Codes.REVIEW_TXN_BOUNDARY_CHANGED]: 'Put every COMMIT and ROLLBACK back exactly where the source has it.',
  [Codes.REVIEW_SEMANTIC_DRIFT]: 'Make the flagged part behave exactly like the source.',
  [Codes.REVIEW_STATEMENT_LOST]: 'Restore the statement the reviewer found missing.',
  [Codes.REVIEW_EXIT_CODE_CHANGED]: 'Restore the original WHENEVER SQLERROR / EXIT behaviour.',
};

export const plsqlAdapter: PlatformAdapter = {
  platform: 'plsql',
  agentName: 'sql-agent',
  outputExt: 'sql',
  validatorVersion: `${PLSQL_VALIDATOR_VERSION}+rules.${COMPAT_RULES_VERSION}`,
  systemPrompt: () => SYSTEM,
  generatePrompt: (i) =>
    `${i.embedded ? 'This unit is the body of a sqlplus heredoc inside a shell script. Shell variables such as $VAR or ${VAR} must stay exactly as they are.\n' : ''}${guidanceBlock(i.guidance)}${i.note ? `\nReviewer note for this revision (apply it unless it conflicts with the rules): ${i.note}\n` : ''}\nConvert this unit:\n<source>\n${i.source}\n</source>`,
  repairPrompt: (i) =>
    `Your previous draft failed validation. Fix every issue below and return the complete corrected unit.\n\nIssues:\n${i.issues.map((x) => `- ${x.code}${x.line ? ` (line ${x.line})` : ''}: ${x.message}${HINTS[x.code] ? `\n  How to fix: ${HINTS[x.code]}` : ''}`).join('\n')}\n${guidanceBlock(i.guidance)}\n<source>\n${i.source}\n</source>\n<draft>\n${i.draft}\n</draft>`,
  reviewPrompt: (i) =>
    `You are an independent reviewer. You cannot edit the script. Compare the sanitized source with the converted draft and report only real problems: semantic drift, lost statements, changed transaction boundaries, changed SQL*Plus exit codes. Added error-capture handlers that re-raise and SET SERVEROUTPUT ON are expected and are not problems.\n${DATA_GUARD}\n\n${REVIEW_FORMAT}\n\n<source>\n${i.source}\n</source>\n<draft>\n${i.draft}\n</draft>`,
  validate: async (v) => validatePlsql(v),
  repairHints: HINTS,
  parses: (issues) => !issues.some((i) => i.code === Codes.SQL_PARSE_ERROR),
};
