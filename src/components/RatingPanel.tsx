'use client';

import { useId, useState, type FormEvent } from 'react';
import type { RunView } from '@/lib/api-types';
import type { FeedbackBody } from './api';

interface Props {
  existing: RunView['rating'];
  onRate: (body: FeedbackBody) => Promise<void>;
}

const WORDS = ['', 'unusable', 'poor', 'acceptable', 'good', 'excellent'];

/** Asked once the output is final: a 1–5 rating and an optional comment. */
export function RatingPanel({ existing, onRate }: Props) {
  const id = useId();
  const [rating, setRating] = useState<number | null>(null);
  const [comment, setComment] = useState('');
  const [state, setState] = useState<'idle' | 'sending' | 'failed'>('idle');
  const [failure, setFailure] = useState('');

  if (existing) {
    return (
      <section className="panel panel-gold rating" aria-labelledby={`${id}-h`}>
        <h3 id={`${id}-h`} className="panel-title">
          Rating
        </h3>
        <p className="msg msg-ok" role="status" data-testid="rating-confirmation">
          <span aria-hidden="true">✓ </span>Thank you. Your rating of {existing.rating} out of 5 was recorded{existing.comment ? ' with your comment' : ''}.
        </p>
      </section>
    );
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (rating === null) return;
    setState('sending');
    try {
      const body: FeedbackBody = { rating };
      if (comment.trim()) body.comment = comment.trim();
      await onRate(body);
      setState('idle');
    } catch (err) {
      setFailure(err instanceof Error ? err.message : 'The rating could not be sent.');
      setState('failed');
    }
  };

  return (
    <section className="panel panel-gold rating" aria-labelledby={`${id}-h`}>
      <h3 id={`${id}-h`} className="panel-title">
        Rate this conversion
      </h3>
      <form onSubmit={submit}>
        <div role="group" aria-labelledby={`${id}-q`} className="rate-group">
          <p id={`${id}-q`} className="field-label">
            How good was the final output? (1 = unusable, 5 = excellent)
          </p>
          <div className="rate-row">
            {[1, 2, 3, 4, 5].map((n) => (
              <button key={n} type="button" className="rate-btn" aria-pressed={rating === n} aria-label={`${n} out of 5, ${WORDS[n]}`} onClick={() => setRating(n)} data-testid={`rate-${n}`}>
                <span className="rate-n">{n}</span>
                <span className="rate-w">{WORDS[n]}</span>
              </button>
            ))}
          </div>
        </div>
        <label htmlFor={`${id}-c`} className="field-label">
          Comment (optional)
        </label>
        <textarea id={`${id}-c`} className="input textarea" rows={2} maxLength={2000} value={comment} onChange={(e) => setComment(e.target.value)} data-testid="rating-comment" />
        <div className="row">
          <button type="submit" className="btn btn-primary" disabled={rating === null || state === 'sending'}>
            {state === 'sending' ? 'Sending…' : 'Send rating'}
          </button>
          {rating === null ? <span className="quiet">Choose a rating first.</span> : null}
        </div>
        {state === 'failed' ? (
          <p className="msg msg-error" role="alert">
            <span aria-hidden="true">✕ </span>
            {failure}
          </p>
        ) : null}
      </form>
    </section>
  );
}
