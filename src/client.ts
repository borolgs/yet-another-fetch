import { randomUUID } from 'node:crypto';

import { err, errAsync, fromPromise, ok, okAsync, Result, ResultAsync } from 'neverthrow';
import { CreateHttpClientError, createHttpError, HttpClientError, HttpErrorReason } from './errors';
import { clampDelay, type RetryDelay, type RetryOn, retryOnTransient } from './retry';

// TODO: accept Input instead of string URLs.
export type Input = Parameters<typeof fetch>[0];
export type QueryValue = string | number | boolean | null | undefined;

export type Init = RequestInit & {
  data?: any;
  query?: Record<string, QueryValue | ReadonlyArray<string | number | boolean>>;
  /** Correlation ID for this call; overrides the client-level generator. */
  requestId?: string;
  /** Per-attempt timeout in milliseconds. */
  timeout?: number;
};

export type HttpError = HttpClientError;

export const BodyMethod = ['json', 'arrayBuffer', 'blob', 'bytes', 'formData', 'text'] as const;
export type BodyMethod = (typeof BodyMethod)[number];

export type HttpResponse<T> = Omit<Response, BodyMethod> & {
  text: () => ResultAsync<string, HttpError>;
  json: () => ResultAsync<T, HttpError>;
  blob: () => ResultAsync<Blob, HttpError>;
  formData: () => ResultAsync<FormData, HttpError>;
  arrayBuffer: () => ResultAsync<ArrayBuffer, HttpError>;
  bytes: () => ResultAsync<Uint8Array, HttpError>;
};

/** Shared across all attempts of a logical request. */
export type RequestContext = {
  readonly id: string;
  /** Observability only; mutations do not affect the request URL. */
  readonly url: URL;
  readonly method: string;
  /** Zero-based index of the attempt in flight. */
  readonly attempt: number;
  readonly startedAt: number;
  /** Zero until settled, then measured to response headers including retry delays. */
  readonly duration: number;
  /** Shared across attempts, so `onAttempt` mutations persist. */
  init: Omit<RequestInit, 'method' | 'signal' | 'headers'> & { headers: Record<string, string> };
};

/** Internal context with mutable counters and the request URL snapshot. */
type MutableRequestContext = Omit<RequestContext, 'attempt' | 'duration'> & {
  attempt: number;
  duration: number;
  readonly href: string;
};

/** Hooks are synchronous; returned promises are reported to `onHookError`. */
export type HttpClientPlugin = {
  name?: string;
  /** Runs before each attempt and may mutate the request. */
  onAttempt?: (ctx: RequestContext) => void;
  /** Runs once per call that reaches fetch. Clone the response before reading its body. */
  onSettled?: (ctx: RequestContext, result: Result<HttpResponse<unknown>, HttpError>) => void;
};

export type HookName = 'onAttempt' | 'onSettled' | 'retryOn' | 'retryDelay' | 'requestId';

export type HttpClientDefaultConfig = Omit<RequestInit, 'body' | 'method'> & {
  baseUrl?: string;

  plugins?: HttpClientPlugin[];

  /** Correlation ID generator. Defaults to `crypto.randomUUID()`. */
  requestId?: () => string;

  /** Per-attempt timeout in milliseconds. */
  timeout?: number;

  /** Receives hook failures. Errors are ignored when this is unset. */
  onHookError?: (err: unknown, info: { hook: HookName; plugin?: string }) => void;

  retries?: number;
  retryDelay?: RetryDelay;
  /** Defaults to `retryOnTransient`; a 4xx other than 408/429 is not retried. */
  retryOn?: RetryOn;
};

