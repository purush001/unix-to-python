import { Codes, issue, type Issue } from '@/pipeline/issue-codes';
import { parsePython, walkPy, type PyNode } from './python-parser';
import { shellExitCodes } from './shell-parser';

export const PYTHON_VALIDATOR_VERSION = '1.0.0';
export const PYTHON_SYNTAX_CHECKER = 'tree-sitter-python (wasm)';

const lineOf = (n: PyNode) => n.startPosition.row + 1;
const colOf = (n: PyNode) => n.startPosition.column + 1;

export interface PyFacts {
  syntaxErrors: Issue[];
  calls: { name: string; node: PyNode }[];
  keywordArgs: { name: string; value: string; node: PyNode }[];
  imports: Set<string>;
  functions: Set<string>;
  intLiteralsInExits: Set<number>;
  strings: { text: string; node: PyNode; docstring: boolean }[];
  comments: { text: string; line: number }[];
  hasDocstring: boolean;
}

export async function pythonFacts(source: string): Promise<PyFacts> {
  const { root, release } = await parsePython(source);
  try {
    const f: PyFacts = { syntaxErrors: [], calls: [], keywordArgs: [], imports: new Set(), functions: new Set(), intLiteralsInExits: new Set(), strings: [], comments: [], hasDocstring: false };
    const first = root.namedChildren.find((c) => c && c.type !== 'comment');
    f.hasDocstring = !!first && first.type === 'expression_statement' && first.namedChildren[0]?.type === 'string';
    const ints = (n: PyNode) => {
      walkPy(n, (x) => {
        if (x.type === 'integer' && /^\d+$/.test(x.text)) f.intLiteralsInExits.add(Number(x.text));
      });
    };
    walkPy(root, (n) => {
      if (n.type === 'ERROR' || n.isMissing) {
        const near = n.isMissing ? `missing ${n.type}` : `unexpected ${JSON.stringify(n.text.split('\n')[0].slice(0, 40))}`;
        if (f.syntaxErrors.length < 20) f.syntaxErrors.push(issue(Codes.PY_SYNTAX_ERROR, `Python syntax error: ${near}`, lineOf(n), { column: colOf(n) }));
        return;
      }
      switch (n.type) {
        case 'comment':
          f.comments.push({ text: n.text, line: lineOf(n) });
          break;
        case 'import_statement':
        case 'import_from_statement':
          for (const m of n.text.matchAll(/\b(?:import|from)\s+([\w.]+)/g)) f.imports.add(m[1].split('.')[0]);
          for (const m of n.text.matchAll(/\bimport\s+(.+)$/g)) for (const x of m[1].split(',')) f.imports.add(x.trim().split(/\s+/)[0].split('.')[0]);
          break;
        case 'function_definition': {
          const name = n.childForFieldName('name')?.text;
          if (name) f.functions.add(name);
          break;
        }
        case 'call': {
          const fn = n.childForFieldName('function');
          if (fn) f.calls.push({ name: fn.text, node: n });
          if (fn && /^(sys\.exit|exit|ScriptError|CommandError)$/.test(fn.text)) ints(n);
          break;
        }
        case 'keyword_argument': {
          const name = n.childForFieldName('name')?.text ?? '';
          const value = n.childForFieldName('value');
          f.keywordArgs.push({ name, value: value?.text ?? '', node: n });
          if (/exit/.test(name) && value) ints(value);
          break;
        }
        case 'return_statement':
          ints(n);
          break;
        case 'assignment': {
          const left = n.childForFieldName('left')?.text ?? '';
          const right = n.childForFieldName('right');
          if (/exit|^rc$|code/i.test(left) && right) ints(right);
          break;
        }
        case 'string':
          f.strings.push({ text: n.text, node: n, docstring: n.parent?.type === 'expression_statement' });
          break;
      }
    });
    return f;
  } finally {
    release();
  }
}

export interface PyValidateInput {
  source: string;
  draft: string;
}

