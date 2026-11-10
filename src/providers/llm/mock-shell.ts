import { splitScript } from '@/adapters/plsql/splitter';
import { configTemplate, RUNTIME_MAIN, runtimeCore, runtimeImports, type RuntimeFeatures } from '@/adapters/shell-python/runtime';
import { commandName, parseShell, walk, type Node, type Redirect, type Simple } from '@/adapters/shell-python/shell-parser';
import type { Change, Suggestion } from '@/pipeline/types';
import { buildExpr, hasGlob, isLiteral, literalValue, parseWord, placeholderSection, pyName, pyStr, type Part } from './mock-shell-words';

/**
 * Deterministic shell → Python converter behind the mock LLM provider.
 * It covers the constructs common in Oracle/PeopleSoft wrapper scripts and marks
 * everything else explicitly (# SHELL_UNMAPPED_COMMAND / # SHELL_UNMAPPED_CONSTRUCT)
 * instead of guessing. It never executes anything.
 */
export interface ShellConversion {
  python: string;
  config: string | null;
  requirements: string;
  changes: Change[];
  suggestions: Suggestion[];
}

const KEEP_EXTERNAL = /^(psae|psdmtx|pssqr|sqr|sqrw|sqlldr|expdp|impdp|rman|exp|imp|cobrun|pscbl\.mak|PSRUN|psrun|tnsping|lsnrctl|srvctl|sqlplus|sqlplus64)$/;
const UNMAPPED_CMD = '  # SHELL_UNMAPPED_COMMAND';
const SECRET_VAR = /(PASSWORD|PASSWD|PASSPHRASE|SECRET|TOKEN|_PWD$|_PASS$|^PASS$|_PW$)/i;
const FILE_HELPERS = String.raw`

def remove_paths(patterns: Sequence[str], recursive: bool = False, force: bool = False) -> None:
    for pattern in patterns:
        matches = glob.glob(pattern)
        if not matches and not force:
            raise ScriptError(f"rm: no such file: {pattern}", 1)
        for match in matches:
            if Path(match).is_dir():
                if not recursive:
                    raise ScriptError(f"rm: is a directory: {match}", 1)
                shutil.rmtree(match)
            else:
                Path(match).unlink()


def copy_paths(sources: Sequence[str], dest: str, move: bool = False) -> None:
    files = [match for source in sources for match in (glob.glob(source) or [source])]
    for source in files:
        if move:
            shutil.move(source, dest)
        else:
            shutil.copy2(source, dest)
    LOG.info("%s %d file(s)", "Moved" if move else "Copied", len(files))


def gzip_paths(patterns: Sequence[str]) -> None:
    for pattern in patterns:
        for match in glob.glob(pattern) or [pattern]:
            with open(match, "rb") as src, gzip.open(match + ".gz", "wb") as dst:
                shutil.copyfileobj(src, dst)
            Path(match).unlink()
`;

class Emitter {
  lines: string[] = [];
  depth = 1;
  features: RuntimeFeatures = { db: false, ssh: false, ftp: false, mail: false, cmd: false };
  imports = new Set<string>();
  cfg = new Map<string, Set<string>>();
  assigned = new Set<string>();
  varSection = new Map<string, string>();
  functions = new Set<string>();
  sqlConstants: string[] = [];
  changes: Change[] = [];
  maxPositional = 0;
  usesFiles = false;
  blockSeq = 0;
  fnSeq = 0;
  unmappedConstructs = 0;
  trapNodes: Node[] = [];
  strict = false;

  emit(line: string): void {
    this.lines.push('    '.repeat(this.depth) + line);
  }
  indent<T>(fn: () => T): T {
    this.depth++;
    try {
      return fn();
    } finally {
      this.depth--;
    }
  }
  need(section: string, key: string): string {
    if (!this.cfg.has(section)) this.cfg.set(section, new Set());
    this.cfg.get(section)!.add(key);
    return `get_setting(state.cfg, ${pyStr(section)}, ${pyStr(key)})`;
  }
  change(ruleId: string, line: number, summary: string, reason: string, risk: Change['risk'] = 'low'): void {
    if (!this.changes.some((c) => c.ruleId === ruleId && c.summary === summary)) this.changes.push({ ruleId, lines: String(line), summary, reason, risk });
  }
  construct(line: number, what: string): void {
    this.unmappedConstructs++;
    this.emit(`raise NotImplementedError(${pyStr(`line ${line}: ${what}`)})  # SHELL_UNMAPPED_CONSTRUCT`);
  }

  passwordRef(name: string): string {
    const up = name.toUpperCase();
    const section = /^TARGET|FTP|SFTP|REMOTE|VENDOR|BANK/.test(up) ? 'target' : /^SOURCE/.test(up) ? 'source' : /^PS_/.test(up) ? 'peoplesoft' : /^API/.test(up) ? 'api' : 'database';
    if (!this.cfg.has(section)) this.cfg.set(section, new Set());
    this.cfg.get(section)!.add('password');
    return `get_password(state.cfg, ${pyStr(section)}, ${pyStr(up)})`;
  }

  piece = (p: Exclude<Part, { t: 'lit' }>): string => {
    if (p.t === 'bad') {
      this.unmappedConstructs++;
      return `unsupported(${pyStr(p.why)})`;
    }
    if (p.t === 'sub') return this.substitution(p.cmd);
    const name = p.name;
    if (name === '?') return 'str(rc)';
    if (name === '$') return 'str(os.getpid())';
    if (name === '0') return 'SCRIPT_NAME';
    if (name === '#') return 'str(len([a for a in vars(args).values() if a and a != args.config]))';
    if (/^[1-9]$/.test(name)) {
      this.maxPositional = Math.max(this.maxPositional, Number(name));
      const ref = `args.arg${name}`;
      return p.op && p.op.includes('-') ? `(${ref} or ${this.expr(p.arg ?? '')})` : ref;
    }
    if (name === '@' || name === '*' || name === '!') {
      this.unmappedConstructs++;
      return `unsupported(${pyStr('$' + name)})`;
    }
    if (SECRET_VAR.test(name) && !this.assigned.has(name)) return this.passwordRef(name);
    if (this.assigned.has(name)) {
      const v = pyName(name);
      return p.op && p.op.includes('-') ? `(${v} or ${this.expr(p.arg ?? '')})` : v;
    }
    if (p.op && p.op.includes('-')) return `env(${pyStr(name)}, state.cfg, ${this.expr(p.arg ?? '')})`;
    return `env(${pyStr(name)}, state.cfg)`;
  };