/**
 * ### HTTP Client
 *
 * An HTTP client with retry functionality, plugins, and error handling using [neverthrow](https://github.com/supermacro/neverthrow).
 *
 * It utilizes the fetch API under the hood and provides an API similar to fetch with additional options.
 *
 * Usage:
 *
 * ```typescript
 * const client = createHttpClient({
 *   baseUrl: 'https://example.com',
 *   retries: 3,
 *   retryDelay: delayWith({ base: 200, max: 30_000, jitter: 'equal' }),
 *   retryOn: retryWhen({ reasons: ['timeout'], statuses: [429, [500, 599]] }),
 *   plugins: [
 *     {
 *       name: 'logger',
 *       onAttempt: (ctx) => {
 *         if (ctx.attempt === 0) {
 *           log('request', ctx.id, ctx.method, ctx.url.href);
 *         }
 *       },
 *       onSettled: (ctx, result) => log(ctx.id, ctx.method, ctx.url.href, ctx.duration),
 *     },
 *   ],
 * });
 *
 * const { message } = await client
 *   .get<{ message: string }>('/data')
 *   .andThen((res) => res.json())
 *   .unwrapOr({ message: 'hello' });
 * ```
 */
export function createHttpClient(config: HttpClientDefaultConfig = {}) {
  const {
    baseUrl,
    retries,
    plugins = [],
    requestId: requestIdFactory,
    onHookError,
    retryDelay: retryDelayOption,
    retryOn: retryOnOption,
    signal: configSignal,
    timeout: configTimeout,
    ...defaultConfig
  } = config;

  const retryDelay = retryDelayOption ?? (() => 1000);
  const retryOn = retryOnOption ?? retryOnTransient;
  /** A non-integer, negative or NaN `retries` behaves as unset: one attempt, no retry loop. */
  const retryLimit =
    retries != null && Number.isInteger(retries) && retries >= 0 ? retries : undefined;

  type PreparedRequest = {
    ctx: MutableRequestContext;
    /** Per-call signal wins over the client-level one; they are not merged. */
    signal: AbortSignal | undefined;
    timeout: number | undefined;
  };

  /** Builds request state before retries; failures return configuration errors without hooks. */
  function prepare(url: string, init?: Init): Result<PreparedRequest, HttpError> {
    const { headers, body, data, query, requestId, method, signal, timeout, ...rest } = init ?? {};

    const targetSignal = asAbortSignal(signal === null ? undefined : (signal ?? configSignal));
    const targetMethod = method ?? 'GET';
    const targetUrlStr = baseUrl ? baseUrl + url : url;

    const configError = (init: Omit<CreateHttpClientError, 'reason'>) => {
      const error = createHttpError({ ...init, reason: 'config' });
      error.url = targetUrlStr;
      error.method = targetMethod;
      return err(error);
    };

    const targetTimeout = timeout ?? configTimeout;
    if (targetTimeout != null && !isValidTimeout(targetTimeout)) {
      return configError({
        message: `Invalid timeout: ${targetTimeout}. Expected an integer between 0 and ${MAX_TIMEOUT_MS}.`,
      });
    }

    let targetUrl: URL;
    try {
      targetUrl = new URL(targetUrlStr);

      if (query) {
        applyQuery(targetUrl.searchParams, query);
      }
    } catch (error) {
      return configError({ message: `Invalid request url: ${targetUrlStr}`, cause: error });
    }

    const targetHeaders = {
      ...toHeaderRecord(defaultConfig.headers),
      ...toHeaderRecord(headers),
    };
    if (data !== undefined) {
      targetHeaders['content-type'] ??= 'application/json';
    }

    let targetBody: RequestInit['body'];
    try {
      targetBody = data !== undefined ? JSON.stringify(data) : body;
    } catch (error) {
      return configError({ message: 'Failed to serialize request data', cause: error });
    }

    const ctx: MutableRequestContext = {
      id: requestId ?? nextRequestId(),
      url: targetUrl,
      href: targetUrl.href,
      method: targetMethod,
      attempt: 0,
      startedAt: performance.now(),
      duration: 0,
      init: {
        ...defaultConfig,
        ...rest,
        headers: targetHeaders,
        body: targetBody,
      },
    };

    return ok({ ctx, signal: targetSignal, timeout: targetTimeout });
  }

  function nextRequestId(): string {
    if (!requestIdFactory) {
      return randomUUID();
    }
    return runHook('requestId', undefined, requestIdFactory) ?? randomUUID();
  }

  /** `retries` is the maximum attempt count; retry hooks receive the failed attempt's index. */
  async function requestWithRetryInner<T>(
    url: string,
    init?: Init,
  ): Promise<Result<HttpResponse<T>, HttpError>> {
    const prepared = prepare(url, init);
    if (prepared.isErr()) {
      return err(prepared.error);
    }

    const { ctx, signal, timeout } = prepared.value;

    let result: Result<HttpResponse<T>, HttpError>;

    for (;;) {
      callOnAttempt(ctx);

      result = await attempt<T>(ctx, attemptSignals(signal, timeout));

      if (result.isErr() && result.error.reason === 'abort') {
        break;
      }
      if (retryLimit == null || ctx.attempt >= retryLimit - 1) {
        break;
      }
      if (!shouldRetry(ctx, result)) {
        break;
      }

      const delay = delayBeforeRetry(ctx, result);
      if (delay == null) {
        break;
      }

      await drainBody(result.isErr() ? result.error.response : result.value);

      await sleep(delay, signal);
      if (signal?.aborted) {
        result = err(httpErrorFrom(ctx, { reason: 'abort', message: 'Request aborted' }));
        break;
      }
      ctx.attempt++;
    }

    ctx.duration = performance.now() - ctx.startedAt;
    callOnSettled(ctx, result);

    return result;
  }

  function callOnAttempt(ctx: MutableRequestContext) {
    for (const plugin of plugins) {
      if (plugin.onAttempt) {
        runHook('onAttempt', plugin.name, () => plugin.onAttempt?.(ctx));
      }
    }
  }

  /** Fetches the snapshotted URL and maps non-2xx responses to an `HttpError`. */
  function attempt<T>(
    ctx: MutableRequestContext,
    signals: AttemptSignals,
  ): ResultAsync<HttpResponse<T>, HttpError> {
    const headers = toHeaders(ctx.init.headers);
    if (headers.isErr()) {
      return errAsync(transportError(ctx, signals, headers.error));
    }

    return fromPromise(
      fetch(ctx.href, {
        ...ctx.init,
        headers: headers.value,
        method: ctx.method,
        signal: signals.fetch,
      }),
      (error) => transportError(ctx, signals, error),
    ).andThen((res) => {
      if (!res.ok) {
        return errAsync(
          httpErrorFrom(ctx, {
            reason: 'status',
            message: res.statusText || `HTTP ${res.status}`,
            status: res.statusText,
            statusCode: res.status,
            response: res,
          }),
        );
      }

      return okAsync(wrapBodyMethods<T>(res, ctx, signals));
    });
  }

  function shouldRetry<T>(
    ctx: MutableRequestContext,
    result: Result<HttpResponse<T>, HttpError>,
  ): boolean {
    const retry = runHook('retryOn', undefined, () => retryOn(ctx, result));
    if (retry === undefined) {
      return false;
    }
    if (typeof retry !== 'boolean') {
      reportHookError(
        new TypeError(`retryOn must return a boolean, got ${typeof retry}`),
        'retryOn',
      );
      return false;
    }
    return retry;
  }

  function delayBeforeRetry<T>(
    ctx: MutableRequestContext,
    result: Result<HttpResponse<T>, HttpError>,
  ): number | null {
    const delay = runHook('retryDelay', undefined, () => retryDelay(ctx, result));
    if (delay === undefined) {
      return null;
    }
    if (typeof delay !== 'number' || !Number.isFinite(delay) || delay < 0) {
      // Interpolating the raw value would throw for a symbol, from inside the never-throws path.
      const got = typeof delay === 'number' ? delay : typeof delay;
      reportHookError(
        new TypeError(`retryDelay must return a non-negative finite number, got ${got}`),
        'retryDelay',
      );
      return null;
    }
    return clampDelay(delay);
  }

  function callOnSettled<T>(
    ctx: MutableRequestContext,
    result: Result<HttpResponse<T>, HttpError>,
  ) {
    for (const plugin of plugins) {
      if (plugin.onSettled) {
        runHook('onSettled', plugin.name, () =>
          plugin.onSettled?.(ctx, result as Result<HttpResponse<unknown>, HttpError>),
        );
      }
    }
  }

  /**
   * Runs a hook without propagating thrown errors or promise rejections. Async hooks are reported
   * as invalid and treated as returning `undefined`.
   */
  function runHook<T>(hook: HookName, plugin: string | undefined, call: () => T): T | undefined {
    try {
      const returned = call();

      if (isThenable(returned)) {
        Promise.resolve(returned).then(undefined, (error: unknown) =>
          reportHookError(error, hook, plugin),
        );
        reportHookError(new TypeError(`${hook} must be synchronous`), hook, plugin);
        return undefined;
      }

      return returned;
    } catch (error) {
      reportHookError(error, hook, plugin);
      return undefined;
    }
  }

  function reportHookError(error: unknown, hook: HookName, plugin?: string) {
    if (!onHookError) {
      return;
    }
    try {
      const returned: unknown = onHookError(error, plugin != null ? { hook, plugin } : { hook });
      if (isThenable(returned)) {
        returned.then(undefined, () => {});
      }
    } catch {}
  }

  const requestWithRetry = <T>(url: string, init?: Init) =>
    new ResultAsync(requestWithRetryInner<T>(url, init));

  return {
    request: requestWithRetry,
    get: <T>(url: string, init?: Omit<Init, 'method' | 'data' | 'body'>) =>
      requestWithRetry<T>(url, { ...init, method: 'GET' }),
    head: <T>(url: string, init?: Omit<Init, 'method' | 'data' | 'body'>) =>
      requestWithRetry<T>(url, { ...init, method: 'HEAD' }),
    delete: <T>(url: string, init?: Omit<Init, 'method' | 'data' | 'body'>) =>
      requestWithRetry<T>(url, { ...init, method: 'DELETE' }),
    post: <T>(url: string, init?: Omit<Init, 'method'>) =>
      requestWithRetry<T>(url, { ...init, method: 'POST' }),
    put: <T>(url: string, init?: Omit<Init, 'method'>) =>
      requestWithRetry<T>(url, { ...init, method: 'PUT' }),
    patch: <T>(url: string, init?: Omit<Init, 'method'>) =>
      requestWithRetry<T>(url, { ...init, method: 'PATCH' }),
  };
}