/** Section 10.4 validators. Parses only; never runs the script. */
export async function validatePython(v: PyValidateInput): Promise<Issue[]> {
  const out: Issue[] = [];
  const f = await pythonFacts(v.draft);
  out.push(...f.syntaxErrors);
  const text = v.draft;
  const has = (re: RegExp) => re.test(text);

  for (const c of f.calls) {
    if (/^(os\.system|os\.popen|eval|exec|commands\.getoutput|subprocess\.getoutput|subprocess\.getstatusoutput)$/.test(c.name)) {
      out.push(issue(Codes.PY_SHELL_TRUE, `${c.name}() is not allowed; use subprocess.run with an argument list and shell=False.`, lineOf(c.node), { column: colOf(c.node) }));
    }
  }
  for (const k of f.keywordArgs) {
    if (k.name === 'shell' && k.value !== 'False') out.push(issue(Codes.PY_SHELL_TRUE, 'shell=True is not allowed; pass an argument list with shell=False.', lineOf(k.node), { column: colOf(k.node) }));
  }

  if (!f.hasDocstring || !f.functions.has('main') || !has(/if __name__ == ["']__main__["']:\s*\n\s+sys\.exit\(main\(\)\)/)) {
    out.push(issue(Codes.PY_STRUCTURE, 'Expected a module docstring, a main() that returns the exit code, and sys.exit(main()) under the __main__ guard.', 1));
  }
  if (!f.imports.has('logging') || !has(/RotatingFileHandler\(/) || !has(/StreamHandler\(/) || !has(/%\(lineno\)d/)) {
    out.push(issue(Codes.PY_NO_LOGGING, 'Logging must use a RotatingFileHandler and a console handler with timestamp, level, run ID, file:line and message.', 1));
  }
  if (!f.imports.has('smtplib') || !has(/ops@script\.com/) || !has(/FAILED/) || !f.functions.has('send_failure_email')) {
    out.push(issue(Codes.PY_NO_ERROR_EMAIL, 'A failure must email ops@script.com (subject: script name, FAILED, failing line, run ID).', 1));
  }
  if (!f.functions.has('build_error_record') || !f.imports.has('traceback') || !has(/extract_tb|walk_tb|tb_lineno/)) {
    out.push(issue(Codes.PY_NO_ERROR_CAPTURE, 'A central handler must build an error record with the failing line number and message (build_error_record).', 1));
  }
  if (f.imports.has('oracledb')) {
    if (!has(/\boffset\b/) || !has(/full_code|\bcode\b/)) out.push(issue(Codes.PY_NO_ERROR_CAPTURE, 'Database errors must record the Oracle code, message and the offset converted to a line in the statement.', 1));
    if (!has(/dbms_output\.enable/i) || !has(/dbms_output\.get_lines?/i)) out.push(issue(Codes.PY_NO_ERROR_CAPTURE, 'PL/SQL run from Python must enable DBMS_OUTPUT and read it after a failure.', 1));
  }
  if (f.imports.has('subprocess') && !has(/stderr/)) out.push(issue(Codes.PY_NO_ERROR_CAPTURE, 'External command failures must record the command name, exit code and the last lines of stderr.', 1));
  if (!f.imports.has('configparser') || !has(/SCRIPT_CONFIG/) || !has(/--config/)) {
    out.push(issue(Codes.PY_NO_CONFIG, 'Settings must come from the config file given by --config or SCRIPT_CONFIG.', 1));
  }
  if (f.imports.has('paramiko') && has(/AutoAddPolicy|WarningPolicy/)) {
    out.push(issue(Codes.PY_HARDCODED_ENDPOINT, 'SSH host-key checking must stay on (RejectPolicy with known hosts); AutoAddPolicy is not allowed.', text.split('\n').findIndex((l) => /AutoAddPolicy|WarningPolicy/.test(l)) + 1));
  }

  // Exit codes used by the shell script must still be returned.
  for (const [codeN, srcLine] of shellExitCodes(v.source)) {
    if (codeN !== 0 && !f.intLiteralsInExits.has(codeN)) out.push(issue(Codes.PY_EXIT_CODE_CHANGED, `The shell script exits with ${codeN} (line ${srcLine}); the Python script never returns ${codeN}.`, null, { sourceLine: srcLine }));
  }

  // Hosts, users and credentials belong in the config file.
  for (const s of f.strings) {
    if (s.docstring) continue;
    const m = /\b((?:source|target)_(?:server|user)(?:_\d+)?)\b/.exec(s.text);
    if (m && !/get_setting|fallback/.test(s.node.parent?.parent?.text.slice(0, 200) ?? '')) {
      out.push(issue(Codes.PY_HARDCODED_ENDPOINT, `${m[1]} is written in the script; read it from the config file instead.`, lineOf(s.node), { column: colOf(s.node) }));
    }
  }

  // Markers written by the converter.
  for (const c of f.comments) {
    if (/SHELL_UNMAPPED_COMMAND/.test(c.text)) out.push(issue(Codes.SHELL_UNMAPPED_COMMAND, 'This command has no Python mapping and runs as an external program.', c.line));
    if (/SHELL_UNMAPPED_CONSTRUCT/.test(c.text)) out.push(issue(Codes.SHELL_UNMAPPED_CONSTRUCT, 'This part of the shell script was not converted.', c.line));
    if (/SHELL_FTP_INSECURE/.test(c.text)) out.push(issue(Codes.SHELL_FTP_INSECURE, 'FTP is kept as in the source; it is not encrypted. Prefer SFTP.', c.line));
  }
  if (f.imports.has('ftplib') && !f.comments.some((c) => /SHELL_FTP_INSECURE/.test(c.text))) {
    out.push(issue(Codes.SHELL_FTP_INSECURE, 'FTP is kept as in the source; it is not encrypted. Prefer SFTP.', text.split('\n').findIndex((l) => /ftplib\.FTP/.test(l)) + 1 || 1));
  }
  return out;
}
