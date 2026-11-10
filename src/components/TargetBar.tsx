'use client';

import type { DraftView, RunView } from '@/lib/api-types';
import { STATUS_GLYPH, STATUS_TEXT } from './run-helpers';

interface Props {
  run: RunView;
  draft: DraftView;
  fileName: string;
  showDiff: boolean;
  diffBase: 'source' | number;
  onVersion: (v: number) => void;
  onFile: (name: string) => void;
  onToggleDiff: () => void;
  onDiffBase: (b: 'source' | number) => void;
  onCopy: () => void;
  onDownload: () => void;
}

/** Label (Draft / Final), version switcher, file tabs and the file actions above the target editor. */
export function TargetBar({ run, draft, fileName, showDiff, diffBase, onVersion, onFile, onToggleDiff, onDiffBase, onCopy, onDownload }: Props) {
  const approved = run.final !== null && (run.state === 'saved' || run.state === 'approved');
  const isFinal = approved && run.final?.version === draft.version;
  const others = run.drafts.filter((d) => d.version !== draft.version);

  return (
    <div className="target-bar">
      <div className="target-id">
        <span className={`stamp ${isFinal ? (run.state === 'saved' ? 'stamp-final' : 'stamp-approved') : 'stamp-draft'}`} data-testid="target-label">
          {isFinal ? (run.state === 'saved' ? 'Final' : 'Approved, not saved') : 'Draft'}
        </span>
        <span className="target-version" data-testid="draft-version">
          version {draft.version} of {run.drafts.length}
        </span>
        <span className={`status-pill status-${draft.status}`} data-testid="draft-status">
          <span aria-hidden="true">{STATUS_GLYPH[draft.status]} </span>
          {STATUS_TEXT[draft.status]}
        </span>
        {draft.attempts > 0 ? (
          <span className="quiet">
            {draft.attempts} repair {draft.attempts === 1 ? 'attempt' : 'attempts'}
          </span>
        ) : null}
      </div>

      {run.drafts.length > 1 ? (
        <div className="versions" role="group" aria-label="Draft versions">
          <span className="tiny-label">Versions</span>
          {run.drafts.map((d) => (
            <button key={d.version} type="button" className="seg" aria-pressed={d.version === draft.version} onClick={() => onVersion(d.version)} data-testid={`version-${d.version}`}>
              v{d.version}
              <span className="sr-only">
                , {STATUS_TEXT[d.status]}
                {run.final?.version === d.version ? ', final' : ''}
              </span>
            </button>
          ))}
        </div>
      ) : null}
      {draft.note ? (
        <p className="target-note">
          <span className="tiny-label">Reviewer note for this version</span> {draft.note}
        </p>
      ) : null}

      <div className="target-tools">
        <div className="tabs" role="group" aria-label="Output files">
          {draft.files.map((f) => (
            <button key={f.name} type="button" className="tab" aria-pressed={f.name === fileName} onClick={() => onFile(f.name)} data-testid={`file-${f.name}`}>
              {f.name}
            </button>
          ))}
        </div>
        <div className="tool-buttons">
          <button type="button" className="btn btn-small btn-ghost" aria-pressed={showDiff} onClick={onToggleDiff} data-testid="diff-toggle">
            <span aria-hidden="true">± </span>Diff
          </button>
          {showDiff && others.length > 0 ? (
            <label className="inline-field">
              <span>Compare with</span>
              <select className="input select" value={String(diffBase)} onChange={(e) => onDiffBase(e.target.value === 'source' ? 'source' : Number(e.target.value))}>
                <option value="source">sanitized source</option>
                {others.map((d) => (
                  <option key={d.version} value={d.version}>
                    draft v{d.version}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <button type="button" className="btn btn-small btn-ghost" onClick={onCopy} data-testid="copy">
            Copy<span className="sr-only"> {fileName}</span>
          </button>
          <button type="button" className="btn btn-small btn-ghost" onClick={onDownload} data-testid="download">
            Download<span className="sr-only"> {fileName}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
