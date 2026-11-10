'use client';

import { useId, useState, type FormEvent } from 'react';
import type { IssueView } from '@/lib/api-types';
import type { FeedbackBody } from './api';

interface Props {
  issues: IssueView[];
  activeIndex: number | null;
  onSelect: (issue: IssueView, index: number) => void;
  onReport: (body: FeedbackBody) => Promise<void>;
}

function where(i: IssueView): string {
  if (i.line !== null) return `line ${i.line}${i.file ? ` in ${i.file}` : ''}`;
  return 'whole script';
}

function IssueItem({ issue, index, active, onSelect, onReport }: { issue: IssueView; index: number; active: boolean; onSelect: Props['onSelect']; onReport: Props['onReport'] }) {
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
        {state === 'sent' ? (
          <p className="msg msg-ok" role="status">
            <span aria-hidden="true">✓ </span>Problem reported. Thank you.
          </p>
        ) : (
          <button type="button" className="btn btn-small btn-ghost" aria-expanded={open} aria-controls={`${id}-f`} onClick={() => setOpen((o) => !o)}>
            Report a problem
          </button>
        )}
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
export function FeedbackPanel({ issues, activeIndex, onSelect, onReport }: Props) {
  return (
    <section className="panel feedback" aria-labelledby="feedback-h">
      <h3 id="feedback-h" className="panel-title">
        Feedback panel <span className="count">{issues.length}</span>
      </h3>
      {issues.length === 0 ? (
        <p className="quiet" data-testid="no-issues">
          <span aria-hidden="true">✓ </span>The validators and the reviewer raised nothing on this draft.
        </p>
      ) : (
        <>
          <p className="quiet">Select an entry to jump to its line in the target script. Lines traced back to the source are marked there too.</p>
          <ol className="issues" data-testid="issue-list">
            {issues.map((i, n) => (
              <IssueItem key={`${i.code}-${i.line ?? 'w'}-${i.sourceLine ?? 's'}-${n}`} issue={i} index={n} active={activeIndex === n} onSelect={onSelect} onReport={onReport} />
            ))}
          </ol>
        </>
      )}
    </section>
  );
}