export type HttpClient = ReturnType<typeof createHttpClient>;

/** Applies `query` on top of the params already present in the url. */
function applyQuery(params: URLSearchParams, query: NonNullable<Init['query']>): void {
  for (const [key, value] of Object.entries(query)) {
    if (value == null) {
      continue;
    }
    if (Array.isArray(value)) {
      params.delete(key);
      for (const item of value) {
        params.append(key, String(item));
      }
      continue;
    }
    params.set(key, String(value));
  }
}

/** Normalizes every `HeadersInit` shape to a plain record with lowercase names. */
function toHeaderRecord(input: RequestInit['headers']): Record<string, string> {
  const record: Record<string, string> = {};

  if (!input) {
    return record;
  }

  if (input instanceof Headers) {
    input.forEach((value, key) => {
      record[key] = value;
    });
    return record;
  }

  if (Array.isArray(input)) {
    for (const [key, value] of input) {
      if (key != null && value != null) {
        record[key.toLowerCase()] = value;
      }
    }
    return record;
  }

  for (const [key, value] of Object.entries(input as Record<string, string>)) {
    if (value != null) {
      record[key.toLowerCase()] = value;
    }
  }
  return record;
}

/**
 * Collapses the record back into `Headers` at fetch time.
 */
function toHeaders(record: Record<string, string>): Result<Headers, unknown> {
  try {
    const headers = new Headers();
    for (const [key, value] of Object.entries(record)) {
      if (value != null) {
        headers.set(key, value);
      }
    }
    return ok(headers);
  } catch (error) {
    return err(error);
  }
}

