export type TokType = 'word' | 'string' | 'number' | 'punct' | 'comment' | 'qident' | 'bind' | 'subst';
export interface Tok {
  type: TokType;
  text: string;
  /** Upper-cased text for words; raw text otherwise. */
  up: string;
  line: number;
  col: number;
  start: number;
  end: number;
}
export interface LexError {
  message: string;
  line: number;
  col: number;
}

const Q_CLOSE: Record<string, string> = { '[': ']', '(': ')', '{': '}', '<': '>' };

/** Tokenizes Oracle SQL / PL/SQL. Never throws; structural problems are returned as errors. */
export function tokenize(src: string): { tokens: Tok[]; errors: LexError[] } {
  const tokens: Tok[] = [];
  const errors: LexError[] = [];
  let i = 0;
  let line = 1;
  let lineStart = 0;
  const n = src.length;
  const push = (type: TokType, start: number, end: number, l: number, c: number) => {
    const text = src.slice(start, end);
    tokens.push({ type, text, up: type === 'word' ? text.toUpperCase() : text, line: l, col: c, start, end });
  };
  const advance = (to: number) => {
    for (let k = i; k < to; k++) {
      if (src.charCodeAt(k) === 10) {
        line++;
        lineStart = k + 1;
      }
    }
    i = to;
  };
  while (i < n) {
    const ch = src[i];
    const l = line;
    const c = i - lineStart + 1;
    const start = i;
    if (ch === '\n' || ch === ' ' || ch === '\t' || ch === '\r') {
      advance(i + 1);
      continue;
    }
    if (ch === '-' && src[i + 1] === '-') {
      let e = src.indexOf('\n', i);
      if (e === -1) e = n;
      push('comment', start, e, l, c);
      advance(e);
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      let e = src.indexOf('*/', i + 2);
      if (e === -1) {
        errors.push({ message: 'Unterminated /* comment', line: l, col: c });
        e = n - 2;
      }
      push('comment', start, e + 2, l, c);
      advance(e + 2);
      continue;
    }
    if ((ch === 'q' || ch === 'Q') && src[i + 1] === "'" && i + 2 < n) {
      const open = src[i + 2];
      const close = Q_CLOSE[open] ?? open;
      let e = src.indexOf(close + "'", i + 3);
      if (e === -1) {
        errors.push({ message: "Unterminated q'…' string literal", line: l, col: c });
        e = n - 2;
      }
      push('string', start, e + 2, l, c);
      advance(e + 2);
      continue;
    }
    if (ch === "'" || ((ch === 'n' || ch === 'N') && src[i + 1] === "'")) {
      let k = ch === "'" ? i + 1 : i + 2;
      let closed = false;
      while (k < n) {
        if (src[k] === "'") {
          if (src[k + 1] === "'") {
            k += 2;
            continue;
          }
          closed = true;
          break;
        }
        k++;
      }
      if (!closed) errors.push({ message: 'Unterminated string literal', line: l, col: c });
      push('string', start, Math.min(n, k + 1), l, c);
      advance(Math.min(n, k + 1));
      continue;
    }
    if (ch === '"') {
      let e = src.indexOf('"', i + 1);
      if (e === -1 || src.slice(i, e).includes('\n')) {
        errors.push({ message: 'Unterminated quoted identifier', line: l, col: c });
        e = src.indexOf('\n', i);
        if (e === -1) e = n - 1;
      }
      push('qident', start, e + 1, l, c);
      advance(e + 1);
      continue;
    }
    if (ch === '&') {
      const m = /^&&?[A-Za-z0-9_]+\.?/.exec(src.slice(i, i + 80));
      if (m) {
        push('subst', start, i + m[0].length, l, c);
        advance(i + m[0].length);
        continue;
      }
    }
    if (ch === ':' && /[A-Za-z0-9_]/.test(src[i + 1] ?? '') && src[i - 1] !== ':') {
      const m = /^:[A-Za-z0-9_]+/.exec(src.slice(i, i + 80))!;
      push('bind', start, i + m[0].length, l, c);
      advance(i + m[0].length);
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      const m = /^[A-Za-z_$][A-Za-z0-9_$#]*/.exec(src.slice(i, i + 200))!;
      push('word', start, i + m[0].length, l, c);
      advance(i + m[0].length);
      continue;
    }
    if (/[0-9]/.test(ch)) {
      const m = /^[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(src.slice(i, i + 60))!;
      push('number', start, i + m[0].length, l, c);
      advance(i + m[0].length);
      continue;
    }
    const two = src.slice(i, i + 2);
    const len = [':=', '||', '<=', '>=', '<>', '!=', '=>', '..', '**', '<<', '>>'].includes(two) ? 2 : 1;
    push('punct', start, i + len, l, c);
    advance(i + len);
  }
  return { tokens, errors };
}

export const code = (tokens: Tok[]): Tok[] => tokens.filter((t) => t.type !== 'comment');

/** Text of a string literal without its quotes ('' unescaped). */
export function stringValue(t: Tok): string {
  const s = t.text;
  if (/^[qQ]'/.test(s)) return s.slice(3, -2);
  const body = /^[nN]'/.test(s) ? s.slice(2, -1) : s.slice(1, -1);
  return body.replace(/''/g, "'");
}
