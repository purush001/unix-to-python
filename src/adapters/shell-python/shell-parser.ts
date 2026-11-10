/**
 * A small POSIX/ksh/bash parser: enough structure for classification, splitting
 * out sqlplus heredocs, exit-code checks and the mock converter. It never executes anything.
 */
export interface Redirect {
  op: '>' | '>>' | '<' | '<<' | '2>' | '2>>' | '2>&1' | '>&2' | '&>' | '<<<';
  target: string;
  heredoc?: { body: string; delimiter: string; quoted: boolean; startLine: number; endLine: number };
}
export interface Simple {
  type: 'simple';
  assigns: { name: string; value: string }[];
  words: string[];
  redirects: Redirect[];
  line: number;
  background?: boolean;
}
export interface Pipeline {
  type: 'pipeline';
  negate: boolean;
  commands: Node[];
  line: number;
}
export interface AndOr {
  type: 'andor';
  first: Node;
  rest: { op: '&&' | '||'; node: Node }[];
  line: number;
}
export interface If {
  type: 'if';
  branches: { cond: Node[]; body: Node[] }[];
  otherwise: Node[] | null;
  line: number;
}
export interface For {
  type: 'for';
  variable: string;
  items: string[];
  body: Node[];
  line: number;
}
export interface While {
  type: 'while';
  until: boolean;
  cond: Node[];
  body: Node[];
  redirects: Redirect[];
  line: number;
}
export interface Case {
  type: 'case';
  subject: string;
  arms: { patterns: string[]; body: Node[] }[];
  line: number;
}
export interface Func {
  type: 'function';
  name: string;
  body: Node[];
  line: number;
}
export interface Group {
  type: 'group';
  subshell: boolean;
  body: Node[];
  redirects: Redirect[];
  line: number;
}
export interface Unparsed {
  type: 'unparsed';
  text: string;
  line: number;
}
export type Node = Simple | Pipeline | AndOr | If | For | While | Case | Func | Group | Unparsed;

interface Tok {
  kind: 'word' | 'op' | 'nl';
  text: string;
  line: number;
  heredoc?: Redirect['heredoc'];
}

const OPS = ['2>&1', '<<<', '<<-', '&&', '||', ';;', '>>', '<<', '2>>', '>&2', '1>&2', '&>', '2>', '>', '<', '|', ';', '&', '(', ')'];

