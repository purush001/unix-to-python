'use client';

import { useId, useState, type FormEvent } from 'react';
import type { IssueView } from '@/lib/api-types';
import type { FeedbackBody } from './api';

interface Props {
  issues: IssueView[];
  activeIndex: number | null;
  onSelect: (issue: IssueView, index: number) => void;
  onReport: (body: FeedbackBody) => Promise<void>;
  /** Indexes of warnings the reviewer removed from view. */
  dismissed: number[];
  canDismiss: boolean;
  onDismiss: (index: number, dismissed: boolean) => void;
  /** True while the output can still be changed (latest version of an unapproved draft). */
  canChange: boolean;
  /** Opens the target editor at this entry's line so the person can change the output by hand. */
  onEdit: (issue: IssueView, index: number) => void;
  /** Asks the converter for a new draft that fixes this entry. */
  onFix: (issue: IssueView) => void;
}

function where(i: IssueView): string {
  if (i.line !== null) return `line ${i.line}${i.file ? ` in ${i.file}` : ''}`;
  return 'whole script';
}

function IssueItem({ issue, index, active, onSelect, onReport, onRemove, onEdit, onFix }: { issue: IssueView; index: number; active: boolean; onSelect: Props['onSelect']; onReport: Props['onReport']; onRemove: (() => void) | null; onEdit: (() => void) | null; onFix: (() => void) | null }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [comment, setComment] = useState('');
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'failed'>('idle');
  const [failure, setFailure] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setState('sending');
    try {
      const body: FeedbackBody = { errorCode: issue.code };
      if (issue.line !== null && issue.line > 0) body.line = issue.line;
      if (comment.trim()) body.comment = comment.trim();
      await onReport(body);
      setState('sent');
      setOpen(false);
    } catch (err) {
      setFailure(err instanceof Error ? err.message : 'The report could not be sent.');
      setState('failed');
    }
  };

  return (
    <li className={`issue issue-${issue.severity}${active ? ' issue-active' : ''}`} data-testid="issue-item">
      <button
        type="button"
        className="issue-jump"
        onClick={() => onSelect(issue, index)}
        aria-current={active ? 'true' : undefined}
        aria-describedby={`${id}-m`}
        data-testid="issue-jump"
      >
        <span className={`sev sev-${issue.severity}`}>
          <span aria-hidden="true">{issue.severity === 'error' ? '✕' : '▲'} </span>
          {issue.severity}
        </span>
        <code className="rule">{issue.code}</code>
        <span className="issue-where">
          {where(issue)}
          {issue.sourceLine ? ` · source line ${issue.sourceLine}` : ''}
        </span>
        <span className="issue-go" aria-hidden="true">
          {issue.line !== null || issue.sourceLine ? 'show ↗' : ''}
        </span>
      </button>
      <p id={`${id}-m`} className="issue-message">
        {issue.message}
      </p>
      <dl className="issue-more">
        <dt>What it means</dt>
        <dd>{issue.explanation}</dd>
        <dt>Next step</dt>
        <dd>{issue.nextStep}</dd>
      </dl>
      <div className="issue-actions">
        {onEdit ? (
          <button type="button" className="btn btn-small btn-primary" onClick={onEdit} data-testid="issue-edit">
            <span aria-hidden="true">✎ </span>Change output<span className="sr-only"> for this {issue.severity}: edit the target at {where(issue)}</span>
          </button>
        ) : null}
        {onFix ? (
          <button type="button" className="btn btn-small btn-ghost" onClick={onFix} data-testid="issue-fix">
            Ask for a fix<span className="sr-only"> of this {issue.severity} in a new draft</span>
          </button>
        ) : null}
        {state === 'sent' ? (
          <p className="msg msg-ok" role="status">
            <span aria-hidden="true">✓ </span>Problem reported. Thank you.
          </p>
        ) : (
          <button type="button" className="btn btn-small btn-ghost" aria-expanded={open} aria-controls={`${id}-f`} onClick={() => setOpen((o) => !o)}>
            Report a problem
          </button>
        )}
        {onRemove ? (
          <button type="button" className="btn btn-small btn-ghost" onClick={onRemove} data-testid="issue-remove">
            Remove<span className="sr-only"> this {issue.severity} from the list</span>
          </button>
        ) : null}
      </div>
      {open ? (
        <form id={`${id}-f`} className="report-form" onSubmit={submit}>
          <label htmlFor={`${id}-c`} className="field-label">
            What is wrong with this {issue.severity}? (optional)
          </label>
          <textarea id={`${id}-c`} className="input textarea" rows={2} maxLength={2000} value={comment} onChange={(e) => setComment(e.target.value)} />
          <div className="row">
            <button type="submit" className="btn btn-small btn-primary" disabled={state === 'sending'}>
              {state === 'sending' ? 'Sending…' : 'Send report'}
            </button>
            <button type="button" className="btn btn-small btn-ghost" onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
          {state === 'failed' ? (
            <p className="msg msg-error" role="alert">
              <span aria-hidden="true">✕ </span>
              {failure}
            </p>
          ) : null}
        </form>
      ) : null}
    </li>
  );
}

/** Every issue of the current draft, in plain language, each one a jump target. */
export function FeedbackPanel({ issues, activeIndex, onSelect, onReport, dismissed, canDismiss, onDismiss, canChange, onEdit, onFix }: Props) {
  const all = issues.map((i, n) => ({ i, n }));
  const shown = all.filter((x) => !dismissed.includes(x.n));
  const hidden = all.filter((x) => dismissed.includes(x.n));
  return (
    <section className="panel feedback" aria-labelledby="feedback-h">
      <h3 id="feedback-h" className="panel-title">
        Feedback panel <span className="count">{shown.length}</span>
      </h3>
      {issues.length === 0 ? (
        <p className="quiet" data-testid="no-issues">
          <span aria-hidden="true">✓ </span>The validators and the reviewer raised nothing on this draft.
        </p>
      ) : (
        <>
          <p className="quiet">
            Select an entry to jump to its line in the target script. Lines traced back to the source are marked there too.
            {canChange ? ' Use "Change output" to edit the target at that line yourself, or "Ask for a fix" to get a new draft.' : ''}
          </p>
          {shown.length === 0 ? <p className="quiet">Every warning was removed from view.</p> : null}
          <ol className="issues" data-testid="issue-list">
            {shown.map(({ i, n }) => (
              <IssueItem
                key={`${i.code}-${i.line ?? 'w'}-${i.sourceLine ?? 's'}-${n}`}
                issue={i}
                index={n}
                active={activeIndex === n}
                onSelect={onSelect}
                onReport={onReport}
                // an error can never be removed: it has to be fixed
                onRemove={canDismiss && i.severity !== 'error' ? () => onDismiss(n, true) : null}
                onEdit={canChange ? () => onEdit(i, n) : null}
                onFix={canChange ? () => onFix(i) : null}
              />
            ))}
          </ol>
          {hidden.length > 0 ? (
            <details className="removed" data-testid="issues-removed">
              <summary>
                Removed from view <span className="count">{hidden.length}</span>
              </summary>
              <p className="quiet">These stay in the record and in the saved report, marked as removed.</p>
              <ul className="removed-list">
                {hidden.map(({ i, n }) => (
                  <li key={`${i.code}-${n}`}>
                    <code className="rule">{i.code}</code>
                    <span>{i.message}</span>
                    {canDismiss ? (
                      <button type="button" className="btn btn-small btn-ghost" onClick={() => onDismiss(n, false)} data-testid="issue-restore">
                        Restore<span className="sr-only"> {i.code}</span>
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </>
      )}
    </section>
  );
}
