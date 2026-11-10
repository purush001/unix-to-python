'use client';

import { MergeView, unifiedMergeView } from '@codemirror/merge';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { basicSetup } from 'codemirror';
import { useEffect, useRef } from 'react';
import { editorTheme, languageExtension, type EditorLanguage } from './editor-setup';

interface Props {
  before: string;
  after: string;
  beforeLabel: string;
  afterLabel: string;
  beforeLanguage: EditorLanguage;
  afterLanguage: EditorLanguage;
  /** side-by-side on wide screens, unified on narrow ones */
  layout: 'split' | 'unified';
}

function common(label: string, language: EditorLanguage): Extension[] {
  return [
    basicSetup,
    editorTheme('paper'),
    languageExtension(language),
    EditorState.readOnly.of(true),
    EditorView.contentAttributes.of({ 'aria-label': label, 'aria-readonly': 'true' }),
  ];
}

export function DiffView({ before, after, beforeLabel, afterLabel, beforeLanguage, afterLanguage, layout }: Props) {
  const host = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!host.current) return;
    const parent = host.current;
    if (layout === 'split') {
      const merge = new MergeView({
        parent,
        a: { doc: before, extensions: common(beforeLabel, beforeLanguage) },
        b: { doc: after, extensions: common(afterLabel, afterLanguage) },
        collapseUnchanged: { margin: 3, minSize: 6 },
        gutter: true,
      });
      return () => merge.destroy();
    }
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: after,
        extensions: [...common(`${afterLabel}, with removed lines from ${beforeLabel}`, afterLanguage), unifiedMergeView({ original: before, mergeControls: false, collapseUnchanged: { margin: 3, minSize: 6 } })],
      }),
    });
    return () => view.destroy();
  }, [before, after, beforeLabel, afterLabel, beforeLanguage, afterLanguage, layout]);

  return (
    <div className="diff" data-testid="diff-view">
      {layout === 'split' ? (
        <div className="diff-heads" aria-hidden="true">
          <span>− {beforeLabel}</span>
          <span>+ {afterLabel}</span>
        </div>
      ) : (
        <div className="diff-heads diff-heads-one" aria-hidden="true">
          <span>
            − {beforeLabel} / + {afterLabel}
          </span>
        </div>
      )}
      <div ref={host} className="diff-host" />
    </div>
  );
}
