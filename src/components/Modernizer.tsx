'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type { IssueView, RunView } from '@/lib/api-types';
import { api, ApiError, session, type ApiErrorInfo, type FeedbackBody, type SelectableType, type StageEvent } from './api';
import { CodeEditor, type JumpTarget } from './CodeEditor';
import { DiffView } from './DiffView';
import { languageForFile, languageForSource } from './editor-setup';
import { FeedbackPanel } from './FeedbackPanel';
import { RatingPanel } from './RatingPanel';
import { ReviewPanel } from './ReviewPanel';
import { copyText, downloadText, latestDraft, sourceLanguageOf, stagesOf, STATUS_TEXT } from './run-helpers';
import { SAMPLES } from './samples';
import { emptyStages, StageTrack, type StageMap } from './StageTrack';
import { StatusPanel } from './StatusPanel';
import { TargetBar } from './TargetBar';
import { TokenGate } from './TokenGate';

type Busy = null | 'restoring' | 'converting' | 'revising' | 'approving';

const TYPES: { value: SelectableType; label: string }[] = [
  { value: 'auto', label: 'Auto-detect' },
  { value: 'sql', label: 'SQL' },
  { value: 'plsql', label: 'PL/SQL' },
  { value: 'sqlplus', label: 'SQL*Plus' },
  { value: 'shell', label: 'Shell' },
  { value: 'mixed', label: 'Mixed shell + SQL' },
];
const MAX_RESUMES = 40;