  /** Python string expression for a shell word. */
  expr(raw: string): string {
    return buildExpr(parseWord(raw), this.piece, (s, k) => this.need(s, k));
  }
  exprInt(raw: string): string {
    if (/^-?\d+$/.test(raw)) return raw;
    if (raw === '$?' || raw === '"$?"') return 'rc';
    return `int(${this.expr(raw)})`;
  }

  substitution(cmd: string): string {
    const nodes = parseShell(cmd);
    const n = nodes[0];
    if (nodes.length === 1 && n.type === 'simple') {
      const name = commandName(n);
      const a = n.words.slice(1);
      if (name === 'date' && a.length <= 1 && (a.length === 0 || a[0].replace(/^["']/, '').startsWith('+'))) {
        const fmt = a.length ? literalValue(parseWord(a[0])).slice(1) : '%a %b %e %H:%M:%S %Z %Y';
        return `datetime.now().strftime(${pyStr(fmt)})`;
      }
      if (name === 'basename' && a.length >= 1) return a[1] ? `Path(${this.expr(a[0])}).name.removesuffix(${this.expr(a[1])})` : `Path(${this.expr(a[0])}).name`;
      if (name === 'dirname' && a.length === 1) return `str(Path(${this.expr(a[0])}).parent)`;
      if ((name === 'hostname' || (name === 'uname' && a[0] === '-n')) && a.length <= 1) return 'socket.gethostname()';
      if (name === 'pwd') return 'os.getcwd()';
      if (name === 'whoami' || (name === 'id' && a[0] === '-un')) return 'os.environ.get("USER", "")';
      if (name === 'cat' && a.length === 1) return `Path(${this.expr(a[0])}).read_text(encoding="utf-8").strip()`;
      if (name === 'wc' && a[0] === '-l') {
        const f = a[1] ?? n.redirects.find((r) => r.op === '<')?.target;
        if (f) return `str(sum(1 for _ in open(${this.expr(f)}, encoding="utf-8", errors="replace")))`;
      }
      if (name === 'echo') return `(${a.length ? a.map((w) => this.expr(w)).join(' + " " + ') : '""'})`;
      this.features.cmd = true;
      return `run_command([${n.words.map((w) => this.expr(w)).join(', ')}]).strip()`;
    }
    if (nodes.length === 1 && n.type === 'pipeline' && n.commands.every((c) => c.type === 'simple')) {
      this.features.cmd = true;
      return `run_pipeline([${n.commands.map((c) => '[' + (c as Simple).words.map((w) => this.expr(w)).join(', ') + ']').join(', ')}]).strip()`;
    }
    this.unmappedConstructs++;
    return `unsupported(${pyStr('command substitution')})`;
  }

  section(hostWord: string): string {
    const parts = parseWord(hostWord.replace(/^[^@]*@/, ''));
    if (isLiteral(parts)) {
      const m = /(source|target)_server(_\d+)?/.exec(literalValue(parts));
      if (m) return m[1] + (m[2] ?? '');
    }
    const v = parts.find((p) => p.t === 'var');
    if (v && v.t === 'var' && this.varSection.has(v.name)) return this.varSection.get(v.name)!;
    return 'target';
  }
  useSection(section: string, withPassword = false): void {
    this.need(section, 'host');
    this.need(section, 'user');
    if (withPassword) this.cfg.get(section)!.add('password');
  }
}

function redirOut(n: { redirects: Redirect[] }): { path: string; append: boolean } | null {
  const r = n.redirects.find((x) => x.op === '>' || x.op === '>>' || x.op === '&>');
  return r && r.target !== '/dev/null' ? { path: r.target, append: r.op === '>>' } : null;
}

function translateTest(e: Emitter, words: string[]): string | null {
  let w = [...words];
  if (w[0] === '[' || w[0] === '[[' || w[0] === 'test') w = w.slice(1);
  if (w[w.length - 1] === ']' || w[w.length - 1] === ']]') w = w.slice(0, -1);
  const orParts: string[] = [];
  let cur: string[] = [];
  const groups: string[][] = [];
  for (const x of w) {
    if (x === '-o' || x === '-a') {
      groups.push(cur, [x]);
      cur = [];
    } else cur.push(x);
  }
  groups.push(cur);
  const one = (g: string[]): string | null => {
    let neg = false;
    if (g[0] === '!') {
      neg = true;
      g = g.slice(1);
    }
    let r: string | null = null;
    const f = (x: string) => e.expr(x);
    if (g.length === 2) {
      const [op, a] = g;
      const map: Record<string, string> = {
        '-f': `Path(${f(a)}).is_file()`, '-e': `Path(${f(a)}).exists()`, '-d': `Path(${f(a)}).is_dir()`, '-s': `(Path(${f(a)}).is_file() and Path(${f(a)}).stat().st_size > 0)`,
        '-r': `os.access(${f(a)}, os.R_OK)`, '-w': `os.access(${f(a)}, os.W_OK)`, '-x': `os.access(${f(a)}, os.X_OK)`, '-z': `${f(a)} == ""`, '-n': `${f(a)} != ""`, '-L': `Path(${f(a)}).is_symlink()`,
      };
      r = map[op] ?? null;
    } else if (g.length === 3) {
      const [a, op, b] = g;
      const sops: Record<string, string> = { '=': '==', '==': '==', '!=': '!=' };
      const nops: Record<string, string> = { '-eq': '==', '-ne': '!=', '-gt': '>', '-lt': '<', '-ge': '>=', '-le': '<=' };
      if (sops[op]) r = `${f(a)} ${sops[op]} ${f(b)}`;
      else if (nops[op]) r = `${e.exprInt(a)} ${nops[op]} ${e.exprInt(b)}`;
    } else if (g.length === 1) r = `${f(g[0])} != ""`;
    if (r === null) return null;
    return neg ? `not (${r})` : r;
  };
  let out = '';
  for (const g of groups) {
    if (g.length === 1 && (g[0] === '-o' || g[0] === '-a')) {
      out += g[0] === '-o' ? ' or ' : ' and ';
      continue;
    }
    const r = one(g);
    if (r === null) return null;
    out += groups.length > 1 ? `(${r})` : r;
  }
  void orParts;
  return out;
}
const isTest = (n: Node): n is Simple => n.type === 'simple' && ['[', '[[', 'test'].includes(n.words[0] ?? '');

/** Emits the statements needed to evaluate a condition and returns the Python boolean expression. */
function condition(e: Emitter, nodes: Node[]): string | null {
  if (nodes.length !== 1) {
    for (const n of nodes.slice(0, -1)) statement(e, n);
    return condition(e, nodes.slice(-1));
  }
  const n = nodes[0];
  if (isTest(n)) return translateTest(e, n.words);
  if (n.type === 'pipeline' && n.negate && n.commands.length === 1) {
    const inner = condition(e, n.commands);
    return inner === null ? null : `not (${inner})`;
  }
  if (n.type === 'andor' && [n.first, ...n.rest.map((r) => r.node)].every(isTest)) {
    let out = `(${translateTest(e, (n.first as Simple).words)})`;
    for (const r of n.rest) out += ` ${r.op === '&&' ? 'and' : 'or'} (${translateTest(e, (r.node as Simple).words)})`;
    return out.includes('null') ? null : out;
  }
  statement(e, n);
  return 'rc == 0';
}

function sqlBlock(e: Emitter, n: Simple, body: string): void {
  e.features.db = true;
  e.cfg.set('database', new Set(['user', 'password', 'dsn']));
  const id = ++e.blockSeq;
  const fn = `sql_block_${id}`;
  e.change('sqlplus-to-oracledb', n.line, `sqlplus heredoc ${id} now runs through python-oracledb on one reused connection`, 'Removes a process start and a login per block; statements use bind variables. Set [database] user, password and dsn in the config file.', 'medium');
  e.emit(`def ${fn}() -> int:`);
  e.indent(() => {
    e.emit('spool = None');
    e.emit('exit_on_error: Optional[int] = None');
    e.emit('heading, colsep = True, " "');
    let rollbackOnError = false;
    e.emit('try:');
    e.indent(() => {
      let stmt = 0;
      let explicitExit = false;
      for (const s of splitScript(body)) {
        const t = s.text.trim();
        if (s.kind === 'blank' || s.kind === 'comment') continue;
        if (s.kind === 'sqlplus') {
          let m: RegExpExecArray | null;
          if (t === '/') continue;
          if ((m = /^spo(?:ol)?\s+(.+)$/i.exec(t))) {
            if (/^off\b/i.test(m[1])) {
              e.emit('if spool is not None:');
              e.indent(() => e.emit('spool.close()'));
              e.emit('spool = None');
            } else {
              const mm = /^(\S+)(\s+app(end)?)?/i.exec(m[1])!;
              e.emit(`spool = open(${e.expr(mm[1])}, ${mm[2] ? '"a"' : '"w"'}, encoding="utf-8")`);
              e.change('spool-to-file', n.line, 'SPOOL is written by a Python file writer', 'Column formatting follows COLSEP and HEADING only; compare one output file with the original before go-live.', 'medium');
            }
          } else if ((m = /^whenever\s+sqlerror\s+(exit|continue)\s*(.*)$/i.exec(t))) {
            if (m[1].toLowerCase() === 'continue') e.emit('exit_on_error = None');
            else {
              const code = /^(\d+)/.exec(m[2])?.[1] ?? (/^(success)/i.test(m[2]) ? '0' : /^warning/i.test(m[2]) ? '2' : '1');
              rollbackOnError = /rollback/i.test(m[2]);
              e.emit(`exit_on_error = ${code === '0' ? 'None' : code}${/sql\.sqlcode/i.test(m[2]) ? '  # source used SQL.SQLCODE; non-zero is preserved, the exact value is not' : ''}`);
            }
          } else if ((m = /^set\s+(.+)$/i.exec(t))) {
            const opts = m[1];
            if (/\bhead(ing)?\s+off\b/i.test(opts) || /\bpages(ize)?\s+0\b/i.test(opts)) e.emit('heading = False');
            if (/\bhead(ing)?\s+on\b/i.test(opts)) e.emit('heading = True');
            const cs = /\bcolsep\s+(?:'([^']*)'|"([^"]*)"|(\S+))/i.exec(opts);
            if (cs) e.emit(`colsep = ${pyStr(cs[1] ?? cs[2] ?? cs[3])}`);
          } else if ((m = /^(?:exit|quit)\b\s*(\d+)?/i.exec(t))) {
            explicitExit = true;
            e.emit('db_connect(state).commit()');
            e.emit(`return ${m[1] ?? '0'}`);
          } else if ((m = /^pro(?:mpt)?\b\s?(.*)$/i.exec(t))) {
            e.emit(`LOG.info("%s", ${e.expr(JSON.stringify(m[1]))})`);
          } else if ((m = /^exec(?:ute)?\s+(.+?);?$/i.exec(t))) {
            stmt++;
            const name = `SQL_${id}_${stmt}`;
            e.sqlConstants.push(`${name} = ${pyStr(`BEGIN ${m[1]}; END;`)}`);
            e.emit(`run_sql(state, ${pyStr(`block ${id} statement ${stmt} (EXEC)`)}, ${name}, spool=spool, is_plsql=True, exit_on_error=exit_on_error)`);
          } else if (/^(@|start\b|conn(ect)?\b|host\b|!|acc(ept)?\b|def(ine)?\b)/i.test(t)) {
            e.construct(n.line, `SQL*Plus command not converted: ${t.split(/\s+/)[0]}`);
          }
          continue;
        }
        stmt++;
        let text = s.kind === 'plsql' ? s.text.replace(/\n\s*\/\s*$/, '') : s.text.replace(/;\s*$/, '');
        const binds: string[] = [];
        let bad = false;
        text = text.replace(/'\$\{?(\w+)\}?'|\$\{(\w+)\}|\$(\w+)/g, (_m, a?: string, b?: string, c?: string) => {
          const name = (a ?? b ?? c)!;
          const key = 'b_' + name.toLowerCase();
          if (!binds.some((x) => x.startsWith(`"${key}"`))) binds.push(`"${key}": ${e.piece({ t: 'var', name })}`);
          return ':' + key;
        });
        if (/[$`]\(|`/.test(text)) bad = true;
        if (bad) e.construct(n.line, 'shell command substitution inside SQL text');
        const name = `SQL_${id}_${stmt}`;
        e.sqlConstants.push(`${name} = """\\\n${text.replace(/\\/g, '\\\\').replace(/"""/g, '\\"\\"\\"')}\n"""`);
        if (binds.length) e.change('shell-vars-to-binds', n.line, 'Shell variables inside SQL text became bind variables', 'Bind variables avoid a hard parse per value and remove SQL injection through script arguments.', 'medium');
        const label = `block ${id} statement ${stmt} (${s.kind === 'plsql' ? 'PL/SQL' : s.head.split(' ')[0] || 'SQL'})`;
        e.emit(`run_sql(state, ${pyStr(label)}, ${name}${binds.length ? `, binds={${binds.join(', ')}}` : ''}, spool=spool, colsep=colsep, heading=heading, is_plsql=${s.kind === 'plsql' ? 'True' : 'False'}, exit_on_error=exit_on_error)`);
      }
      if (!explicitExit) {
        e.emit('db_connect(state).commit()  # SQL*Plus commits when the session ends');
        e.emit('return 0');
      }
    });
    e.emit('except SqlError:');
    e.indent(() => {
      e.emit(`db_connect(state).${rollbackOnError ? 'rollback' : 'commit'}()  # WHENEVER SQLERROR EXIT ${rollbackOnError ? 'ROLLBACK' : 'commits by default'}`);
      e.emit('raise');
    });
    e.emit('finally:');
    e.indent(() => {
      e.emit('if spool is not None:');
      e.indent(() => e.emit('spool.close()'));
    });
  });
  e.emit(`rc = step(state, ${pyStr(`sqlplus block ${id}`)}, ${fn})`);
}

function transferSession(e: Emitter, n: Simple, kind: 'ftp' | 'sftp', body: string): void {
  const hostWord = n.words.slice(1).find((w) => !w.startsWith('-')) ?? '';
  let section = e.section(hostWord);
  const open = /^\s*open\s+(\S+)/im.exec(body);
  if (open) section = e.section(open[1]);
  e.useSection(section, kind === 'ftp');
  if (kind === 'ftp') e.features.ftp = true;
  else e.features.ssh = true;
  const fn = `${kind}_session_${++e.fnSeq}`;
  e.emit(`def ${fn}() -> None:${kind === 'ftp' ? '  # SHELL_FTP_INSECURE' : ''}`);
  e.indent(() => {
    e.emit(kind === 'ftp' ? `ftp = ftp_session(state, ${pyStr(section)})` : `sftp = sftp_client(state, ${pyStr(section)})`);
    e.emit('local_dir = ""');
    let binary = 'True';
    for (const raw of body.split('\n')) {
      const w = raw.trim().split(/\s+/);
      const cmd = (w[0] ?? '').toLowerCase();
      const local = (x: string) => `os.path.join(local_dir, ${e.expr(x)})`;
      if (!cmd || ['user', 'open', 'bye', 'quit', 'exit', 'prompt', 'hash', 'verbose', 'passive', 'quote'].includes(cmd)) continue;
      if (cmd === 'binary' || cmd === 'bin') binary = 'True';
      else if (cmd === 'ascii' || cmd === 'asc') binary = 'False';
      else if (cmd === 'cd' && w[1]) e.emit(kind === 'ftp' ? `ftp.cwd(${e.expr(w[1])})` : `sftp.chdir(${e.expr(w[1])})`);
      else if (cmd === 'lcd' && w[1]) e.emit(`local_dir = ${e.expr(w[1])}`);
      else if ((cmd === 'put' || cmd === 'mput') && w[1]) {
        e.imports.add('import glob');
        e.emit(`for path in sorted(glob.glob(${local(w[1])})) or [${local(w[1])}]:`);
        e.indent(() => e.emit(kind === 'ftp' ? `ftp_put(state, ${pyStr(section)}, path, ${cmd === 'put' && w[2] ? e.expr(w[2]) : 'None'}, binary=${binary})` : `sftp.put(path, ${cmd === 'put' && w[2] ? e.expr(w[2]) : 'Path(path).name'})`));
      } else if ((cmd === 'get' || cmd === 'mget') && w[1]) {
        if (/[*?]/.test(w[1])) {
          e.imports.add('import fnmatch');
          e.emit(`for name in [n for n in ${kind === 'ftp' ? 'ftp.nlst()' : 'sftp.listdir()'} if fnmatch.fnmatch(n, ${e.expr(w[1])})]:`);
          e.indent(() => e.emit(kind === 'ftp' ? `ftp_get(state, ${pyStr(section)}, name, os.path.join(local_dir, name))` : 'sftp.get(name, os.path.join(local_dir, name))'));
        } else e.emit(kind === 'ftp' ? `ftp_get(state, ${pyStr(section)}, ${e.expr(w[1])}, ${local(w[2] ?? w[1])})` : `sftp.get(${e.expr(w[1])}, ${local(w[2] ?? w[1])})`);
      } else if ((cmd === 'rm' || cmd === 'delete') && w[1]) e.emit(kind === 'ftp' ? `ftp.delete(${e.expr(w[1])})` : `sftp.remove(${e.expr(w[1])})`);
      else if (cmd === 'mkdir' && w[1]) e.emit(kind === 'ftp' ? `ftp.mkd(${e.expr(w[1])})` : `sftp.mkdir(${e.expr(w[1])})`);
      else if (cmd === 'rename' && w[2]) e.emit(`${kind}.rename(${e.expr(w[1])}, ${e.expr(w[2])})`);
      else e.construct(n.line, `${kind} session command not converted: ${cmd}`);
    }
  });
  e.emit(`rc = step(state, ${pyStr(`${kind} session ([${section}])`)}, ${fn})`);
  e.change(`${kind}-to-python`, n.line, kind === 'ftp' ? 'ftp session converted to ftplib (protocol kept)' : 'sftp session converted to paramiko with host-key checking', kind === 'ftp' ? 'FTP is unencrypted; move to SFTP when the partner supports it.' : 'One SSH session is reused for all transfers; unknown host keys are rejected.', 'medium');
}

function mail(e: Emitter, n: Simple, bodyExpr: string | null): void {
  e.features.mail = true;
  let subject = '""';
  const attachments: string[] = [];
  const to: string[] = [];
  for (let i = 1; i < n.words.length; i++) {
    const w = n.words[i];
    if (w === '-s') subject = e.expr(n.words[++i] ?? '');
    else if (w === '-a' || w === '-A') attachments.push(e.expr(n.words[++i] ?? ''));
    else if (w === '-r' || w === '-c' || w === '-b' || w === '-S') i++;
    else if (!w.startsWith('-')) to.push(e.expr(w));
  }
  let body = bodyExpr ?? '""';
  const stdin = n.redirects.find((r) => r.op === '<');
  const here = n.redirects.find((r) => r.op === '<<')?.heredoc;
  if (stdin) body = stdin.target === '/dev/null' ? '""' : `Path(${e.expr(stdin.target)}).read_text(encoding="utf-8", errors="replace")`;
  else if (here) body = e.expr(JSON.stringify(here.body).replace(/\\n/g, '\n'));
  e.emit(`rc = step(state, "send mail", send_mail, state, [${to.join(', ')}], ${subject}, ${body}${attachments.length ? `, [${attachments.join(', ')}]` : ''})`);
  e.change('mailx-to-smtplib', n.line, 'mailx replaced by smtplib and email.message', 'No dependency on a local mail client; SMTP host, port and sender come from the config file.');
}

function external(e: Emitter, n: Simple, prefix = 'rc = '): void {
  e.features.cmd = true;
  const name = commandName(n);
  const out = redirOut(n);
  const stdin = n.redirects.find((r) => r.op === '<');
  const here = n.redirects.find((r) => r.op === '<<')?.heredoc;
  const kw: string[] = [];
  if (out) kw.push(`stdout_path=${e.expr(out.path)}`, ...(out.append ? ['append=True'] : []));
  if (stdin && stdin.target !== '/dev/null') kw.push(`stdin_path=${e.expr(stdin.target)}`);
  if (n.assigns.length) kw.push(`env_extra={${n.assigns.map((a) => `${pyStr(a.name)}: ${e.expr(a.value)}`).join(', ')}}`);
  if (here) {
    e.imports.add('import tempfile');
    e.emit('with tempfile.NamedTemporaryFile("w", suffix=".in", delete=False, encoding="utf-8") as handle:');
    e.indent(() => e.emit(`handle.write(${e.expr(JSON.stringify(here.body + '\n').replace(/\\n/g, '\n'))})`));
    kw.push('stdin_path=handle.name');
  }
  const keep = KEEP_EXTERNAL.test(name);
  e.emit(`${prefix}step(state, ${pyStr(name)}, run_command, [${n.words.map((w) => e.expr(w)).join(', ')}]${kw.length ? ', ' + kw.join(', ') : ''})${keep ? '' : UNMAPPED_CMD}`);
  if (here) {
    e.emit('os.unlink(handle.name)');
  }
  if (keep) e.change('external-program', n.line, `${name} is still run as an external program (subprocess.run, no shell)`, 'What the program does is not rewritten; arguments are passed as a list so nothing is interpreted by a shell.');
}

function assignment(e: Emitter, name: string, value: string, line: number): void {
  const parts = parseWord(value);
  const v = pyName(name);
  if (isLiteral(parts)) {
    const lit = literalValue(parts);
    const m = /^((?:source|target)_(?:server|user)(?:_\d+)?)$/.exec(lit);
    if (m) {
      const { section, key } = placeholderSection(m[1]);
      e.varSection.set(name, section);
      e.emit(`${v} = ${e.need(section, key)}`);
      e.assigned.add(name);
      return;
    }
  }
  if (SECRET_VAR.test(name) && !/(_FILE|_PATH|_DIR)$/i.test(name)) {
    e.emit(`${v} = ${e.passwordRef(name)}`);
    e.assigned.add(name);
    e.change('secret-to-config', line, `${name} is read from the environment or the config file`, 'Passwords never appear in the script, on the command line or in logs.');
    return;
  }
  const single = parts.length === 1 && parts[0].t === 'var' ? parts[0] : null;
  if (single && single.name === name && !e.assigned.has(name)) {
    // NAME=${NAME:-default}: resolve from the environment
    e.emit(`${v} = ${e.piece(single)}`);
  } else {
    e.emit(`${v} = ${e.expr(value)}`);
  }
  e.assigned.add(name);
}

function simple(e: Emitter, n: Simple): void {
  if (n.words.length === 0) {
    for (const a of n.assigns) assignment(e, a.name, a.value, n.line);
    return;
  }
  const name = commandName(n);
  const a = n.words.slice(1);
  const flags = a.filter((w) => /^-[A-Za-z]+$/.test(w)).join('');
  const rest = a.filter((w) => !/^-[A-Za-z]+$/.test(w));
  const out = redirOut(n);
  const here = n.redirects.find((r) => r.op === '<<')?.heredoc;
  switch (name) {
    case 'export':
    case 'typeset':
    case 'local':
    case 'readonly':
    case 'declare':
      for (const w of rest) {
        const m = /^([A-Za-z_]\w*)=([\s\S]*)$/.exec(w);
        if (m) assignment(e, m[1], m[2], n.line);
        if (name === 'export') {
          const nm = m ? m[1] : w;
          if (/^[A-Za-z_]\w*$/.test(nm) && (m || e.assigned.has(nm)) && !SECRET_VAR.test(nm)) e.emit(`os.environ[${pyStr(nm)}] = ${pyName(nm)}`);
        }
      }
      return;
    case 'echo':
    case 'print':
    case 'printf': {
      const msg = rest.length ? rest.map((w) => e.expr(w)).join(' + " " + ') : '""';
      if (out) {
        e.emit(`with open(${e.expr(out.path)}, ${out.append ? '"a"' : '"w"'}, encoding="utf-8") as handle:`);
        e.indent(() => e.emit(`handle.write(${msg} + ${name === 'printf' ? '""' : '"\\n"'})`));
      } else e.emit(`LOG.info("%s", ${msg})`);
      return;
    }
    case 'exit':
    case 'return':
      e.emit(`return ${a[0] ? e.exprInt(a[0]) : 'rc'}`);
      return;
    case ':':
    case 'true':
      e.emit('rc = 0');
      return;
    case 'false':
      e.emit('rc = 1');
      return;
    case 'set':
      if (/-\w*e/.test(a.join(' ')) || /errexit/.test(a.join(' '))) {
        e.strict = true;
        e.emit('state.strict = True  # set -e: any failing step stops the script');
      }
      return;
    case 'unset':
    case 'umask':
    case 'ulimit':
    case 'shift':
    case 'stty':
    case 'clear':
      e.emit(`# ${name} ${a.join(' ')}: no Python equivalent needed`);
      return;
    case 'trap':
      if (a[1] === 'EXIT' || a[1] === '0') {
        e.trapNodes.push(...parseShell(literalValue(parseWord(a[0]))));
        e.change('trap-to-finally', n.line, 'trap … EXIT became a try/finally cleanup', 'Cleanup runs on success, failure and exceptions.');
      } else e.emit(`# trap ${a.slice(1).join(' ')}: signals are not trapped; Python raises KeyboardInterrupt/terminates`);
      return;
    case '.':
    case 'source':
      e.emit(`LOG.info("Environment file %s must be loaded by the caller before this script starts", ${e.expr(a[0] ?? '')})${UNMAPPED_CMD}`);
      e.change('env-file', n.line, `". ${a[0] ?? ''}" is not executed`, 'A Python process cannot source a shell profile. Export the variables in the scheduler job or put them in the [env] section of the config file.', 'medium');
      return;
    case 'cd':
      e.emit(`rc = step(state, "cd", os.chdir, ${e.expr(a[0] ?? '$HOME')})`);
      return;
    case 'sleep':
      e.emit(`time.sleep(float(${e.expr(a[0] ?? '1')}))`);
      return;
    case 'mkdir':
      e.emit(`rc = step(state, "mkdir", lambda: [Path(p).mkdir(parents=${flags.includes('p') ? 'True' : 'False'}, exist_ok=${flags.includes('p') ? 'True' : 'False'}) for p in [${rest.map((w) => e.expr(w)).join(', ')}]] and 0)`);
      return;
    case 'touch':
      e.emit(`rc = step(state, "touch", lambda: [Path(p).touch() for p in [${rest.map((w) => e.expr(w)).join(', ')}]] and 0)`);
      return;
    case 'rm':
      e.usesFiles = true;
      e.emit(`rc = step(state, "rm", remove_paths, [${rest.map((w) => e.expr(w)).join(', ')}], recursive=${/[rR]/.test(flags) ? 'True' : 'False'}, force=${flags.includes('f') ? 'True' : 'False'})`);
      return;
    case 'cp':
    case 'mv':
      if (rest.length >= 2) {
        e.usesFiles = true;
        e.emit(`rc = step(state, ${pyStr(name)}, copy_paths, [${rest.slice(0, -1).map((w) => e.expr(w)).join(', ')}], ${e.expr(rest[rest.length - 1])}${name === 'mv' ? ', move=True' : ''})`);
        return;
      }
      break;
    case 'gzip':
      if (!flags.replace(/[-f9]/g, '') && rest.length) {
        e.usesFiles = true;
        e.imports.add('import gzip');
        e.emit(`rc = step(state, "gzip", gzip_paths, [${rest.map((w) => e.expr(w)).join(', ')}])`);
        return;
      }
      break;
    case 'chmod':
      if (/^[0-7]{3,4}$/.test(rest[0] ?? '')) {
        e.emit(`rc = step(state, "chmod", lambda: [os.chmod(p, 0o${rest[0]}) for p in [${rest.slice(1).map((w) => e.expr(w)).join(', ')}]] and 0)`);
        return;
      }
      break;
    case 'cat':
      if (rest.length && out) {
        e.emit(`with open(${e.expr(out.path)}, ${out.append ? '"a"' : '"w"'}, encoding="utf-8") as handle:`);
        e.indent(() => {
          e.emit(`for part in [${rest.map((w) => e.expr(w)).join(', ')}]:`);
          e.indent(() => e.emit('handle.write(Path(part).read_text(encoding="utf-8", errors="replace"))'));
        });
        return;
      }
      if (rest.length && !here) {
        e.emit(`for part in [${rest.map((w) => e.expr(w)).join(', ')}]:`);
        e.indent(() => e.emit('LOG.info("%s", Path(part).read_text(encoding="utf-8", errors="replace"))'));
        return;
      }
      if (here && out) {
        e.emit(`with open(${e.expr(out.path)}, ${out.append ? '"a"' : '"w"'}, encoding="utf-8") as handle:`);
        e.indent(() => e.emit(`handle.write(${e.expr(JSON.stringify(here.body + '\n').replace(/\\n/g, '\n'))})`));
        return;
      }
      break;
    case 'sqlplus':
    case 'sqlplus64':
      if (here) {
        sqlBlock(e, n, here.body);
        return;
      }
      break;
    case 'ssh': {
      const pos: string[] = [];
      for (let i = 0; i < a.length; i++) {
        if (a[i].startsWith('-')) {
          if (/^-[iopFJbcemSWwLRDlE]$/.test(a[i])) i++;
          continue;
        }
        pos.push(a[i]);
      }
      if (pos.length >= 2) {
        const section = e.section(pos[0]);
        e.useSection(section);
        e.features.ssh = true;
        const cmd = pos.length === 2 ? e.expr(pos[1]) : pos.slice(1).map((w) => e.expr(w)).join(' + " " + ');
        e.emit(`rc = step(state, ${pyStr(`ssh ([${section}])`)}, remote_command, state, ${pyStr(section)}, ${cmd})`);
        e.change('ssh-to-paramiko', n.line, 'ssh remote command runs through paramiko exec_command', 'Host keys are verified and one session is reused; the remote exit status is preserved.', 'medium');
        return;
      }
      break;
    }
    case 'scp': {
      const pos = a.filter((w, i) => !w.startsWith('-') && !/^-[iPoFclSJ]$/.test(a[i - 1] ?? ''));
      const dst = pos[pos.length - 1] ?? '';
      const remote = (w: string) => /^[^/\s:]+:/.test(w.replace(/^["']/, ''));
      if (pos.length >= 2 && (remote(dst) || pos.slice(0, -1).every(remote))) {
        e.features.ssh = true;
        const pathOf = (w: string) => w.replace(/^["']?[^:]+:/, '').replace(/["']$/, '') || '.';
        for (const src of pos.slice(0, -1)) {
          if (remote(dst)) {
            const section = e.section(dst.split(':')[0]);
            e.useSection(section);
            if (hasGlob(parseWord(src))) {
              e.imports.add('import glob');
              e.emit(`for path in sorted(glob.glob(${e.expr(src)})):`);
              e.indent(() => e.emit(`rc = step(state, ${pyStr(`upload to [${section}]`)}, sftp_put, state, ${pyStr(section)}, path, ${e.expr(pathOf(dst).replace(/\/?$/, '/'))})`));
            } else e.emit(`rc = step(state, ${pyStr(`upload to [${section}]`)}, sftp_put, state, ${pyStr(section)}, ${e.expr(src)}, ${e.expr(pathOf(dst))})`);
          } else {
            const section = e.section(src.split(':')[0]);
            e.useSection(section);
            e.emit(`rc = step(state, ${pyStr(`download from [${section}]`)}, sftp_get, state, ${pyStr(section)}, ${e.expr(pathOf(src))}, ${e.expr(dst)})`);
          }
        }
        e.change('scp-to-paramiko', n.line, 'scp replaced by paramiko SFTP with host-key checking', 'One SSH session is reused for every transfer; unknown host keys are rejected.', 'medium');
        return;
      }
      break;
    }
    case 'sftp':
    case 'ftp':
      if (here) {
        transferSession(e, n, name, here.body);
        return;
      }
      break;
    case 'mailx':
    case 'mail':
      mail(e, n, null);
      return;
  }
  if (e.functions.has(name)) {
    e.emit(`rc = ${pyName('fn_' + name)}()`);
    return;
  }
  external(e, n);
}

function statement(e: Emitter, n: Node): void {
  switch (n.type) {
    case 'simple':
      if (n.background) return e.construct(n.line, 'background job (&)');
      return simple(e, n);
    case 'pipeline': {
      const cmds = n.commands;
      const last = cmds[cmds.length - 1];
      if (n.negate && cmds.length === 1) {
        statement(e, cmds[0]);
        e.emit('rc = 0 if rc != 0 else 1');
        return;
      }
      if (cmds.every((c) => c.type === 'simple') && last.type === 'simple') {
        const first = cmds[0] as Simple;
        const lname = commandName(last);
        if ((lname === 'mailx' || lname === 'mail') && cmds.length === 2) {
          const fname = commandName(first);
          const fargs = first.words.slice(1).filter((w) => !/^-[a-z]$/.test(w));
          if (fname === 'echo' || fname === 'printf') return mail(e, last, fargs.length ? fargs.map((w) => e.expr(w)).join(' + " " + ') : '""');
          if (fname === 'cat' && fargs.length === 1) return mail(e, last, `Path(${e.expr(fargs[0])}).read_text(encoding="utf-8", errors="replace")`);
        }
        const firstName = commandName(first);
        if (cmds.length === 2 && (firstName === 'echo' || firstName === 'cat') && KEEP_EXTERNAL.test(lname) && !last.redirects.some((r) => r.op === '<<')) {
          // echo "..." | program  → program with that text on stdin
        }
        e.features.cmd = true;
        const out = redirOut(last);
        e.emit(`rc = step(state, ${pyStr(cmds.map((c) => commandName(c as Simple)).join(' | '))}, run_pipeline, [${cmds.map((c) => '[' + (c as Simple).words.map((w) => e.expr(w)).join(', ') + ']').join(', ')}]${out ? `, stdout_path=${e.expr(out.path)}${out.append ? ', append=True' : ''}` : ''})${UNMAPPED_CMD}`);
        e.change('pipeline-kept', n.line, 'A command pipeline is run as chained external programs (no shell)', 'The mock converter does not rewrite text pipelines into Python; review for a re/csv rewrite.', 'medium');
        return;
      }
      return e.construct(n.line, 'pipeline with compound commands');
    }
    case 'andor': {
      statement(e, n.first);
      let depthOpen = 0;
      for (const r of n.rest) {
        e.emit(`if rc ${r.op === '&&' ? '==' : '!='} 0:`);
        depthOpen++;
        e.depth++;
        statement(e, r.node);
      }
      e.depth -= depthOpen;
      return;
    }
    case 'if': {
      n.branches.forEach((b, i) => {
        if (i === 0) {
          const c = condition(e, b.cond);
          if (c === null) e.construct(n.line, 'test expression not converted');
          e.emit(`if ${c ?? 'False'}:`);
          e.indent(() => block(e, b.body));
        } else {
          e.emit('else:');
          e.depth++;
          const c = condition(e, b.cond);
          if (c === null) e.construct(n.line, 'test expression not converted');
          e.emit(`if ${c ?? 'False'}:`);
          e.indent(() => block(e, b.body));
        }
      });
      if (n.otherwise) {
        e.emit('else:');
        e.indent(() => block(e, n.otherwise!));
      }
      e.depth -= n.branches.length - 1;
      return;
    }
    case 'for': {
      const v = pyName(n.variable);
      e.assigned.add(n.variable);
      const items = n.items.map((w) => {
        const parts = parseWord(w);
        if (hasGlob(parts)) {
          e.imports.add('import glob');
          return `*sorted(glob.glob(${e.expr(w)}))`;
        }
        if (!/^["']/.test(w) && parts.length === 1 && parts[0].t !== 'lit') return `*${e.expr(w)}.split()`;
        return e.expr(w);
      });
      e.emit(`for ${v} in [${items.join(', ')}]:`);
      e.indent(() => block(e, n.body));
      return;
    }
    case 'while': {
      const c0 = n.cond[0];
      const input = n.redirects.find((r) => r.op === '<');
      if (!n.until && n.cond.length === 1 && c0.type === 'simple' && c0.words[0] === 'read' && input) {
        const vars = c0.words.slice(1).filter((w) => !w.startsWith('-'));
        vars.forEach((x) => e.assigned.add(x));
        e.emit(`with open(${e.expr(input.target)}, encoding="utf-8", errors="replace") as handle:`);
        e.indent(() => {
          e.emit('for raw_line in handle:');
          e.indent(() => {
            if (vars.length <= 1) e.emit(`${pyName(vars[0] ?? 'REPLY')} = raw_line.rstrip("\\n")`);
            else {
              e.emit(`fields = raw_line.split(None, ${vars.length - 1})`);
              vars.forEach((x, i) => e.emit(`${pyName(x)} = fields[${i}].rstrip("\\n") if len(fields) > ${i} else ""`));
            }
            block(e, n.body);
          });
        });
        return;
      }
      if (n.cond.length === 1 && isTest(c0)) {
        const t = translateTest(e, c0.words);
        if (t !== null) {
          e.emit(`while ${n.until ? `not (${t})` : t}:`);
          e.indent(() => block(e, n.body));
          return;
        }
      }
      return e.construct(n.line, 'while loop condition not converted');
    }
    case 'case': {
      const subj = e.expr(n.subject);
      e.imports.add('import fnmatch');
      let first = true;
      for (const arm of n.arms) {
        const pats = arm.patterns.filter((x) => x !== '|');
        if (pats.length === 1 && pats[0] === '*') e.emit(first ? 'if True:' : 'else:');
        else e.emit(`${first ? 'if' : 'elif'} any(fnmatch.fnmatchcase(${subj}, pattern) for pattern in [${pats.map((x) => e.expr(x)).join(', ')}]):`);
        e.indent(() => block(e, arm.body));
        first = false;
      }
      return;
    }
    case 'function': {
      e.functions.add(n.name);
      const assignedInside = new Set<string>();
      let usesArgs = false;
      walk(n.body, (x) => {
        if (x.type === 'simple') {
          x.assigns.forEach((as) => assignedInside.add(as.name));
          if (x.words.concat(x.assigns.map((as) => as.value)).some((w) => /\$\{?[1-9@*]/.test(w))) usesArgs = true;
        }
      });
      e.emit(`def ${pyName('fn_' + n.name)}() -> int:`);
      e.indent(() => {
        const outer = [...assignedInside].filter((x) => e.assigned.has(x)).map(pyName);
        e.emit(`nonlocal rc${outer.length ? ', ' + outer.join(', ') : ''}`);
        if (usesArgs) e.construct(n.line, `function ${n.name} uses positional arguments`);
        block(e, n.body);
        e.emit('return rc');
      });
      return;
    }
    case 'group':
      if (n.subshell) return e.construct(n.line, 'subshell ( … )');
      if (n.redirects.some((r) => r.op === '>' || r.op === '>>')) e.emit('# output redirection of this { … } group is replaced by the script log');
      return block(e, n.body, false);
    case 'unparsed':
      return e.construct(n.line, n.text);
  }
}

function block(e: Emitter, nodes: Node[], needBody = true): void {
  const before = e.lines.length;
  for (const n of nodes) statement(e, n);
  if (needBody && e.lines.length === before) e.emit('pass');
}

function header(source: string): { purpose: string[]; cron: string[]; shell: string } {
  const lines = source.split('\n');
  const shell = /^#!\s*\S*?(ksh|bash|sh)\b/.exec(lines[0] ?? '')?.[1] ?? 'sh';
  const purpose: string[] = [];
  const cron: string[] = [];
  for (const l of lines.slice(0, 60)) {
    if (!l.startsWith('#')) {
      if (l.trim() === '' && purpose.length === 0) continue;
      if (!l.startsWith('#')) break;
    }
    if (l.startsWith('#!')) continue;
    const t = l.replace(/^#+\s?/, '').trimEnd();
    if (/^[-=*#\s]*$/.test(t)) continue;
    if (/(^|\s)(cron|crontab)\b.*[\d*]/i.test(t) || /^\s*([\d*/,-]+\s+){5}\S+/.test(t)) cron.push(t.trim());
    else purpose.push(t);
  }
  return { purpose: purpose.slice(0, 25), cron, shell };
}

export function mockConvertShell(source: string, opts: { generateConfig: boolean; note?: string | null }): ShellConversion {
  const e = new Emitter();
  const nodes = parseShell(source);
  // functions must be known before calls are translated
  walk(nodes, (n) => {
    if (n.type === 'function') e.functions.add(n.name);
  });
  const body = new Emitter();
  Object.assign(body, { functions: e.functions });
  const main = body;
  main.emit('rc = 0');
  const bodyStart = main.lines.length;
  block(main, nodes, false);
  if (main.unmappedConstructs > 0 || main.lines.some((l) => l.includes('unsupported('))) {
    main.lines.splice(bodyStart, 0, '    def unsupported(what: str) -> str:', '        raise NotImplementedError(what)  # SHELL_UNMAPPED_CONSTRUCT', '');
  }
  let jobLines = main.lines;
  if (main.trapNodes.length) {
    const cleanup = new Emitter();
    Object.assign(cleanup, { features: main.features, imports: main.imports, cfg: main.cfg, assigned: main.assigned, varSection: main.varSection, functions: main.functions, changes: main.changes });
    block(cleanup, main.trapNodes);
    main.usesFiles ||= cleanup.usesFiles;
    jobLines = ['    try:', ...main.lines.map((l) => '    ' + l), '        return rc', '    finally:', ...cleanup.lines.map((l) => '    ' + l.replace(/^(\s*)rc = step\(/, '$1step(').replace(/^(\s*)return .*$/, '$1pass'))];
  } else jobLines = [...main.lines, '    return rc'];

  const h = header(source);
  const exits = [...new Set((source.match(/^\s*(?:.*[;&|]\s*)?exit\s+(\d+)/gm) ?? []).map((x) => Number(/(\d+)\s*$/.exec(x)![1])))].filter((x) => x !== 0).sort((a, b) => a - b);
  const doc = [
    `"""${(h.purpose[0] ?? 'Converted job').replace(/"/g, "'")}`,
    '',
    ...h.purpose.slice(1).map((l) => l.replace(/"""/g, "'''").replace(/\\/g, '/')),
    ...(h.purpose.length > 1 ? [''] : []),
    `Origin: converted from a ${h.shell} script (sanitized).`,
    `Arguments: --config PATH (or SCRIPT_CONFIG)${main.maxPositional ? '; ' + Array.from({ length: main.maxPositional }, (_, i) => `arg${i + 1}`).join(', ') + ' are the positional arguments $1..$' + main.maxPositional + ' of the original script' : ''}.`,
    `Exit codes: 0 success${exits.length ? '; ' + exits.join(', ') + ' as in the original script' : ''}; 1 unexpected error; 2 configuration error.`,
    `Original schedule: ${h.cron.length ? h.cron.join(' | ').replace(/\\/g, '/') : 'not recorded in the source'}.`,
    '"""',
  ];
  if (main.usesFiles) {
    main.imports.add('import glob');
    main.imports.add('import shutil');
  }
  const parse = [
    '',
    '',
    'def parse_args(argv: Optional[Sequence[str]] = None) -> argparse.Namespace:',
    '    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])',
    '    parser.add_argument("--config", default=None, help="path to config.ini (default: SCRIPT_CONFIG)")',
    ...Array.from({ length: main.maxPositional }, (_, i) => `    parser.add_argument("arg${i + 1}", nargs="?", default="", help="positional argument ${i + 1} of the original script")`),
    '    return parser.parse_args(argv)',
  ];
  const python = [
    '#!/usr/bin/env python3',
    ...doc,
    'from __future__ import annotations',
    '',
    runtimeImports(main.features, [...main.imports]),
    runtimeCore(main.features).trimEnd(),
    ...(main.usesFiles ? [FILE_HELPERS.trimEnd()] : []),
    ...(main.sqlConstants.length ? ['', '', ...main.sqlConstants.flatMap((c) => [c, ''])].slice(0, -1) : []),
    ...parse,
    '',
    '',
    'def job(state: RunState, args: argparse.Namespace) -> int:',
    '    """The converted script. Returns the exit code the scheduler sees."""',
    ...jobLines,
    RUNTIME_MAIN.trimEnd(),
    '',
  ].join('\n');

  const changes: Change[] = [
    { ruleId: 'python-standard-runtime', lines: '1', summary: 'Standard runtime added: config file, rotating log, central error capture, failure email to ops@script.com', reason: 'Every converted script reports failures the same way and keeps the original exit code.', risk: 'low' },
    ...main.changes,
  ];
  if (main.strict) changes.push({ ruleId: 'set-e', lines: '1', summary: 'set -e became strict mode (the first failing step raises)', reason: 'Same stop-on-first-error behaviour.', risk: 'low' });
  if (opts.note) changes.push({ ruleId: 'reviewer-note', lines: '-', summary: `Reviewer note recorded: ${opts.note}`, reason: 'The mock provider cannot act on free text; the note is kept for the human reviewer and the learning loop.', risk: 'low' });
  const needsConfig = opts.generateConfig || main.features.db || main.features.ssh || main.features.ftp;
  const req = [...(main.features.db ? ['oracledb>=2.0'] : []), ...(main.features.ssh ? ['paramiko>=3.4'] : [])];
  const suggestions: Suggestion[] = [];
  if (main.features.ftp) suggestions.push({ title: 'Move FTP transfers to SFTP', detail: 'FTP sends the password and the file in clear text. The converted script keeps FTP because the source used it.' });
  return { python, config: needsConfig ? configTemplate(main.cfg) : null, requirements: req.length ? req.join('\n') + '\n' : '# standard library only\n', changes, suggestions };
}
