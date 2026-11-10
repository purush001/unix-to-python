import type { PlsqlType } from './splitter';
import { code, tokenize, type Tok } from './tokenizer';

export interface Block {
  /** Indexes into the code-token array. */
  begin: number;
  end: number;
  depth: number;
  /** Index of the EXCEPTION keyword of this block's handler section, or -1. */
  exception: number;
  /** Index of THEN in WHEN OTHERS THEN, or -1. */
  othersThen: number;
  hasCapture: boolean;
  reraises: boolean;
}
export interface BlockError {
  message: string;
  line: number;
  col: number;
}
export interface BlockAnalysis {
  toks: Tok[];
  blocks: Block[];
  errors: BlockError[];
}

const CAPTURE_WORDS = ['FORMAT_ERROR_BACKTRACE', 'FORMAT_ERROR_STACK', 'SQLCODE', 'PUT_LINE'];

/** Finds BEGIN…END blocks and their exception handlers; reports unbalanced structure. */
export function analyzeBlocks(text: string, type: PlsqlType): BlockAnalysis {
  const toks = code(tokenize(text).tokens);
  const errors: BlockError[] = [];
  const blocks: Block[] = [];
  const stack: { kind: 'BEGIN' | 'IF' | 'LOOP' | 'CASE'; idx: number; block?: Block }[] = [];
  let freeEnds = 0;
  const allowedFreeEnds = type === 'package' || type === 'package_body' || type === 'type' || type === 'type_body' || type === 'trigger' ? 1 : 0;

  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.type !== 'word') continue;
    const prev = toks[i - 1];
    const prevEnd = prev?.type === 'word' && prev.up === 'END';
    switch (t.up) {
      case 'BEGIN': {
        const b: Block = { begin: i, end: -1, depth: stack.filter((s) => s.kind === 'BEGIN').length, exception: -1, othersThen: -1, hasCapture: false, reraises: false };
        blocks.push(b);
        stack.push({ kind: 'BEGIN', idx: i, block: b });
        break;
      }
      case 'IF':
      case 'LOOP':
      case 'CASE':
        if (!prevEnd) stack.push({ kind: t.up, idx: i });
        break;
      case 'EXCEPTION': {
        const top = stack[stack.length - 1];
        if (top?.kind === 'BEGIN' && top.block && toks[i + 1]?.up === 'WHEN') top.block.exception = i;
        break;
      }
      case 'OTHERS': {
        const top = stack[stack.length - 1];
        if (top?.kind === 'BEGIN' && top.block && top.block.exception !== -1 && prev?.up === 'WHEN' && toks[i + 1]?.up === 'THEN') top.block.othersThen = i + 1;
        break;
      }
      case 'END': {
        const next = toks[i + 1];
        const want = next?.type === 'word' && (next.up === 'IF' || next.up === 'LOOP' || next.up === 'CASE') ? next.up : null;
        const top = stack[stack.length - 1];
        if (!top) {
          freeEnds++;
          if (freeEnds > allowedFreeEnds) errors.push({ message: 'END without a matching BEGIN', line: t.line, col: t.col });
          break;
        }
        if (want === 'IF' || want === 'LOOP') {
          if (top.kind !== want) errors.push({ message: `END ${want} does not match the open ${top.kind} at line ${toks[top.idx].line}`, line: t.line, col: t.col });
          stack.pop();
        } else if (want === 'CASE') {
          if (top.kind !== 'CASE') errors.push({ message: `END CASE does not match the open ${top.kind} at line ${toks[top.idx].line}`, line: t.line, col: t.col });
          stack.pop();
        } else {
          if (top.kind === 'IF' || top.kind === 'LOOP') errors.push({ message: `END closes ${top.kind} opened at line ${toks[top.idx].line}; expected END ${top.kind}`, line: t.line, col: t.col });
          stack.pop();
          if (top.block) top.block.end = i;
        }
        break;
      }
    }
  }
  for (const s of stack) errors.push({ message: `${s.kind} at line ${toks[s.idx].line} is never closed`, line: toks[s.idx].line, col: toks[s.idx].col });

  for (const b of blocks) {
    if (b.othersThen === -1 || b.end === -1) continue;
    const handler = toks.slice(b.othersThen, b.end);
    b.hasCapture = CAPTURE_WORDS.every((w) => handler.some((t) => t.type === 'word' && t.up === w));
    b.reraises = handler.some((t) => t.type === 'word' && (t.up === 'RAISE' || t.up === 'RAISE_APPLICATION_ERROR'));
  }
  return { toks, blocks, errors };
}