export function Modernizer() {
  const [mounted, setMounted] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [gateError, setGateError] = useState<string | null>(null);
  const [providers, setProviders] = useState<Record<string, string> | null>(null);

  const [source, setSource] = useState('');
  const [scriptType, setScriptType] = useState<SelectableType>('auto');
  const [generateConfig, setGenerateConfig] = useState(false);

  const [run, setRun] = useState<RunView | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<ApiErrorInfo | null>(null);
  const [stages, setStages] = useState<StageMap>(emptyStages);
  const [unit, setUnit] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const repairSeen = useRef(false);

  const [version, setVersion] = useState<number | null>(null);
  const [fileName, setFileName] = useState('');
  const [showDiff, setShowDiff] = useState(false);
  const [diffBase, setDiffBase] = useState<'source' | number>('source');
  const [wide, setWide] = useState(true);
  const [targetJump, setTargetJump] = useState<(JumpTarget & { file: string; version: number }) | null>(null);
  const [sourceJump, setSourceJump] = useState<JumpTarget | null>(null);
  const [activeIssue, setActiveIssue] = useState<number | null>(null);
  const nonce = useRef(0);

  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState('');
  const [statusOpen, setStatusOpen] = useState(false);
  const [toast, setToast] = useState('');

  const unauthorized = useCallback(() => {
    session.setToken(null);
    setToken(null);
    setGateError('The access token was rejected. Enter it again.');
  }, []);

  const fail = useCallback(
    (e: unknown) => {
      if (e instanceof ApiError && e.status === 401) unauthorized();
      else if (e instanceof ApiError) setError({ code: e.code, message: e.message, status: e.status });
      else setError({ code: 'CLIENT_ERROR', message: e instanceof Error ? e.message : 'Something went wrong in the browser.', status: 0 });
    },
    [unauthorized],
  );

  const adopt = useCallback((r: RunView) => {
    setRun(r);
    session.setRunId(r.id);
    setSource(r.sanitizedSource);
    const d = latestDraft(r);
    const shown = r.final ? (r.drafts.find((x) => x.version === r.final?.version) ?? d) : d;
    setVersion(shown?.version ?? null);
    setFileName((prev) => (shown?.files.some((f) => f.name === prev) ? prev : (shown?.files[0]?.name ?? '')));
    setStages(stagesOf(r, repairSeen.current));
    setUnit(null);
    if (r.error) setError(r.error);
  }, []);

  const onStage = useCallback((e: StageEvent) => {
    if (e.stage === 'repair') repairSeen.current = true;
    setStages((prev) => ({ ...prev, [e.stage]: e.status === 'start' ? 'active' : 'done' }));
    setUnit(e.status === 'start' ? e.unitId : null);
    if (e.status === 'start') setAnnouncement(`Stage ${e.stage}${e.unitId ? ` for ${e.unitId}` : ''} is running.`);
  }, []);

  /** Runs one pipeline call, then resumes while the server says the run was cut off. */
  const drive = useCallback(
    async (kind: Busy, tok: string, start: () => Promise<RunView>) => {
      setBusy(kind);
      setError(null);
      setActiveIssue(null);
      setTargetJump(null);
      setSourceJump(null);
      try {
        let r = await start();
        for (let i = 0; r.resumable && i < MAX_RESUMES; i++) {
          adopt(r);
          const id = r.id;
          r = await api.resume(tok, id, onStage);
        }
        adopt(r);
        const d = latestDraft(r);
        setAnnouncement(d ? `Draft version ${d.version} is ready. Status: ${STATUS_TEXT[d.status]}.` : 'The run ended without a draft.');
      } catch (e) {
        fail(e);
        setStages((prev) => {
          const next = { ...prev };
          for (const k of Object.keys(next) as (keyof StageMap)[]) if (next[k] === 'active') next[k] = 'pending';
          return next;
        });
        setAnnouncement('The conversion stopped with an error.');
      } finally {
        setBusy(null);
      }
    },
    [adopt, fail, onStage],
  );

  // First mount: read the session, recover the current run after a reload.
  useEffect(() => {
    const tok = session.token();
    const id = session.runId();
    /* eslint-disable react-hooks/set-state-in-effect -- one-time read of browser-only state */
    setMounted(true);
    setToken(tok);
    /* eslint-enable react-hooks/set-state-in-effect */
    const mq = window.matchMedia('(min-width: 1000px)');
    const onMq = () => setWide(mq.matches);
    onMq();
    mq.addEventListener('change', onMq);
    let cancelled = false;
    fetch('/api/health', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((h: { providers?: Record<string, string> } | null) => {
        if (!cancelled && h?.providers) setProviders(h.providers);
      })
      .catch(() => {});
    if (tok && id) {
      setBusy('restoring');
      api
        .run(tok, id)
        .then((r) => {
          if (cancelled) return;
          adopt(r);
          setBusy(null);
          if (r.resumable || r.state === 'changes_requested' || r.state === 'sanitized') void drive(r.state === 'changes_requested' ? 'revising' : 'converting', tok, () => api.resume(tok, r.id, onStage));
        })
        .catch((e: unknown) => {
          if (cancelled) return;
          setBusy(null);
          if (e instanceof ApiError && e.status === 404) session.setRunId(null);
          else fail(e);
        });
    }
    return () => {
      cancelled = true;
      mq.removeEventListener('change', onMq);
    };
  }, [adopt, drive, fail, onStage]);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(''), 4000);
    return () => window.clearTimeout(t);
  }, [toast]);

  const unlock = (t: string) => {
    session.setToken(t);
    setGateError(null);
    setToken(t);
    const id = session.runId();
    if (id && !run) {
      api
        .run(t, id)
        .then(adopt)
        .catch((e: unknown) => {
          if (e instanceof ApiError && e.status === 404) session.setRunId(null);
          else fail(e);
        });
    }
  };

  const convert = (e: FormEvent) => {
    e.preventDefault();
    if (!token || busy) return;
    repairSeen.current = false;
    setStages(emptyStages());
    setRun(null);
    session.setRunId(null);
    setShowDiff(false);
    setNoteOpen(false);
    void drive('converting', token, () => api.convert(token, { source, scriptType, options: { generateConfig } }, onStage));
  };

  const revise = (e: FormEvent) => {
    e.preventDefault();
    if (!token || !run || busy || !note.trim()) return;
    repairSeen.current = false;
    setStages({ ...emptyStages(), intake: 'done' });
    const text = note.trim();
    setNoteOpen(false);
    setNote('');
    setShowDiff(false);
    void drive('revising', token, () => api.revise(token, run.id, text, onStage));
  };

  const approve = async () => {
    if (!token || !run || busy) return;
    setBusy('approving');
    setError(null);
    try {
      const r = await api.approve(token, run.id);
      adopt(r);
      setAnnouncement(r.state === 'saved' ? 'Approved and saved to GitHub. This is the final version.' : `Approved, but the save to GitHub failed: ${r.save?.error ?? 'unknown error'}`);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  };

  const sendFeedback = useCallback(
    async (body: FeedbackBody, adoptResult: boolean) => {
      if (!token || !run) return;
      try {
        const r = await api.feedback(token, run.id, body);
        if (adoptResult) setRun(r);
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) unauthorized();
        throw e;
      }
    },
    [token, run, unauthorized],
  );

  const reset = () => {
    setRun(null);
    session.setRunId(null);
    setSource('');
    setError(null);
    setStages(emptyStages());
    setShowDiff(false);
    setNoteOpen(false);
    setAnnouncement('Ready for a new script.');
  };

  const draft = run ? (run.drafts.find((d) => d.version === version) ?? latestDraft(run)) : null;
  const file = draft ? (draft.files.find((f) => f.name === fileName) ?? draft.files[0] ?? null) : null;
  const mainFile = draft?.files[0] ?? null;
  const latest = latestDraft(run);
  const sourceIsSanitized = run !== null && source === run.sanitizedSource;
  const saved = run?.state === 'saved';
  const saveFailed = run?.state === 'approved';
  const canAct = run?.state === 'draft_ready' && !busy;
  const viewingLatest = draft !== null && latest !== null && draft.version === latest.version;
  const sourceLang = run && sourceIsSanitized ? sourceLanguageOf(run) : languageForSource(scriptType, source);
  const diffBefore = run && draft ? (diffBase === 'source' ? run.sanitizedSource : (run.drafts.find((d) => d.version === diffBase)?.files[0]?.content ?? run.sanitizedSource)) : '';
  const diffBeforeIsSource = diffBase === 'source' || !run?.drafts.some((d) => d.version === diffBase);
  const phase = busy === 'converting' ? 'loading' : busy === 'revising' ? 'revising' : saved ? 'final' : saveFailed ? 'save-failed' : error && !draft ? 'error' : draft ? 'draft' : 'empty';

  const selectIssue = (issue: IssueView, index: number) => {
    if (!draft) return;
    nonce.current += 1;
    setActiveIssue(index);
    setShowDiff(false);
    const target = issue.file && draft.files.some((f) => f.name === issue.file) ? issue.file : (draft.files[0]?.name ?? '');
    setFileName(target);
    setTargetJump(issue.line !== null ? { line: issue.line, nonce: nonce.current, file: target, version: draft.version } : null);
    setSourceJump(issue.sourceLine && sourceIsSanitized ? { line: issue.sourceLine, nonce: nonce.current } : null);
    const where = issue.line !== null ? `Line ${issue.line} is highlighted in the target script.` : issue.sourceLine ? `Source line ${issue.sourceLine} is highlighted.` : 'This issue applies to the whole script.';
    setToast(`${issue.code}: ${where}`);
    if (issue.line !== null || issue.sourceLine) {
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      // the editors remount when the diff closes, so wait one frame before scrolling to them
      window.requestAnimationFrame(() => document.getElementById(issue.line !== null ? 'target-pane' : 'source-pane')?.scrollIntoView({ block: 'center', behavior: reduced ? 'auto' : 'smooth' }));
    }
  };

  if (!mounted) {
    return (
      <main id="main" className="main">
        <p className="quiet boot">Loading the workbench…</p>
      </main>
    );
  }

  return (
    <main id="main" className="main" data-phase={phase} data-testid="main">
      <p className="sr-only" role="status" aria-live="polite" data-testid="toast-live">
        {toast}
      </p>

      {!token ? (
        <TokenGate error={gateError} onSubmit={unlock} />
      ) : (
        <>
          <section className="bench" aria-labelledby="bench-h">
            <h2 id="bench-h" className="sr-only">
              Convert a script
            </h2>
            <form className="controls" onSubmit={convert}>
              <div className="field">
                <label htmlFor="script-type" className="field-label">
                  Script type
                </label>
                <select id="script-type" className="input select" value={scriptType} onChange={(e) => setScriptType(e.target.value as SelectableType)}>
                  {TYPES.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </div>
              <label className="check">
                <input type="checkbox" checked={generateConfig} onChange={(e) => setGenerateConfig(e.target.checked)} />
                <span>Generate config file</span>
              </label>
              <div className="field" role="group" aria-label="Load example">
                <span className="field-label" aria-hidden="true">
                  Load example
                </span>
                <div className="row">
                  {SAMPLES.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      className="btn btn-small btn-ghost"
                      disabled={busy !== null}
                      onClick={() => {
                        setSource(s.source);
                        setSourceJump(null);
                        setToast(`Example loaded: ${s.label}.`);
                      }}
                      data-testid={`example-${s.id}`}
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="controls-go">
                {run ? (
                  <button type="button" className="btn btn-ghost" onClick={reset} disabled={busy !== null}>
                    New script
                  </button>
                ) : null}
                <button type="submit" className="btn btn-primary btn-big" disabled={busy !== null || source.trim() === ''} data-testid="convert">
                  {busy === 'converting' ? 'Converting…' : 'Convert'}
                  <span aria-hidden="true"> →</span>
                </button>
              </div>
            </form>

            <StageTrack stages={stages} unit={unit} announcement={announcement} />

            {busy === 'revising' ? (
              <p className="banner banner-busy" role="status" data-testid="revising-banner">
                <span className="spinner" aria-hidden="true" />
                Changes requested. A new draft version is being written; the previous draft stays visible until it arrives.
              </p>
            ) : null}
            {busy === 'restoring' ? (
              <p className="banner banner-busy" role="status">
                <span className="spinner" aria-hidden="true" />
                Restoring your run…
              </p>
            ) : null}

            {error ? (
              <div className="banner banner-error" role="alert" data-testid="error-banner">
                <p className="banner-title">
                  <span aria-hidden="true">✕ </span>
                  <code>{error.code}</code>
                  {error.status ? <span className="quiet"> (HTTP {error.status})</span> : null}
                </p>
                <p>{error.message}</p>
                <button type="button" className="btn btn-small btn-ghost" onClick={() => setError(null)}>
                  Dismiss
                </button>
              </div>
            ) : null}

            {saved && run?.save?.commit ? (
              <div className="banner banner-final" data-testid="final-banner">
                <p className="banner-title">
                  <span className="stamp stamp-final">Final</span> Approved and saved to GitHub
                </p>
                <dl className="commit" data-testid="commit-ref">
                  <div>
                    <dt>Commit</dt>
                    <dd>
                      <a href={run.save.commit.url} rel="noopener noreferrer" target="_blank" data-testid="commit-link">
                        <code>{run.save.commit.sha.slice(0, 7)}</code>
                        <span className="sr-only"> (opens GitHub in a new tab)</span>
                      </a>
                    </dd>
                  </div>
                  <div>
                    <dt>Branch</dt>
                    <dd>
                      <code>{run.save.commit.branch}</code>
                    </dd>
                  </div>
                  <div>
                    <dt>Path</dt>
                    <dd>
                      <code>{run.save.commit.path}</code>
                    </dd>
                  </div>
                </dl>
              </div>
            ) : null}

            {saveFailed ? (
              <div className="banner banner-error" role="alert" data-testid="save-failed">
                <p className="banner-title">
                  <span aria-hidden="true">✕ </span>Approved, but not saved to GitHub
                </p>
                <p>{run?.save?.error ?? 'The save did not finish.'}</p>
                <p className="quiet">Your approval of version {run?.final?.version} is recorded. Nothing is lost; retry the save.</p>
                <button type="button" className="btn btn-primary" onClick={() => void approve()} disabled={busy !== null} data-testid="retry-save">
                  {busy === 'approving' ? 'Saving…' : 'Retry save'}
                </button>
              </div>
            ) : null}

            {run && draft && file ? (
              <TargetBar
                run={run}
                draft={draft}
                fileName={file.name}
                showDiff={showDiff}
                diffBase={diffBase}
                onVersion={(v) => {
                  setVersion(v);
                  setActiveIssue(null);
                  setTargetJump(null);
                  if (diffBase === v) setDiffBase('source');
                }}
                onFile={setFileName}
                onToggleDiff={() => setShowDiff((s) => !s)}
                onDiffBase={setDiffBase}
                onCopy={() => void copyText(file.content).then((ok) => setToast(ok ? `Copied ${file.name} to the clipboard.` : 'Copying is blocked by the browser. Use Download instead.'))}
                onDownload={() => {
                  downloadText(file.name, file.content);
                  setToast(`Downloaded ${file.name}.`);
                }}
              />
            ) : null}
            {toast ? (
              <p className="toast" aria-hidden="true">
                {toast}
              </p>
            ) : null}

            {showDiff && run && draft && mainFile ? (
              <DiffView
                before={diffBefore}
                after={mainFile.content}
                beforeLabel={diffBeforeIsSource ? 'sanitized source' : `draft v${diffBase}`}
                afterLabel={`${mainFile.name} (v${draft.version})`}
                beforeLanguage={diffBeforeIsSource ? sourceLanguageOf(run) : languageForFile(mainFile)}
                afterLanguage={languageForFile(mainFile)}
                layout={wide ? 'split' : 'unified'}
              />
            ) : (
              <div className="editors">
                <div className="pane pane-in" id="source-pane">
                  <div className="pane-head">
                    <span className="pane-tag" aria-hidden="true">
                      IN
                    </span>
                    <h3 className="pane-title">Source script</h3>
                    <span className="pane-sub">{run && sourceIsSanitized ? 'sanitized' : 'Oracle 19c SQL, PL/SQL, SQL*Plus, ksh or bash'}</span>
                  </div>
                  <div className="pane-body">
                    <CodeEditor
                      value={source}
                      onChange={setSource}
                      readOnly={busy !== null}
                      language={sourceLang}
                      tone="paper"
                      label="Source script"
                      flagLines={sourceIsSanitized ? run.sanitization.highlightLines : []}
                      jump={sourceIsSanitized ? sourceJump : null}
                      testId="source-editor"
                    />
                    {source === '' ? (
                      <p className="pane-hint" aria-hidden="true">
                        Paste a legacy script here, or load an example.
                      </p>
                    ) : null}
                  </div>
                  <p className="pane-note" data-testid="source-note">
                    {run && sourceIsSanitized ? (
                      <>
                        <span aria-hidden="true">◆ </span>This is the sanitized source: names, hosts, users, addresses and secrets were replaced before anything was sent or stored. Your raw
                        input is not kept.
                        {run.sanitization.highlightLines.length > 0 ? ' Dotted lines: the host role was ambiguous, check the placeholder.' : ''}
                      </>
                    ) : run ? (
                      <>
                        <span aria-hidden="true">▲ </span>You edited the source. The script on the right still belongs to the earlier sanitized source; Convert starts a new run.
                      </>
                    ) : (
                      <>Sanitized on arrival. After conversion this editor shows the sanitized text, not what you pasted.</>
                    )}
                  </p>
                </div>

                <div className="pane pane-out" id="target-pane">
                  <div className="pane-head">
                    <span className="pane-tag" aria-hidden="true">
                      OUT
                    </span>
                    <h3 className="pane-title">Target script</h3>
                    <span className="pane-sub">{file ? file.name : 'runs on 19c and 26ai, or Python'}</span>
                  </div>
                  <div className="pane-body">
                    <CodeEditor
                      value={file?.content ?? ''}
                      readOnly
                      language={file ? languageForFile(file) : 'text'}
                      tone="ink"
                      label={file ? `Target script, ${file.name}, read only` : 'Target script, empty'}
                      jump={targetJump && file && draft && targetJump.file === file.name && targetJump.version === draft.version ? targetJump : null}
                      testId="target-editor"
                    />
                    {!file ? (
                      <p className="pane-hint pane-hint-ink" data-testid="target-hint">
                        {busy === 'converting' ? 'Converting… the draft appears here.' : 'The reviewed draft appears here after you press Convert.'}
                      </p>
                    ) : null}
                  </div>
                  <p className="pane-note">{file ? (saved ? 'Final output, as committed.' : 'Read-only. Review it, then approve or request changes below.') : 'Nothing is saved until you approve.'}</p>
                </div>
              </div>
            )}

            {run && draft && run.state !== 'saved' && run.state !== 'approved' ? (
              <div className="decide" data-testid="decide">
                <div className="row">
                  <button type="button" className="btn btn-primary btn-big" onClick={() => void approve()} disabled={!canAct || !viewingLatest} data-testid="approve">
                    {busy === 'approving' ? 'Approving…' : `Approve version ${latest?.version ?? ''}`}
                  </button>
                  <button type="button" className="btn btn-ghost btn-big" aria-expanded={noteOpen} aria-controls="revise-form" onClick={() => setNoteOpen((o) => !o)} disabled={busy !== null} data-testid="request-changes">
                    Request changes
                  </button>
                  {!viewingLatest ? <span className="quiet">You are viewing an older version. Approval applies to the latest one; switch to v{latest?.version} to approve.</span> : null}
                  {run.state !== 'draft_ready' && !busy ? <span className="quiet">This run is in state “{run.state}” and cannot be approved.</span> : null}
                </div>
                {noteOpen ? (
                  <form id="revise-form" className="revise" onSubmit={revise}>
                    <label htmlFor="revise-note" className="field-label">
                      What should change in the next draft?
                    </label>
                    <textarea id="revise-note" className="input textarea" rows={3} maxLength={2000} required value={note} onChange={(e) => setNote(e.target.value)} data-testid="revise-note" />
                    <div className="row">
                      <button type="submit" className="btn btn-primary" disabled={busy !== null || note.trim() === ''} data-testid="revise-submit">
                        Send and redraft
                      </button>
                      <button type="button" className="btn btn-ghost" onClick={() => setNoteOpen(false)}>
                        Cancel
                      </button>
                    </div>
                  </form>
                ) : null}
              </div>
            ) : null}
          </section>

          {run && draft ? (
            <section className="review" aria-labelledby="review-h">
              <h2 id="review-h" className="section-title">
                {saved || saveFailed ? 'Final review record' : 'Review the draft'} <span className="quiet">version {draft.version}</span>
              </h2>
              <div className="review-grid">
                <ReviewPanel run={run} draft={draft} />
                <div className="review-stack">
                  {saved || saveFailed ? <RatingPanel existing={run.rating} onRate={(b) => sendFeedback(b, true)} /> : null}
                  <FeedbackPanel key={`${run.id}-${draft.version}`} issues={draft.issues} activeIndex={activeIssue} onSelect={selectIssue} onReport={(b) => sendFeedback(b, false)} />
                  {run.reviewerNotes.length > 0 ? (
                    <section className="panel" aria-labelledby="notes-h">
                      <h3 id="notes-h" className="panel-title">
                        Reviewer notes
                      </h3>
                      <ul className="suggestions">
                        {run.reviewerNotes.map((n) => (
                          <li key={n.at}>
                            <b>{n.at.replace('T', ' ').slice(0, 19)}</b>
                            <span>{n.note}</span>
                          </li>
                        ))}
                      </ul>
                    </section>
                  ) : null}
                </div>
              </div>
            </section>
          ) : null}

          <section className="status-toggle">
            <button type="button" className="btn btn-ghost" aria-expanded={statusOpen} aria-controls="status-panel" onClick={() => setStatusOpen((o) => !o)} data-testid="status-toggle">
              <span aria-hidden="true">{statusOpen ? '▾ ' : '▸ '}</span>Status
            </button>
            <span className="quiet">
              {providers ? `Providers: ${Object.entries(providers).map(([k, v]) => `${k} ${v}`).join(' · ')}` : 'Runs, metrics, providers and learned rules'}
            </span>
          </section>
          {statusOpen ? <StatusPanel token={token} onUnauthorized={unauthorized} refreshKey={`${run?.id ?? ''}:${run?.updatedAt ?? ''}`} /> : null}
        </>
      )}
    </main>
  );
}
