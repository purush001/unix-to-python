import type { RunView, StatusView, StreamEvent } from '@/lib/api-types';
import type { IssueCode } from '@/pipeline/issue-codes';
import type { StageName } from '@/pipeline/types';

export type SelectableType = 'auto' | 'sql' | 'plsql' | 'sqlplus' | 'shell' | 'mixed';

export interface ApiErrorInfo {
  code: string;
  message: string;
  status: number;
}

export class ApiError extends Error {
  code: string;
  status: number;
  constructor(info: ApiErrorInfo) {
    super(info.message);
    this.name = 'ApiError';
    this.code = info.code;
    this.status = info.status;
  }
}

export interface StageEvent {
  stage: StageName;
  unitId: string | null;
  status: 'start' | 'done';
}

const TOKEN_KEY = 'sm.accessToken';
const RUN_KEY = 'sm.runId';

function read(key: string): string | null {
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string | null): void {
  try {
    if (value === null) window.sessionStorage.removeItem(key);
    else window.sessionStorage.setItem(key, value);
  } catch {
    /* storage unavailable: the page still works for this tab */
  }
}

export const session = {
  token: () => read(TOKEN_KEY),
  setToken: (t: string | null) => write(TOKEN_KEY, t),
  runId: () => read(RUN_KEY),
  setRunId: (id: string | null) => write(RUN_KEY, id),
  flag: (key: string) => read(key) === '1',
  setFlag: (key: string) => write(key, '1'),
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function toError(body: unknown, status: number): ApiError {
  if (isRecord(body) && isRecord(body.error)) {
    const e = body.error;
    return new ApiError({
      code: typeof e.code === 'string' ? e.code : 'ERROR',
      message: typeof e.message === 'string' ? e.message : 'The request failed.',
      status: typeof e.status === 'number' ? e.status : status,
    });
  }
  return new ApiError({ code: `HTTP_${status}`, message: `The server answered with status ${status}.`, status });
}

async function send(token: string, path: string, init: { method?: string; body?: unknown; stream?: boolean } = {}): Promise<Response> {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  if (init.stream) headers.Accept = 'application/x-ndjson';
  try {
    return await fetch(path, { method: init.method ?? 'GET', headers, body: init.body === undefined ? undefined : JSON.stringify(init.body), cache: 'no-store' });
  } catch {
    throw new ApiError({ code: 'NETWORK_ERROR', message: 'The server could not be reached. Check the connection and try again.', status: 0 });
  }
}

async function json<T>(token: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await send(token, path, init);
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) throw toError(body, res.status);
  return body as T;
}

/** Runs a streaming pipeline call. Handles both the NDJSON stream and the plain JSON error/result shapes. */
async function pipeline(token: string, path: string, body: unknown, onStage: (e: StageEvent) => void): Promise<RunView> {
  const res = await send(token, path, { method: 'POST', body, stream: true });
  const type = res.headers.get('content-type') ?? '';
  if (!type.includes('application/x-ndjson') || !res.body) {
    let parsed: unknown = null;
    try {
      parsed = await res.json();
    } catch {
      parsed = null;
    }
    if (!res.ok) throw toError(parsed, res.status);
    return parsed as RunView;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result: RunView | null = null;
  const handle = (line: string) => {
    if (!line.trim()) return;
    const event = JSON.parse(line) as StreamEvent;
    if (event.type === 'stage') onStage({ stage: event.stage, unitId: event.unitId, status: event.status });
    else if (event.type === 'result') result = event.run;
    else throw new ApiError(event.error);
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl = buffer.indexOf('\n');
    while (nl >= 0) {
      handle(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
      nl = buffer.indexOf('\n');
    }
  }
  handle(buffer + decoder.decode());
  if (!result) throw new ApiError({ code: 'STREAM_ENDED', message: 'The connection closed before the result arrived. Reload the page to recover the run.', status: 0 });
  return result;
}

export interface FeedbackBody {
  rating?: number;
  comment?: string;
  errorCode?: IssueCode;
  line?: number;
}

export const api = {
  convert: (token: string, body: { source: string; scriptType: SelectableType; options: { generateConfig: boolean } }, onStage: (e: StageEvent) => void) => pipeline(token, '/api/convert', body, onStage),
  revise: (token: string, id: string, note: string, onStage: (e: StageEvent) => void) => pipeline(token, `/api/runs/${encodeURIComponent(id)}/revise`, { note }, onStage),
  resume: (token: string, id: string, onStage: (e: StageEvent) => void) => pipeline(token, `/api/runs/${encodeURIComponent(id)}/resume`, undefined, onStage),
  approve: (token: string, id: string) => json<RunView>(token, `/api/runs/${encodeURIComponent(id)}/approve`, { method: 'POST' }),
  feedback: (token: string, id: string, body: FeedbackBody) => json<RunView>(token, `/api/runs/${encodeURIComponent(id)}/feedback`, { method: 'POST', body }),
  run: (token: string, id: string) => json<RunView>(token, `/api/runs/${encodeURIComponent(id)}`),
  edit: (token: string, id: string, body: { file: string; content: string; note?: string }) => json<RunView>(token, `/api/runs/${encodeURIComponent(id)}/edit`, { method: 'POST', body }),
  dismiss: (token: string, id: string, body: { version: number; kind: 'change' | 'issue'; index: number; dismissed: boolean }) => json<RunView>(token, `/api/runs/${encodeURIComponent(id)}/dismiss`, { method: 'POST', body }),
  deleteRun: (token: string, id: string) => json<{ id: string; deleted: boolean; savedCopyKept: boolean }>(token, `/api/runs/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  status: (token: string) => json<StatusView>(token, '/api/status'),
  deleteRule: (token: string, id: string) => json<{ id: string; deleted: boolean; mirroredCopyKept: boolean }>(token, `/api/rules/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  disableRule: (token: string, id: string) => json<{ id: string; status: string }>(token, `/api/rules/${encodeURIComponent(id)}/disable`, { method: 'POST' }),
};