/** Blocks that are the outermost executable block of a unit the script owns. */
export function ownedBlocks(a: BlockAnalysis, type: PlsqlType): Block[] {
  const top = a.blocks.filter((b) => b.depth === 0 && b.end !== -1);
  if (type === 'package' || type === 'type') return [];
  if (type === 'package_body' || type === 'type_body') return top;
  return top.length ? [top[top.length - 1]] : [];
}

export function captureBlock(indent: string): string {
  const i = indent;
  return [
    `${i}DECLARE`,
    `${i}  l_err_code  PLS_INTEGER    := SQLCODE;`,
    `${i}  l_err_stack VARCHAR2(4000) := SUBSTR(DBMS_UTILITY.FORMAT_ERROR_STACK, 1, 4000);`,
    `${i}  l_err_trace VARCHAR2(4000) := SUBSTR(DBMS_UTILITY.FORMAT_ERROR_BACKTRACE, 1, 4000);`,
    `${i}BEGIN`,
    `${i}  DBMS_OUTPUT.PUT_LINE('ERROR|unit=' || NVL($$PLSQL_UNIT, 'ANONYMOUS_BLOCK')`,
    `${i}    || '|line=' || REGEXP_SUBSTR(l_err_trace, 'line ([0-9]+)', 1, 1, NULL, 1)`,
    `${i}    || '|code=' || l_err_code`,
    `${i}    || '|message=' || REPLACE(RTRIM(l_err_stack, CHR(10)), CHR(10), ' '));`,
    `${i}END;`,
  ].join('\n');
}

export interface Instrumented {
  text: string;
  added: { line: number; kind: 'handler' | 'capture' }[];
  swallowed: number[];
}

/**
 * Adds the section 9.5 error capture to a PL/SQL unit without changing behaviour:
 * new handlers re-raise; existing WHEN OTHERS handlers only gain the capture line.
 */
export function instrumentUnit(text: string, type: PlsqlType): Instrumented {
  const a = analyzeBlocks(text, type);
  const owned = new Set(ownedBlocks(a, type));
  const edits: { at: number; insert: string; line: number; kind: 'handler' | 'capture' }[] = [];
  const swallowed: number[] = [];
  const indentOf = (tok: Tok) => /^[ \t]*/.exec(text.slice(text.lastIndexOf('\n', tok.start) + 1, tok.start))![0];
  const lineStart = (tok: Tok) => text.lastIndexOf('\n', tok.start) + 1;

  for (const b of a.blocks) {
    if (b.end === -1) continue;
    const beginTok = a.toks[b.begin];
    const endTok = a.toks[b.end];
    const ind = indentOf(beginTok);
    if (b.othersThen !== -1) {
      if (!b.reraises) swallowed.push(a.toks[b.othersThen].line);
      if (!b.hasCapture && (owned.has(b) || !b.reraises)) {
        const then = a.toks[b.othersThen];
        edits.push({ at: then.end, insert: '\n' + captureBlock(ind + '    '), line: then.line, kind: 'capture' });
      }
      continue;
    }
    if (!owned.has(b)) continue;
    const handler = `${ind}  WHEN OTHERS THEN\n${captureBlock(ind + '    ')}\n${ind}    RAISE;\n`;
    const onOwnLine = text.slice(lineStart(endTok), endTok.start).trim() === '';
    const at = onOwnLine ? lineStart(endTok) : endTok.start;
    const prefix = onOwnLine ? '' : '\n';
    edits.push({ at, insert: prefix + (b.exception === -1 ? `${ind}EXCEPTION\n` : '') + handler + (onOwnLine ? '' : ind), line: endTok.line, kind: 'handler' });
  }
  let out = text;
  for (const e of edits.sort((x, y) => y.at - x.at)) out = out.slice(0, e.at) + e.insert + out.slice(e.at);
  return { text: out, added: edits.map((e) => ({ line: e.line, kind: e.kind })).sort((x, y) => x.line - y.line), swallowed };
}