export function lexShell(src: string): Tok[] {
  const toks: Tok[] = [];
  const text = src.replace(/\r\n?/g, '\n');
  let i = 0;
  let line = 1;
  const pendingHeredocs: { tok: Tok; delimiter: string; strip: boolean; quoted: boolean }[] = [];
  const n = text.length;

  const readWord = (): string => {
    const start = i;
    while (i < n) {
      const c = text[i];
      if (c === '\\') {
        if (text[i + 1] === '\n') line++;
        i += 2;
        continue;
      }
      if (c === "'") {
        const e = text.indexOf("'", i + 1);
        const end = e === -1 ? n - 1 : e;
        line += (text.slice(i, end).match(/\n/g) ?? []).length;
        i = end + 1;
        continue;
      }
      if (c === '"') {
        i++;
        while (i < n && text[i] !== '"') {
          if (text[i] === '\\') i++;
          else if (text[i] === '\n') line++;
          else if (text[i] === '$' && text[i + 1] === '(') {
            i = skipParen(i + 1);
            continue;
          }
          i++;
        }
        i++;
        continue;
      }
      if (c === '`') {
        const e = text.indexOf('`', i + 1);
        i = (e === -1 ? n - 1 : e) + 1;
        continue;
      }
      if (c === '$' && text[i + 1] === '(') {
        i = skipParen(i + 1);
        continue;
      }
      if (c === '$' && text[i + 1] === '{') {
        const e = text.indexOf('}', i);
        i = (e === -1 ? n - 1 : e) + 1;
        continue;
      }
      if (/[\s;|&()<>]/.test(c)) break;
      i++;
    }
    return text.slice(start, i);
  };
  const skipParen = (at: number): number => {
    let depth = 0;
    let k = at;
    for (; k < n; k++) {
      if (text[k] === '(') depth++;
      else if (text[k] === ')') {
        depth--;
        if (depth === 0) return k + 1;
      } else if (text[k] === '\n') line++;
    }
    return n;
  };

  while (i < n) {
    const c = text[i];
    if (c === '\n') {
      toks.push({ kind: 'nl', text: '\n', line });
      line++;
      i++;
      // heredoc bodies start after the newline
      for (const h of pendingHeredocs.splice(0)) {
        const startLine = line;
        const bodyLines: string[] = [];
        while (i < n) {
          let e = text.indexOf('\n', i);
          if (e === -1) e = n;
          const raw = text.slice(i, e);
          i = Math.min(n, e + 1);
          line++;
          if ((h.strip ? raw.replace(/^\t+/, '') : raw) === h.delimiter) break;
          bodyLines.push(raw);
        }
        h.tok.heredoc = { body: bodyLines.join('\n'), delimiter: h.delimiter, quoted: h.quoted, startLine, endLine: startLine + bodyLines.length - 1 };
      }
      continue;
    }
    if (c === ' ' || c === '\t') {
      i++;
      continue;
    }
    if (c === '\\' && text[i + 1] === '\n') {
      i += 2;
      line++;
      continue;
    }
    if (c === '#' && (i === 0 || /[\s;]/.test(text[i - 1]))) {
      while (i < n && text[i] !== '\n') i++;
      continue;
    }
    const op = OPS.find((o) => text.startsWith(o, i) && !(o === '2>' && /\w/.test(text[i - 1] ?? '')) && !((o === '2>&1' || o === '2>>' ) && /\w/.test(text[i - 1] ?? '')));
    if (op && !(op === '(' && text[i + 1] === '(')) {
      const t: Tok = { kind: 'op', text: op === '1>&2' ? '>&2' : op, line };
      toks.push(t);
      i += op.length;
      if (op === '<<' || op === '<<-') {
        while (text[i] === ' ' || text[i] === '\t') i++;
        const raw = readWord();
        const delimiter = raw.replace(/^['"\\]+|['"]+$/g, '');
        t.text = '<<';
        pendingHeredocs.push({ tok: t, delimiter, strip: op === '<<-', quoted: /['"\\]/.test(raw) });
      }
      continue;
    }
    const w = readWord();
    if (w === '') {
      i++;
      continue;
    }
    toks.push({ kind: 'word', text: w, line });
  }
  return toks;
}

const TERMINATORS = new Set(['then', 'fi', 'elif', 'else', 'do', 'done', 'esac', '}', ')', ';;']);

export function parseShell(src: string): Node[] {
  const toks = lexShell(src);
  let p = 0;
  const peek = () => toks[p];
  const isWord = (w: string) => peek()?.kind === 'word' && peek().text === w;
  const isOp = (o: string) => peek()?.kind === 'op' && peek().text === o;
  const skipSeparators = () => {
    while (peek() && (peek().kind === 'nl' || isOp(';'))) p++;
  };
  const expectWord = (w: string) => {
    skipSeparators();
    if (isWord(w)) p++;
  };

  function list(stop: Set<string>): Node[] {
    const out: Node[] = [];
    for (;;) {
      skipSeparators();
      const t = peek();
      if (!t) break;
      if ((t.kind === 'word' && stop.has(t.text)) || (t.kind === 'op' && stop.has(t.text))) break;
      const before = p;
      const node = andor();
      if (node) out.push(node);
      if (isOp('&')) {
        p++;
        if (node && node.type === 'simple') node.background = true;
        else if (node) out[out.length - 1] = { type: 'unparsed', text: 'background job (&)', line: node.line };
      }
      if (p === before) p++; // never loop forever on unexpected input
    }
    return out;
  }

  function andor(): Node | null {
    const first = pipeline();
    if (!first) return null;
    const rest: AndOr['rest'] = [];
    while (isOp('&&') || isOp('||')) {
      const op = peek().text as '&&' | '||';
      p++;
      while (peek()?.kind === 'nl') p++;
      const node = pipeline();
      if (node) rest.push({ op, node });
    }
    return rest.length ? { type: 'andor', first, rest, line: first.line } : first;
  }

  function pipeline(): Node | null {
    let negate = false;
    const line = peek()?.line ?? 0;
    if (isWord('!')) {
      negate = true;
      p++;
    }
    const first = command();
    if (!first) return null;
    const commands = [first];
    while (isOp('|')) {
      p++;
      while (peek()?.kind === 'nl') p++;
      const c = command();
      if (c) commands.push(c);
    }
    return commands.length > 1 || negate ? { type: 'pipeline', negate, commands, line } : first;
  }

  function redirects(into: Redirect[]): boolean {
    const t = peek();
    if (!t || t.kind !== 'op') return false;
    if (!['>', '>>', '<', '<<', '2>', '2>>', '2>&1', '>&2', '&>', '<<<'].includes(t.text)) return false;
    p++;
    if (t.text === '2>&1' || t.text === '>&2') into.push({ op: t.text as Redirect['op'], target: '' });
    else if (t.text === '<<') into.push({ op: '<<', target: t.heredoc?.delimiter ?? '', heredoc: t.heredoc });
    else {
      const w = peek()?.kind === 'word' ? toks[p++].text : '';
      into.push({ op: t.text as Redirect['op'], target: w });
    }
    return true;
  }

  function command(): Node | null {
    const t = peek();
    if (!t || t.kind === 'nl') return null;
    const line = t.line;
    if (t.kind === 'op') {
      if (t.text === '(') {
        p++;
        const body = list(new Set([')']));
        if (isOp(')')) p++;
        const r: Redirect[] = [];
        while (redirects(r));
        return { type: 'group', subshell: true, body, redirects: r, line };
      }
      const r: Redirect[] = [];
      if (redirects(r)) return { type: 'simple', assigns: [], words: [], redirects: r, line };
      return null;
    }
    switch (t.text) {
      case 'if': {
        p++;
        const branches: If['branches'] = [];
        let otherwise: Node[] | null = null;
        let cond = list(new Set(['then']));
        expectWord('then');
        let body = list(new Set(['elif', 'else', 'fi']));
        branches.push({ cond, body });
        for (;;) {
          skipSeparators();
          if (isWord('elif')) {
            p++;
            cond = list(new Set(['then']));
            expectWord('then');
            body = list(new Set(['elif', 'else', 'fi']));
            branches.push({ cond, body });
          } else if (isWord('else')) {
            p++;
            otherwise = list(new Set(['fi']));
          } else break;
        }
        expectWord('fi');
        return { type: 'if', branches, otherwise, line };
      }
      case 'for': {
        p++;
        const variable = peek()?.kind === 'word' ? toks[p++].text : '';
        const items: string[] = [];
        if (isWord('in')) {
          p++;
          while (peek()?.kind === 'word' && !isWord('do')) items.push(toks[p++].text);
        } else items.push('"$@"');
        expectWord('do');
        const body = list(new Set(['done']));
        expectWord('done');
        return { type: 'for', variable, items, body, line };
      }
      case 'while':
      case 'until': {
        p++;
        const cond = list(new Set(['do']));
        expectWord('do');
        const body = list(new Set(['done']));
        expectWord('done');
        const r: Redirect[] = [];
        while (redirects(r));
        return { type: 'while', until: t.text === 'until', cond, body, redirects: r, line };
      }
      case 'case': {
        p++;
        const subject = peek()?.kind === 'word' ? toks[p++].text : '';
        expectWord('in');
        const arms: Case['arms'] = [];
        for (;;) {
          skipSeparators();
          if (!peek() || isWord('esac')) break;
          if (isOp('(')) p++;
          const patterns: string[] = [];
          while (peek() && !isOp(')') && peek().kind !== 'nl') {
            if (peek().kind === 'word') patterns.push(peek().text);
            p++;
          }
          if (isOp(')')) p++;
          const body = list(new Set([';;', 'esac']));
          if (isOp(';;')) p++;
          arms.push({ patterns, body });
        }
        expectWord('esac');
        return { type: 'case', subject, arms, line };
      }
      case '{': {
        p++;
        const body = list(new Set(['}']));
        expectWord('}');
        const r: Redirect[] = [];
        while (redirects(r));
        return { type: 'group', subshell: false, body, redirects: r, line };
      }
      case 'function': {
        p++;
        const name = (peek()?.kind === 'word' ? toks[p++].text : '').replace(/\(\)$/, '');
        if (isOp('(')) {
          p++;
          if (isOp(')')) p++;
        }
        skipSeparators();
        const inner = command();
        return { type: 'function', name, body: inner && inner.type === 'group' ? inner.body : inner ? [inner] : [], line };
      }
    }
    if (TERMINATORS.has(t.text)) return null;
    // name() { ... }
    if (/^[A-Za-z_]\w*$/.test(t.text) && toks[p + 1]?.kind === 'op' && toks[p + 1].text === '(' && toks[p + 2]?.kind === 'op' && toks[p + 2].text === ')') {
      p += 3;
      skipSeparators();
      const inner = command();
      return { type: 'function', name: t.text, body: inner && inner.type === 'group' ? inner.body : inner ? [inner] : [], line };
    }
    const node: Simple = { type: 'simple', assigns: [], words: [], redirects: [], line };
    for (;;) {
      const c = peek();
      if (!c || c.kind === 'nl') break;
      if (c.kind === 'op') {
        if (!redirects(node.redirects)) break;
        continue;
      }
      const m = node.words.length === 0 ? /^([A-Za-z_]\w*)=([\s\S]*)$/.exec(c.text) : null;
      if (m) node.assigns.push({ name: m[1], value: m[2] });
      else node.words.push(c.text);
      p++;
    }
    return node;
  }

  return list(new Set());
}

/** Depth-first walk over every node. */
export function walk(nodes: Node[], visit: (n: Node) => void): void {
  for (const n of nodes) {
    visit(n);
    switch (n.type) {
      case 'pipeline':
        walk(n.commands, visit);
        break;
      case 'andor':
        walk([n.first, ...n.rest.map((r) => r.node)], visit);
        break;
      case 'if':
        for (const b of n.branches) {
          walk(b.cond, visit);
          walk(b.body, visit);
        }
        if (n.otherwise) walk(n.otherwise, visit);
        break;
      case 'for':
      case 'function':
      case 'group':
        walk(n.body, visit);
        break;
      case 'while':
        walk(n.cond, visit);
        walk(n.body, visit);
        break;
      case 'case':
        for (const a of n.arms) walk(a.body, visit);
        break;
    }
  }
}

export function commandName(n: Simple): string {
  const w = n.words[0] ?? '';
  return w.replace(/^.*\//, '').replace(/^["']|["']$/g, '');
}

const SQL_CLIENTS = /^(sqlplus|sqlplus64)$/;
export interface EmbeddedSql {
  body: string;
  startLine: number;
  endLine: number;
  /** True when the shell expands $VAR inside the heredoc. */
  expands: boolean;
}
/** sqlplus heredocs, in source order. */
export function embeddedSql(src: string): EmbeddedSql[] {
  const out: EmbeddedSql[] = [];
  walk(parseShell(src), (n) => {
    if (n.type !== 'simple' || !SQL_CLIENTS.test(commandName(n))) return;
    const h = n.redirects.find((r) => r.op === '<<')?.heredoc;
    if (h && h.body.trim()) out.push({ body: h.body, startLine: h.startLine, endLine: h.endLine, expands: !h.quoted });
  });
  return out.sort((a, b) => a.startLine - b.startLine);
}

/** Explicit exit codes a shell script can return (exit N, plus sqlplus EXIT N inside heredocs). */
export function shellExitCodes(src: string): Map<number, number> {
  const codes = new Map<number, number>();
  walk(parseShell(src), (n) => {
    if (n.type !== 'simple') return;
    if ((n.words[0] === 'exit' || n.words[0] === 'return') && /^\d+$/.test(n.words[1] ?? '') && !codes.has(Number(n.words[1]))) codes.set(Number(n.words[1]), n.line);
  });
  return codes;
}
