/** Shell word → Python expression translation used by the mock converter. */

export type Part =
  | { t: 'lit'; v: string; glob?: boolean }
  | { t: 'var'; name: string; op?: string; arg?: string }
  | { t: 'sub'; cmd: string }
  | { t: 'bad'; why: string };

const PY_KEYWORDS = new Set(['and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield', 'match', 'case', 'type', 'state', 'args', 'rc', 'env', 'step', 'job', 'main', 'os', 'sys', 'time', 'glob', 'spool', 'str', 'int', 'len', 'list', 'open', 'print', 'input', 'id', 'dir', 'file', 'log', 'field', 'socket', 'shutil', 'uuid', 'logging', 'traceback']);

export function pyName(shellName: string): string {
  let n = shellName.toLowerCase().replace(/[^a-z0-9_]/g, '_');
  if (/^[0-9]/.test(n)) n = 'v_' + n;
  return PY_KEYWORDS.has(n) ? n + '_' : n;
}

export function pyStr(s: string): string {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\t/g, '\\t') + '"';
}

export function parseWord(raw: string): Part[] {
  const parts: Part[] = [];
  let lit = '';
  let glob = false;
  const flush = () => {
    if (lit !== '') parts.push({ t: 'lit', v: lit, ...(glob ? { glob: true } : {}) });
    lit = '';
    glob = false;
  };
  let i = 0;
  let dq = false;
  const n = raw.length;
  while (i < n) {
    const c = raw[i];
    if (!dq && c === "'") {
      const e = raw.indexOf("'", i + 1);
      lit += raw.slice(i + 1, e === -1 ? n : e);
      i = (e === -1 ? n : e) + 1;
      continue;
    }
    if (c === '"') {
      dq = !dq;
      i++;
      continue;
    }
    if (c === '\\' && i + 1 < n) {
      if (raw[i + 1] === '\n') {
        i += 2;
        continue;
      }
      lit += dq && !/[$`"\\]/.test(raw[i + 1]) ? '\\' + raw[i + 1] : raw[i + 1];
      i += 2;
      continue;
    }
    if (c === '`') {
      const e = raw.indexOf('`', i + 1);
      flush();
      parts.push({ t: 'sub', cmd: raw.slice(i + 1, e === -1 ? n : e) });
      i = (e === -1 ? n : e) + 1;
      continue;
    }
    if (c === '$') {
      if (raw.startsWith('$((', i)) {
        flush();
        parts.push({ t: 'bad', why: 'arithmetic expansion $((…))' });
        const e = raw.indexOf('))', i);
        i = (e === -1 ? n : e) + 2;
        continue;
      }
      if (raw[i + 1] === '(') {
        let depth = 0;
        let k = i + 1;
        for (; k < n; k++) {
          if (raw[k] === '(') depth++;
          else if (raw[k] === ')' && --depth === 0) break;
        }
        flush();
        parts.push({ t: 'sub', cmd: raw.slice(i + 2, k) });
        i = k + 1;
        continue;
      }
      if (raw[i + 1] === '{') {
        const e = raw.indexOf('}', i);
        const inner = raw.slice(i + 2, e === -1 ? n : e);
        flush();
        const m = /^([A-Za-z_]\w*|[?#@*$!0-9])(?:(:?[-?=+])([\s\S]*))?$/.exec(inner);
        if (m) parts.push({ t: 'var', name: m[1], op: m[2], arg: m[3] });
        else parts.push({ t: 'bad', why: `parameter expansion \${${inner}}` });
        i = (e === -1 ? n : e) + 1;
        continue;
      }
      const m = /^\$([A-Za-z_]\w*|[?#@*$!0-9])/.exec(raw.slice(i));
      if (m) {
        flush();
        parts.push({ t: 'var', name: m[1] });
        i += m[0].length;
        continue;
      }
    }
    if (!dq && (c === '*' || c === '?')) glob = true;
    lit += c;
    i++;
  }
  flush();
  return parts;
}

export const isLiteral = (parts: Part[]) => parts.every((p) => p.t === 'lit');
export const literalValue = (parts: Part[]) => parts.map((p) => (p.t === 'lit' ? p.v : '')).join('');
export const hasGlob = (parts: Part[]) => parts.some((p) => p.t === 'lit' && p.glob);

/** f-string body escaping. */
export function fEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\t/g, '\\t').replace(/\{/g, '{{').replace(/\}/g, '}}');
}

const PH = /\b((?:source|target)_(?:server|user)(?:_\d+)?)\b/g;

export function placeholderSection(ph: string): { section: string; key: 'host' | 'user' } {
  const m = /^(source|target)_(server|user)(_\d+)?$/.exec(ph)!;
  return { section: m[1] + (m[3] ?? ''), key: m[2] === 'server' ? 'host' : 'user' };
}

/**
 * Builds a Python string expression from parts. `piece` turns a non-literal part into
 * an expression; placeholders in literals become config lookups through `cfgRef`.
 */
export function buildExpr(parts: Part[], piece: (p: Exclude<Part, { t: 'lit' }>) => string, cfgRef: (section: string, key: string) => string): string {
  const segs: { lit?: string; expr?: string }[] = [];
  for (const p of parts) {
    if (p.t !== 'lit') {
      segs.push({ expr: piece(p) });
      continue;
    }
    let last = 0;
    PH.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = PH.exec(p.v))) {
      if (m.index > last) segs.push({ lit: p.v.slice(last, m.index) });
      const { section, key } = placeholderSection(m[1]);
      segs.push({ expr: cfgRef(section, key) });
      last = m.index + m[0].length;
    }
    if (last < p.v.length) segs.push({ lit: p.v.slice(last) });
  }
  if (segs.length === 0) return '""';
  if (segs.every((s) => s.lit !== undefined)) return pyStr(segs.map((s) => s.lit).join(''));
  if (segs.length === 1 && segs[0].expr) return segs[0].expr;
  return 'f"' + segs.map((s) => (s.lit !== undefined ? fEscape(s.lit) : `{${s.expr!.replace(/"/g, "'")}}`)).join('') + '"';
}
