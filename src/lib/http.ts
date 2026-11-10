import { createHash, timingSafeEqual } from 'node:crypto';
import { ZodError, type ZodType } from 'zod';
import { getConfigInt, getSecret } from '@/config/env';
import { AppError, errorBody, ProviderError, redact } from '@/lib/errors';
import { createLogger, type Logger } from '@/lib/logger';
import type { RunRecord } from '@/pipeline/types';
import { createProviders } from '@/providers';
import type { Providers } from '@/providers/types';
import { SanitizerLeakError } from '@/sanitizer';
import { toRunView, type StreamEvent } from './api-types';

export interface RouteCtx {
  req: Request;
  providers: Providers;
  log: Logger;
  id: string;
}
type Auth = 'token' | 'cron' | 'none';

const digest = (s: string) => createHash('sha256').update(s).digest();
function sameSecret(given: string | null, expected: string | undefined): boolean {
  if (!given || !expected) return false;
  return timingSafeEqual(digest(given), digest(expected));
}
function bearer(req: Request): string | null {
  const h = req.headers.get('authorization') ?? '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : null;
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });
}

export function errorResponse(e: unknown, runId?: string): Response {
  if (e instanceof AppError) return json(errorBody({ code: e.code, message: e.message, status: e.status, runId: e.runId ?? runId }), e.status);
  // a provider error keeps its real status (for example 429 or 503); it is never turned into a 200 or a generic 500
  if (e instanceof ProviderError) return json(errorBody({ code: 'PROVIDER_ERROR', message: e.message, status: e.status >= 400 ? e.status : 502, runId }), e.status >= 400 ? e.status : 502);
  if (e instanceof ZodError) return json(errorBody({ code: 'BAD_REQUEST', message: e.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '), status: 400 }), 400);
  if (e instanceof SanitizerLeakError) return json(errorBody({ code: 'SANITIZE_LEAK_DETECTED', message: 'A sanitizer scan found a protected item, so the operation was stopped.', status: 422, runId }), 422);
  return json(errorBody({ code: 'INTERNAL_ERROR', message: 'Unexpected server error.', status: 500, runId }), 500);
}

export async function readJson<T>(req: Request, schema: ZodType<T>): Promise<T> {
  // wrong content type is rejected before the body is read
  if (!/^application\/json\b/i.test(req.headers.get('content-type') ?? '')) throw new AppError('UNSUPPORTED_MEDIA_TYPE', 'Send the request body as application/json.', 415);
  const limit = getConfigInt('MAX_INPUT_BYTES') * 2 + 4096;
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (declared > limit) throw new AppError('INPUT_TOO_LARGE', 'The request body is larger than the input limit.', 413);
  const text = await req.text();
  if (Buffer.byteLength(text, 'utf8') > limit) throw new AppError('INPUT_TOO_LARGE', 'The request body is larger than the input limit.', 413);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new AppError('BAD_REQUEST', 'The request body is not valid JSON.', 400);
  }
  return schema.parse(body);
}

/**
 * Wraps a route handler: authenticate, rate-limit, build per-request providers, respond,
 * flush logs, close the database connection. Nothing created here outlives the request.
 */
export function route(auth: Auth, handler: (ctx: RouteCtx) => Promise<Response>, opts: { limited?: boolean } = {}) {
  return async (req: Request, context?: { params?: Promise<Record<string, string>> }): Promise<Response> => {
    if (auth === 'token' && !sameSecret(bearer(req), getSecret('APP_ACCESS_TOKEN'))) {
      return json(errorBody({ code: 'UNAUTHORIZED', message: getSecret('APP_ACCESS_TOKEN') ? 'Missing or wrong access token.' : 'APP_ACCESS_TOKEN is not configured on the server.', status: 401 }), 401, { 'www-authenticate': 'Bearer' });
    }
    if (auth === 'cron' && !sameSecret(bearer(req), getSecret('CRON_SECRET'))) {
      return json(errorBody({ code: 'UNAUTHORIZED', message: 'Missing or wrong cron secret.', status: 401 }), 401);
    }
    const id = (await context?.params)?.id ?? '';
    if (id && !/^[\w-]{1,80}$/.test(id)) return json(errorBody({ code: 'BAD_REQUEST', message: 'Invalid id.', status: 400 }), 400);
    const log = createLogger({ runId: id.startsWith('run_') ? id : null });
    let providers: Providers | null = null;
    let streaming = false;
    const finish = async () => {
      if (!providers) return;
      await log.flush(providers.storage);
      await providers.storage.close().catch(() => {});
    };
    try {
      providers = createProviders();
      if (auth === 'token') {
        const limit = getConfigInt('RATE_LIMIT_PER_MINUTE') * (opts.limited ? 1 : 10);
        const key = `${opts.limited ? 'heavy' : 'light'}:${digest(bearer(req) ?? '').toString('hex').slice(0, 16)}`;
        const r = await providers.storage.rateLimitHit(key, 60, limit);
        if (!r.allowed) log.warn('rate limited', { bucket: opts.limited ? 'heavy' : 'light' });
        if (!r.allowed) return json(errorBody({ code: 'RATE_LIMITED', message: 'Too many requests. Try again in a minute.', status: 429 }), 429, { 'retry-after': '60' });
      }
      const res = await handler({ req, providers, log, id });
      if (res.body && res.headers.get('content-type')?.startsWith('application/x-ndjson')) {
        streaming = true;
        const reader = res.body.getReader();
        // the stream is still producing: clean up only when it ends
        return new Response(
          new ReadableStream<Uint8Array>({
            async pull(controller) {
              const { done, value } = await reader.read();
              if (done) {
                await finish();
                controller.close();
              } else controller.enqueue(value);
            },
            async cancel() {
              await finish();
            },
          }),
          { status: res.status, headers: res.headers },
        );
      }
      return res;
    } catch (e) {
      if (!(e instanceof AppError) && !(e instanceof ZodError)) log.error('request failed', { error: redact(e instanceof Error ? `${e.name}: ${e.message}` : 'unknown') });
      return errorResponse(e, id || undefined);
    } finally {
      if (!streaming) await finish();
    }
  };
}

export const wantsStream = (req: Request) => (req.headers.get('accept') ?? '').includes('application/x-ndjson');

/**
 * Runs pipeline work and reports stage progress as NDJSON. Headers are held back until
 * the first unit has been drafted, so a provider failure before any draft still returns
 * its real HTTP status.
 */
export async function runResponse(req: Request, work: (onProgress: (e: StreamEvent) => void) => Promise<RunRecord>): Promise<Response> {
  if (!wantsStream(req)) return json(toRunView(await work(() => {})));
  const enc = new TextEncoder();
  const queue: StreamEvent[] = [];
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let closed = false;
  const send = (e: StreamEvent) => {
    if (closed) return;
    if (controller) controller.enqueue(enc.encode(JSON.stringify(e) + '\n'));
    else queue.push(e);
  };
  let release!: () => void;
  const firstDraft = new Promise<void>((r) => (release = r));
  let early: unknown = null;
  let settled = false;
  const done = work((e) => {
    send(e);
    if (e.type === 'stage' && e.stage === 'generate' && e.status === 'done') release();
  }).then(
    (run) => {
      settled = true;
      send({ type: 'result', run: toRunView(run) });
      release();
    },
    (e) => {
      settled = true;
      early = e;
      const r = errorResponse(e);
      send({ type: 'error', error: { code: e instanceof AppError ? e.code : e instanceof ProviderError ? 'PROVIDER_ERROR' : 'INTERNAL_ERROR', message: e instanceof AppError || e instanceof ProviderError ? e.message : 'Unexpected server error.', status: r.status } });
      release();
    },
  );
  await firstDraft;
  if (settled && early) return errorResponse(early);
  const stream = new ReadableStream<Uint8Array>({
    async start(c) {
      controller = c;
      for (const e of queue.splice(0)) c.enqueue(enc.encode(JSON.stringify(e) + '\n'));
      await done;
      closed = true;
      c.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' } });
}

export async function loadRun(ctx: RouteCtx): Promise<RunRecord> {
  const run = await ctx.providers.storage.getRun(ctx.id);
  if (!run) throw new AppError('NOT_FOUND', 'Run not found.', 404, ctx.id);
  return run;
}
