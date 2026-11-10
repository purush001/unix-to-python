'use client';

import { Compartment, EditorState, StateEffect, StateField, type Extension } from '@codemirror/state';
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view';
import { basicSetup } from 'codemirror';
import { useEffect, useRef } from 'react';
import { editorTheme, languageExtension, type EditorLanguage, type EditorTone } from './editor-setup';

export interface JumpTarget {
  line: number;
  /** Changes on every click so the same line can be jumped to twice. */
  nonce: number;
}

interface Props {
  value: string;
  onChange?: (value: string) => void;
  readOnly?: boolean;
  language: EditorLanguage;
  tone: EditorTone;
  label: string;
  placeholderText?: string;
  /** 1-based lines marked as "check this line". */
  flagLines?: number[];
  /** Line to scroll to and mark. */
  jump?: JumpTarget | null;
  testId?: string;
}

interface Marks {
  flags: number[];
  jump: number | null;
}

const setMarks = StateEffect.define<Marks>();
const flagDeco = Decoration.line({ class: 'cm-flagLine' });
const jumpDeco = Decoration.line({ class: 'cm-jumpLine' });

function buildMarks(state: EditorState, marks: Marks): DecorationSet {
  const lines = new Map<number, Decoration>();
  for (const n of marks.flags) if (n >= 1 && n <= state.doc.lines) lines.set(n, flagDeco);
  if (marks.jump !== null && marks.jump >= 1 && marks.jump <= state.doc.lines) lines.set(marks.jump, jumpDeco);
  const ranges = [...lines.entries()].sort((a, b) => a[0] - b[0]).map(([n, deco]) => deco.range(state.doc.line(n).from));
  return Decoration.set(ranges);
}

const marksField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setMarks)) return buildMarks(tr.state, e.value);
    return tr.docChanged ? value.map(tr.changes) : value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

function readOnlyExtension(readOnly: boolean): Extension {
  // read-only editors stay focusable so keyboard users can move through and select the text
  return [EditorState.readOnly.of(readOnly), EditorView.editable.of(true), EditorView.contentAttributes.of({ 'aria-readonly': readOnly ? 'true' : 'false' })];
}

export function CodeEditor({ value, onChange, readOnly = false, language, tone, label, flagLines, jump, testId }: Props) {
  const host = useRef<HTMLDivElement | null>(null);
  const view = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const langComp = useRef(new Compartment());
  const roComp = useRef(new Compartment());
  const lastNonce = useRef(0);
  const initial = useRef({ value, language, readOnly, tone, label });

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    if (!host.current) return;
    const init = initial.current;
    const v = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: init.value,
        extensions: [
          basicSetup,
          editorTheme(init.tone),
          langComp.current.of(languageExtension(init.language)),
          roComp.current.of(readOnlyExtension(init.readOnly)),
          marksField,
          EditorView.contentAttributes.of({ 'aria-label': init.label, 'aria-multiline': 'true', spellcheck: 'false', autocapitalize: 'off' }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onChangeRef.current?.(u.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = v;
    return () => {
      v.destroy();
      view.current = null;
    };
  }, []);

  useEffect(() => {
    const v = view.current;
    if (!v) return;
    // replaced from outside (new draft, sanitized source, example): start again at the top
    if (v.state.doc.toString() !== value) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value }, selection: { anchor: 0 }, effects: EditorView.scrollIntoView(0) });
  }, [value]);

  useEffect(() => {
    view.current?.dispatch({ effects: langComp.current.reconfigure(languageExtension(language)) });
  }, [language]);

  useEffect(() => {
    view.current?.dispatch({ effects: roComp.current.reconfigure(readOnlyExtension(readOnly)) });
  }, [readOnly]);

  const flagKey = (flagLines ?? []).join(',');
  const jumpLine = jump?.line ?? null;
  const jumpNonce = jump?.nonce ?? 0;
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const flags = flagKey ? flagKey.split(',').map(Number) : [];
    const effects: StateEffect<unknown>[] = [setMarks.of({ flags, jump: jumpLine })];
    const fresh = jumpNonce !== lastNonce.current;
    lastNonce.current = jumpNonce;
    if (fresh && jumpLine !== null && jumpLine >= 1 && jumpLine <= v.state.doc.lines) {
      const pos = v.state.doc.line(jumpLine).from;
      effects.push(EditorView.scrollIntoView(pos, { y: 'center' }));
      v.dispatch({ effects, selection: { anchor: pos } });
    } else v.dispatch({ effects });
    // value is a dependency so marks are rebuilt after the document was replaced
  }, [flagKey, jumpLine, jumpNonce, value]);

  return <div ref={host} className={`editor editor-${tone}`} data-testid={testId} data-readonly={readOnly ? 'true' : 'false'} />;
}
