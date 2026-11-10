import { code, tokenize } from './tokenizer';

export type PlsqlType = 'anonymous' | 'procedure' | 'function' | 'package' | 'package_body' | 'trigger' | 'type' | 'type_body';
export interface Segment {
  kind: 'sqlplus' | 'sql' | 'plsql' | 'comment' | 'blank';
  text: string;
  /** 1-based, inclusive, relative to the script. */
  startLine: number;
  endLine: number;
  plsqlType?: PlsqlType;
  /** First keyword(s), upper case: e.g. SET, SPOOL, SELECT, CREATE TABLE. */
  head: string;
  terminated: boolean;
}

const SQLPLUS_CMD =
  /^(set|spool|spo|define|def|undefine|undef|whenever|prompt|pro|exit|quit|column|col|accept|acc|variable|var|print|exec|execute|connect|conn|disconnect|disc|host|ho|start|sta|remark|rem|ttitle|btitle|break|compute|clear|show|sho|describe|desc|pause|timing|store|password|archive\s+log|startup|shutdown|argument|config|oerr|ping)\b|^(@@?|!)/i;
const SQL_SET = /^set\s+(transaction|role|constraints?)\b/i;
const PLSQL_START = /^(declare\b|begin\b|<<\s*\w+\s*>>|create\s+(or\s+replace\s+)?((non)?editionable\s+)?(procedure|function|package|trigger|type|library\s+\w+\s+(is|as)\s+language)\b)/i;

function plsqlType(text: string): PlsqlType {
  const m = /^\s*create\s+(?:or\s+replace\s+)?(?:(?:non)?editionable\s+)?(procedure|function|package\s+body|package|trigger|type\s+body|type)\b/i.exec(text);
  if (!m) return 'anonymous';
  return m[1].toLowerCase().replace(/\s+/g, '_') as PlsqlType;
}

function endsWithSemicolon(text: string): boolean {
  const t = code(tokenize(text).tokens);
  return t.length > 0 && t[t.length - 1].text === ';';
}

/** Splits a SQL*Plus-style script into commands, SQL statements and PL/SQL units. */
export function splitScript(src: string): Segment[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const segs: Segment[] = [];
  let i = 0;
  const seg = (kind: Segment['kind'], from: number, to: number, extra: Partial<Segment> = {}) => {
    const text = lines.slice(from, to + 1).join('\n');
    const head = (/^\s*([A-Za-z@!]+(?:\s+(?:table|index|view|sequence|synonym|user|system|session|database|audit|or\s+replace))?)/i.exec(text)?.[1] ?? '').toUpperCase().replace(/\s+/g, ' ');
    segs.push({ kind, text, startLine: from + 1, endLine: to + 1, head, terminated: true, ...extra });
  };
  while (i < lines.length) {
    const t = lines[i].trim();
    if (t === '') {
      seg('blank', i, i);
      i++;
      continue;
    }
    if (t.startsWith('--') || /^rem(ark)?(\s|$)/i.test(t)) {
      seg('comment', i, i);
      i++;
      continue;
    }
    if (t.startsWith('/*')) {
      let j = i;
      while (j < lines.length - 1 && !lines[j].includes('*/')) j++;
      // a hint-less block comment on its own lines
      if (lines[j].trim().endsWith('*/')) {
        seg('comment', i, j);
        i = j + 1;
        continue;
      }
    }
    if (t === '/') {
      seg('sqlplus', i, i);
      i++;
      continue;
    }
    if (SQLPLUS_CMD.test(t) && !SQL_SET.test(t)) {
      let j = i;
      while (j < lines.length - 1 && /-\s*$/.test(lines[j]) && !/--/.test(lines[j])) j++;
      seg('sqlplus', i, j);
      i = j + 1;
      continue;
    }
    if (PLSQL_START.test(t) && !/^create\s+(or\s+replace\s+)?type\s+\w+(\.\w+)?\s*;/i.test(t)) {
      let j = i;
      while (j < lines.length && lines[j].trim() !== '/') j++;
      const terminated = j < lines.length;
      const end = terminated ? j : lines.length - 1;
      seg('plsql', i, end, { plsqlType: plsqlType(lines.slice(i, end + 1).join('\n')), terminated });
      i = end + 1;
      continue;
    }
    // plain SQL statement: up to a terminating ; or a lone /
    let j = i;
    let terminated = false;
    while (j < lines.length) {
      if (lines[j].trim() === '/' && j > i) {
        terminated = true;
        break;
      }
      if (lines[j].trimEnd().endsWith(';') && endsWithSemicolon(lines.slice(i, j + 1).join('\n'))) {
        terminated = true;
        break;
      }
      j++;
    }
    const end = Math.min(j, lines.length - 1);
    seg('sql', i, end, { terminated });
    i = end + 1;
  }
  return segs;
}

export function hasPlsql(segs: Segment[]): boolean {
  return segs.some((s) => s.kind === 'plsql');
}
export function hasSqlplus(segs: Segment[]): boolean {
  return segs.some((s) => s.kind === 'sqlplus' && s.text.trim() !== '/');
}
