'use client';

import { useCallback, useEffect, useState } from 'react';
import type { StatusView } from '@/lib/api-types';
import { api, ApiError } from './api';

interface Props {
  token: string;
  onUnauthorized: () => void;
  /** Changes when a run changes, so the panel reloads. */
  refreshKey: string;
  /** Called after a run was deleted, so the page can close it if it is the one on screen. */
  onRunDeleted: (id: string) => void;
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

function Pairs({ data, empty, unit = '' }: { data: Record<string, number>; empty: string; unit?: string }) {
  const keys = Object.keys(data);
  if (keys.length === 0) return <p className="quiet">{empty}</p>;
  return (
    <dl className="pairs">
      {keys.map((k) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>
            {data[k]}
            {unit}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function witnessText(w: unknown): string {
  try {
    const text = JSON.stringify(w, null, 2);
    return text.length > 6000 ? `${text.slice(0, 6000)}\n… (truncated)` : text;
  } catch {
    return 'The witness report could not be shown.';
  }
}

export function StatusPanel({ token, onUnauthorized, refreshKey, onRunDeleted }: Props) {
  /** The run whose Delete button was pressed and is waiting for confirmation. */
  const [confirming, setConfirming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [runNote, setRunNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [data, setData] = useState<StatusView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [note, setNote] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.status(token));
      setError(null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) onUnauthorized();
      else setError(e instanceof ApiError ? `${e.code}: ${e.message}` : 'Status could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [token, onUnauthorized]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loading data from the server on open
    void load();
  }, [load, refreshKey]);

  const deleteRun = async (id: string) => {
    setDeleting(id);
    setRunNote(null);
    try {
      const r = await api.deleteRun(token, id);
      setRunNote({ ok: true, text: `Run ${r.id} was deleted.${r.savedCopyKept ? ' Its saved copy on GitHub was kept.' : ''}` });
      onRunDeleted(id);
      await load();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) onUnauthorized();
      else setRunNote({ ok: false, text: e instanceof ApiError ? `${e.code}: ${e.message}` : 'The run could not be deleted.' });
    } finally {
      setDeleting(null);
      setConfirming(null);
    }
  };

  const disable = async (id: string) => {
    try {
      const r = await api.disableRule(token, id);
      setNote(`Rule ${r.id} is now ${r.status}.`);
      await load();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) onUnauthorized();
      else setNote(e instanceof ApiError ? `${e.code}: ${e.message}` : 'The rule could not be disabled.');
    }
  };

  const m = data?.metrics;
  return (
    <section className="status" aria-labelledby="status-h" id="status-panel" data-testid="status-panel">
      <div className="status-head">
        <h2 id="status-h" className="section-title">
          Status
        </h2>
        <button type="button" className="btn btn-small btn-ghost" onClick={() => void load()} disabled={loading}>
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>
      <p className="sr-only" role="status" aria-live="polite">
        {note}
      </p>
      {note ? <p className="msg msg-ok">{note}</p> : null}
      {error ? (
        <p className="msg msg-error" role="alert">
          <span aria-hidden="true">✕ </span>
          {error}
        </p>
      ) : null}
      {!data && !error ? <p className="quiet">Loading status…</p> : null}
      {data && m ? (
        <div className="status-grid">
          <section className="panel" aria-labelledby="st-prov">
            <h3 id="st-prov" className="panel-title">
              Providers
            </h3>
            <ul className="chips">
              {Object.entries(data.providers).map(([name, mode]) => (
                <li key={name} className={`chip chip-${mode}`}>
                  {name}: <b>{mode}</b>
                </li>
              ))}
            </ul>
          </section>

          <section className="panel" aria-labelledby="st-state">
            <h3 id="st-state" className="panel-title">
              Runs by state
            </h3>
            <Pairs data={m.runsByState} empty="No runs yet." />
          </section>

          <section className="panel" aria-labelledby="st-rates">
            <h3 id="st-rates" className="panel-title">
              Rates and saves
            </h3>
            <dl className="pairs">
              <div>
                <dt>Repair rate</dt>
                <dd>{pct(m.repairRate)}</dd>
              </div>
              <div>
                <dt>Transient retry rate</dt>
                <dd>{pct(m.transientRetryRate)}</dd>
              </div>
              <div>
                <dt>GitHub save failures</dt>
                <dd>{m.githubSaveFailures}</dd>
              </div>
              <div>
                <dt>Rules promoted</dt>
                <dd>{m.rulesPromoted}</dd>
              </div>
              <div>
                <dt>Rules rejected</dt>
                <dd>{m.rulesRejected}</dd>
              </div>
            </dl>
          </section>

          <section className="panel" aria-labelledby="st-dur">
            <h3 id="st-dur" className="panel-title">
              Stage durations
            </h3>
            {Object.keys(m.stageDurations).length === 0 ? (
              <p className="quiet">No stage timings yet.</p>
            ) : (
              <div className="table-scroll">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Stage</th>
                      <th scope="col">p50 ms</th>
                      <th scope="col">p95 ms</th>
                      <th scope="col">Count</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(m.stageDurations).map(([stage, d]) => (
                      <tr key={stage}>
                        <th scope="row">{stage}</th>
                        <td>{d.p50}</td>
                        <td>{d.p95}</td>
                        <td>{d.count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="panel" aria-labelledby="st-fail">
            <h3 id="st-fail" className="panel-title">
              Failures by code
            </h3>
            <Pairs data={m.failuresByCode} empty="No failures recorded." />
          </section>

          <section className="panel" aria-labelledby="st-rate">
            <h3 id="st-rate" className="panel-title">
              Rating distribution
            </h3>
            <Pairs data={Object.fromEntries(Object.entries(m.ratingDistribution).map(([k, v]) => [`${k} / 5`, v]))} empty="No ratings yet." />
          </section>

          <section className="panel" aria-labelledby="st-mem">
            <h3 id="st-mem" className="panel-title">
              Skill memory
            </h3>
            <dl className="pairs">
              <div>
                <dt>Retrievals</dt>
                <dd>{m.memory.retrievals}</dd>
              </div>
              <div>
                <dt>Average latency</dt>
                <dd>{m.memory.avgLatencyMs} ms</dd>
              </div>
              <div>
                <dt>Average rule hits</dt>
                <dd>{m.memory.avgRuleHits}</dd>
              </div>
              <div>
                <dt>Unavailable</dt>
                <dd>{m.memory.unavailable}</dd>
              </div>
              <div>
                <dt>Pending index writes</dt>
                <dd>{m.memory.pendingIndexWrites}</dd>
              </div>
            </dl>
          </section>

          <section className="panel span-all" aria-labelledby="st-runs">
            <h3 id="st-runs" className="panel-title">
              Recent runs <span className="count">{data.runs.length}</span>
            </h3>
            <p className="quiet">Deleting a run removes its drafts, review record and feedback from storage and cannot be undone. A copy already saved to GitHub is kept.</p>
            {runNote ? (
              <p className={`msg ${runNote.ok ? 'msg-ok' : 'msg-error'}`} role="status" data-testid="run-delete-note">
                {runNote.text}
              </p>
            ) : null}
            {data.runs.length === 0 ? (
              <p className="quiet">No runs yet.</p>
            ) : (
              <div className="table-scroll" tabIndex={0} role="region" aria-labelledby="st-runs">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Run</th>
                      <th scope="col">State</th>
                      <th scope="col">Type</th>
                      <th scope="col">Target</th>
                      <th scope="col">Draft status</th>
                      <th scope="col">Repairs</th>
                      <th scope="col">Rating</th>
                      <th scope="col">Created</th>
                      <th scope="col">
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.runs.map((r) => (
                      <tr key={r.id}>
                        <th scope="row">
                          <code>{r.id}</code>
                        </th>
                        <td>{r.state}</td>
                        <td>{r.scriptType}</td>
                        <td>{r.platform}</td>
                        <td>{r.status ?? '–'}</td>
                        <td>{r.attempts}</td>
                        <td>{r.rating ?? '–'}</td>
                        <td>{r.createdAt.replace('T', ' ').slice(0, 19)}</td>
                        <td className="row-actions">
                          {confirming === r.id ? (
                            <>
                              <button type="button" className="btn btn-small btn-danger" onClick={() => void deleteRun(r.id)} disabled={deleting !== null} data-testid="run-delete-confirm">
                                {deleting === r.id ? 'Deleting…' : 'Delete for good'}
                              </button>
                              <button type="button" className="btn btn-small btn-ghost" onClick={() => setConfirming(null)} disabled={deleting !== null}>
                                Keep
                              </button>
                            </>
                          ) : (
                            <button type="button" className="btn btn-small btn-ghost" onClick={() => setConfirming(r.id)} disabled={deleting !== null} data-testid="run-delete">
                              Delete<span className="sr-only"> run {r.id}</span>
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="panel span-all" aria-labelledby="st-rules">
            <h3 id="st-rules" className="panel-title">
              Learned rules <span className="count">{data.rules.length}</span>
            </h3>
            {data.rules.length === 0 ? (
              <p className="quiet">No learned rules yet. Rules are proposed from approved conversions and promoted only after their witness run passes.</p>
            ) : (
              <ul className="rules" data-testid="rules">
                {data.rules.map((r) => (
                  <li key={`${r.id}-${r.version}`} className="rule-card">
                    <div className="change-head">
                      <code className="rule">{r.id}</code>
                      <span className={`state-pill state-${r.status}`}>status: {r.status}</span>
                      <span className="change-lines">
                        v{r.version} · {r.platform}
                      </span>
                      {r.status === 'promoted' ? (
                        <button type="button" className="btn btn-small btn-ghost" onClick={() => void disable(r.id)} aria-label={`Disable rule ${r.id}`}>
                          Disable
                        </button>
                      ) : null}
                    </div>
                    <p className="change-summary">{r.guidance}</p>
                    {r.trigger.length ? <p className="quiet">Applies to: {r.trigger.join(', ')}</p> : null}
                    {r.rejectReason ? <p className="quiet">Rejected because: {r.rejectReason}</p> : null}
                    {r.sourceRunId ? (
                      <p className="quiet">
                        Proposed from <code>{r.sourceRunId}</code>
                      </p>
                    ) : null}
                    {r.witness ? (
                      <details className="witness">
                        <summary>Witness report</summary>
                        <pre tabIndex={0}>{witnessText(r.witness)}</pre>
                      </details>
                    ) : (
                      <p className="quiet">No witness report yet.</p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      ) : null}
    </section>
  );
}
