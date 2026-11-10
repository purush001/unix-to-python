import { python } from '@codemirror/lang-python';
import { PLSQL, sql } from '@codemirror/lang-sql';
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from '@codemirror/language';
import { properties } from '@codemirror/legacy-modes/mode/properties';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';
import type { OutputFile } from '@/pipeline/types';

export type EditorLanguage = 'sql' | 'shell' | 'python' | 'ini' | 'text';
export type EditorTone = 'paper' | 'ink';

export function languageExtension(lang: EditorLanguage): Extension {
  switch (lang) {
    case 'sql':
      return sql({ dialect: PLSQL, upperCaseKeywords: true });
    case 'shell':
      return StreamLanguage.define(shell);
    case 'python':
      return python();
    case 'ini':
      return StreamLanguage.define(properties);
    default:
      return [];
  }
}

export function languageForFile(file: Pick<OutputFile, 'kind'>): EditorLanguage {
  if (file.kind === 'sql') return 'sql';
  if (file.kind === 'python') return 'python';
  return 'ini';
}

/** Best guess for the source editor: the selected type wins, otherwise look at the text. */
export function languageForSource(selected: string, text: string): EditorLanguage {
  if (selected === 'sql' || selected === 'plsql' || selected === 'sqlplus') return 'sql';
  if (selected === 'shell' || selected === 'mixed') return 'shell';
  const head = text.slice(0, 4000);
  if (/^#!.*\b(k|ba|z)?sh\b/m.test(head) || /<<-?\s*['"]?\w+|^\s*(if \[|fi$|export \w+=|\w+=\$\()/m.test(head)) return 'shell';
  if (head.trim() === '') return 'text';
  return 'sql';
}

interface Tones {
  bg: string;
  text: string;
  gutterBg: string;
  gutterText: string;
  activeLine: string;
  selection: string;
  caret: string;
  flag: string;
  flagEdge: string;
  focus: string;
  focusEdge: string;
  keyword: string;
  string: string;
  comment: string;
  number: string;
  fn: string;
  type: string;
}

/* Every colour pair here is listed with its contrast ratio at the top of globals.css. */
const TONES: Record<EditorTone, Tones> = {
  paper: {
    bg: '#FFFFFF', text: '#1A1433', gutterBg: '#F3F0FF', gutterText: '#5F5985', activeLine: '#FAF8FF', selection: '#DDD6FE', caret: '#6D28D9',
    flag: '#FDE68A', flagEdge: '#92400E', focus: '#FDE68A', focusEdge: '#1A1433',
    keyword: '#6D28D9', string: '#9D174D', comment: '#5F5985', number: '#92400E', fn: '#0B5E73', type: '#046648',
  },
  ink: {
    bg: '#140F2E', text: '#ECE9FF', gutterBg: '#140F2E', gutterText: '#9691BF', activeLine: '#1E1842', selection: '#3A1878', caret: '#F9A8D4',
    flag: '#3A1878', flagEdge: '#F9A8D4', focus: '#3A1878', focusEdge: '#FCD34D',
    keyword: '#C4B5FD', string: '#F9A8D4', comment: '#A5A1C8', number: '#FCD34D', fn: '#67E8F9', type: '#6EE7B7',
  },
};

export function editorTheme(tone: EditorTone): Extension {
  const c = TONES[tone];
  const theme = EditorView.theme(
    {
      '&': { color: c.text, backgroundColor: c.bg, height: '100%', fontSize: '13px' },
      '&.cm-focused': { outline: 'none' },
      '.cm-scroller': { fontFamily: 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace', lineHeight: '1.55', overflow: 'auto' },
      '.cm-content': { caretColor: c.caret, padding: '10px 0' },
      '.cm-cursor, .cm-dropCursor': { borderLeftColor: c.caret, borderLeftWidth: '2px' },
      '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': { backgroundColor: c.selection },
      '.cm-gutters': { backgroundColor: c.gutterBg, color: c.gutterText, border: 'none', borderRight: `1px solid ${tone === 'paper' ? '#DDD6FE' : '#2E1065'}` },
      '.cm-lineNumbers .cm-gutterElement': { padding: '0 10px 0 12px', minWidth: '34px' },
      '.cm-activeLine': { backgroundColor: c.activeLine },
      '.cm-activeLineGutter': { backgroundColor: c.activeLine, color: c.text },
      '.cm-line': { padding: '0 14px 0 10px', borderLeft: '4px solid transparent' },
      '.cm-line.cm-flagLine': { backgroundColor: c.flag, borderLeft: `4px dotted ${c.flagEdge}` },
      '.cm-line.cm-jumpLine': { backgroundColor: c.focus, borderLeft: `4px solid ${c.focusEdge}`, outline: `1px solid ${c.focusEdge}` },
      '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': { backgroundColor: 'transparent', outline: `1px solid ${c.gutterText}` },
      '.cm-foldPlaceholder': { backgroundColor: 'transparent', border: `1px solid ${c.gutterText}`, color: c.text },
      '.cm-panels': { backgroundColor: c.gutterBg, color: c.text },
      '.cm-tooltip': { backgroundColor: c.gutterBg, color: c.text, border: `1px solid ${c.gutterText}` },
      '.cm-changedLine': { backgroundColor: tone === 'paper' ? '#D1FAE5' : '#0F3B33' },
      '.cm-deletedChunk': { backgroundColor: tone === 'paper' ? '#FFE4E6' : '#45132F' },
      '.cm-changedText, .cm-deletedText, .cm-deletedLine .cm-deletedText': { background: 'none !important', textDecoration: 'none' },
      '.cm-deletedLine, .cm-deletedLine del': { textDecoration: 'none' },
      '.cm-collapsedLines': { backgroundColor: c.gutterBg, color: c.text, backgroundImage: 'none', padding: '4px 12px' },
      '.cm-changeGutter': { width: '4px' },
    },
    { dark: tone === 'ink' },
  );
  const highlight = HighlightStyle.define([
    { tag: [t.keyword, t.operatorKeyword, t.modifier, t.controlKeyword, t.definitionKeyword, t.moduleKeyword], color: c.keyword, fontWeight: '600' },
    { tag: [t.string, t.special(t.string), t.character, t.regexp], color: c.string },
    { tag: [t.comment, t.lineComment, t.blockComment, t.meta], color: c.comment, fontStyle: 'italic' },
    { tag: [t.number, t.bool, t.null, t.atom], color: c.number },
    { tag: [t.function(t.variableName), t.function(t.propertyName), t.definition(t.variableName), t.standard(t.name), t.special(t.variableName)], color: c.fn },
    { tag: [t.typeName, t.className, t.namespace, t.self], color: c.type },
    { tag: [t.variableName, t.propertyName, t.operator, t.punctuation, t.name], color: c.text },
    { tag: t.invalid, color: c.text, textDecoration: 'underline wavy' },
  ]);
  return [theme, syntaxHighlighting(highlight)];
}