type AttemptSignals = {
  fetch: AbortSignal | undefined;
  timeout: AbortSignal | undefined;
  caller: AbortSignal | undefined;
  timeoutMs: number | undefined;
};

function asAbortSignal(value: unknown): AbortSignal | undefined {
  return value instanceof AbortSignal ? value : undefined;
}

const MAX_TIMEOUT_MS = 2 ** 31 - 1;

function isValidTimeout(ms: number): boolean {
  return typeof ms === 'number' && Number.isInteger(ms) && ms >= 0 && ms <= MAX_TIMEOUT_MS;
}

function attemptSignals(
  caller: AbortSignal | undefined,
  timeoutMs: number | undefined,
): AttemptSignals {
  const timeout = timeoutMs != null ? AbortSignal.timeout(timeoutMs) : undefined;

  const signals = [timeout, caller].filter((signal) => signal != null);

  return {
    fetch: signals.length > 1 ? AbortSignal.any(signals) : signals[0],
    timeout,
    caller,
    timeoutMs,
  };
}

/** Classifies failures from the signals, not their caller-controlled abort reasons. */
function transportError(
  ctx: MutableRequestContext,
  signals: AttemptSignals,
  cause: unknown,
  fallback: HttpErrorReason = 'network',
): HttpClientError {
  if (signals.timeout?.aborted) {
    return httpErrorFrom(ctx, {
      reason: 'timeout',
      message: `Request timed out after ${signals.timeoutMs}ms`,
      cause,
    });
  }
  if (signals.caller?.aborted) {
    return httpErrorFrom(ctx, { reason: 'abort', message: 'Request aborted', cause });
  }
  return httpErrorFrom(ctx, { reason: fallback, cause });
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

const MAX_DRAIN_MS = 1000;

async function drainBody(res: Pick<Response, 'body' | 'bodyUsed'> | undefined): Promise<void> {
  const body = res?.body;

  if (!body || res.bodyUsed || body.locked) {
    return;
  }

  const reader = body.getReader();

  const cancel = setTimeout(() => {
    reader.cancel().catch(() => {});
  }, MAX_DRAIN_MS);

  await fromPromise(readToEnd(reader), () => undefined);
  clearTimeout(cancel);
}

async function readToEnd(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  while (!(await reader.read()).done) {}
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as PromiseLike<unknown> | null | undefined)?.then === 'function';
}

function wrapBodyMethods<T>(
  res: Response,
  ctx: MutableRequestContext,
  signals: AttemptSignals,
): HttpResponse<T> {
  return new Proxy(res, {
    get(target: any, prop) {
      if (BodyMethod.includes(prop.toString() as any) && typeof target[prop] === 'function') {
        return new Proxy(target[prop], {
          apply: (target, _, argumentsList) => {
            return ResultAsync.fromPromise(Reflect.apply(target, res, argumentsList) as any, (e) =>
              transportError(ctx, signals, e, 'parse'),
            );
          },
        });
      }

      const value = Reflect.get(target, prop, res);
      return typeof value === 'function' ? value.bind(res) : value;
    },
  });
}

export function httpErrorFrom(
  ctx: {
    readonly id: string;
    /** URL snapshot used by fetch. */
    readonly href: string;
    readonly method: string;
    readonly attempt: number;
  },
  init: CreateHttpClientError,
): HttpClientError {
  const error = createHttpError(init);

  error.url = ctx.href;
  error.method = ctx.method;
  error.attempt = ctx.attempt;
  error.requestId = ctx.id;

  return error;
}
