import type { DraftView, RunView } from '@/lib/api-types';

const RISK_GLYPH: Record<string, string> = { low: '▁', medium: '▃', high: '▇' };
const RETIRED = 'After 19c is retired';

interface Props {
  run: RunView;
  draft: DraftView;
  /** True while the draft can still be changed (not approved, latest version). */
  canDismiss: boolean;
  onDismiss: (kind: 'change' | 'issue', index: number, dismissed: boolean) => void;
}

/** The change list, sanitization summary, warnings by code and suggestions for one draft. */
export function ReviewPanel({ run, draft, canDismiss, onDismiss }: Props) {
  const removed = draft.dismissed.changes;
  const shown = draft.changes.map((c, i) => ({ c, i })).filter((x) => !removed.includes(x.i));
  const hidden = draft.changes.map((c, i) => ({ c, i })).filter((x) => removed.includes(x.i));
  const groups = new Map<string, { severity: string; count: number; lines: string[] }>();
  for (const i of draft.issues) {
    const g = groups.get(i.code) ?? { severity: i.severity, count: 0, lines: [] };
    g.count++;
    g.lines.push(i.line === null ? (i.sourceLine ? `source line ${i.sourceLine}` : 'whole script') : `line ${i.line}`);
    groups.set(i.code, g);
  }
  const later = draft.suggestions.filter((s) => s.title.startsWith(RETIRED));
  const now = draft.suggestions.filter((s) => !s.title.startsWith(RETIRED));
  const counts = run.sanitization.counts;

  return (
    <div className="review-stack">
      <section className="panel" aria-labelledby="changes-h">
        <h3 id="changes-h" className="panel-title">
          Change list <span className="count">{shown.length}</span>
        </h3>
        {draft.changes.length === 0 ? (
          <p className="quiet">No changes were needed.</p>
        ) : (
          <>
            {shown.length === 0 ? <p className="quiet">Every change was deleted from the list.</p> : null}
            <ol className="changes" data-testid="change-list">
              {shown.map(({ c, i }) => (
                <li key={`${c.ruleId}-${i}`} className="change">
                  <div className="change-head">
                    <code className="rule">{c.ruleId}</code>
                    <span className="change-lines">lines: {c.lines}</span>
                    <span className={`risk risk-${c.risk}`}>
                      <span aria-hidden="true">{RISK_GLYPH[c.risk]} </span>
                      {c.risk} risk
                    </span>
                    {canDismiss ? (
                      <button type="button" className="btn btn-small btn-ghost item-remove" onClick={() => onDismiss('change', i, true)} data-testid="change-remove">
                        Delete<span className="sr-only"> change {c.ruleId} from the list</span>
                      </button>
                    ) : null}
                  </div>
                  <p className="change-summary">{c.summary}</p>
                  <p className="change-reason">
                    <span className="tiny-label">Why</span> {c.reason}
                  </p>
                </li>
              ))}
            </ol>
            {hidden.length > 0 ? (
              <details className="removed" data-testid="changes-removed">
                <summary>
                  Deleted <span className="count">{hidden.length}</span>
                </summary>
                <p className="quiet">Deleted from this list. They stay in the saved record, marked as deleted, and can be restored until you approve.</p>
                <ul className="removed-list">
                  {hidden.map(({ c, i }) => (
                    <li key={`${c.ruleId}-${i}`}>
                      <code className="rule">{c.ruleId}</code>
                      <span>{c.summary}</span>
                      {canDismiss ? (
                        <button type="button" className="btn btn-small btn-ghost" onClick={() => onDismiss('change', i, false)} data-testid="change-restore">
                          Restore<span className="sr-only"> change {c.ruleId}</span>
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

      <section className="panel panel-gold" aria-labelledby="san-h">
        <h3 id="san-h" className="panel-title">
          Sanitization
        </h3>
        <p data-testid="sanitization-summary">{run.sanitization.summary || 'Nothing needed replacing.'}</p>
        <ul className="chips" aria-label="Replaced items by kind">
          {(Object.keys(counts) as (keyof typeof counts)[]).map((k) => (
            <li key={k} className="chip">
              <b>{counts[k]}</b> {k}
            </li>
          ))}
        </ul>
        <p className="quiet">Counts only. The original values are never stored or shown.</p>
      </section>

      <section className="panel" aria-labelledby="warn-h">
        <h3 id="warn-h" className="panel-title">
          Warnings by code <span className="count">{draft.issues.length}</span>
        </h3>
        {groups.size === 0 ? (
          <p className="quiet">
            <span aria-hidden="true">✓ </span>No warnings or errors on this draft.
          </p>
        ) : (
          <ul className="groups" data-testid="warning-groups">
            {[...groups.entries()].map(([code, g]) => (
              <li key={code} className="group">
                <span className={`sev sev-${g.severity}`}>
                  <span aria-hidden="true">{g.severity === 'error' ? '✕' : '▲'} </span>
                  {g.severity}
                </span>
                <code className="rule">{code}</code>
                <span className="group-count">× {g.count}</span>
                <span className="group-lines">{g.lines.join(', ')}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel" aria-labelledby="sug-h">
        <h3 id="sug-h" className="panel-title">
          Suggestions <span className="tag-note">not applied</span>
        </h3>
        {draft.suggestions.length === 0 ? <p className="quiet">No suggestions for this draft.</p> : null}
        {now.length > 0 ? (
          <ul className="suggestions">
            {now.map((s) => (
              <li key={s.title}>
                <b>{s.title}</b>
                <span>{s.detail}</span>
              </li>
            ))}
          </ul>
        ) : null}
        {later.length > 0 ? (
          <div className="later" data-testid="after-19c">
            <h4 className="later-title">
              <span aria-hidden="true">⏳ </span>
              {RETIRED}
            </h4>
            <p className="quiet">These forms exist only in 26ai. They are listed for later and are not in the draft.</p>
            <ul className="suggestions">
              {later.map((s) => (
                <li key={s.title}>
                  <b>{s.title}</b>
                  <span>{s.detail}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>
    </div>
  );
}
