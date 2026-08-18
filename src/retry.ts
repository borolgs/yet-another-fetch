import type { Result } from 'neverthrow';

import type { HttpError, HttpResponse, RequestContext } from './client';
import type { HttpErrorReason } from './errors';

export type RetryOn = <T>(
  ctx: RequestContext,
  result: Result<HttpResponse<T>, HttpError>,
) => boolean;

export type RetryDelay = <T>(
  ctx: RequestContext,
  result: Result<HttpResponse<T>, HttpError>,
) => number;

export type StatusMatcher = number | readonly [number, number];

export type RetryOnOptions = {
  reasons?: readonly HttpErrorReason[];
  statuses?: readonly StatusMatcher[];
  predicate?: (error: HttpError, ctx: RequestContext) => boolean;
};

/** Retries when any configured reason, status, or predicate matches. */
export function retryWhen(options: RetryOnOptions = {}): RetryOn {
  const { reasons, statuses, predicate } = options;

  return <T>(ctx: RequestContext, result: Result<HttpResponse<T>, HttpError>) =>
    result.match(
      () => false,
      (error) =>
        (reasons?.includes(error.reason) ?? false) ||
        matchesStatus(statuses, error.statusCode ?? error.response?.status) ||
        (predicate?.(error, ctx) ?? false),
    );
}

export const retryOnTransient: RetryOn = retryWhen({
  reasons: ['network', 'timeout'],
  statuses: [408, 429, [500, 599]],
});

export type Jitter = 'none' | 'full' | 'equal';

export type RetryDelayOptions = {
  base?: number;
  factor?: number;
  max?: number;
  jitter?: Jitter;
  retryAfter?: boolean;
};

/** Exponential backoff with optional jitter and `Retry-After` support. */
export function delayWith(options: RetryDelayOptions = {}): RetryDelay {
  const { base = 1000, factor = 2, max, jitter = 'none', retryAfter = false } = options;

  return <T>(ctx: RequestContext, result: Result<HttpResponse<T>, HttpError>) => {
    if (retryAfter) {
      const delay = readRetryAfter(result);
      if (delay != null) {
        return clampDelay(Math.min(delay, max ?? MAX_RETRY_AFTER_MS));
      }
    }

    const backoff = Math.min(base * factor ** ctx.attempt, max ?? Number.POSITIVE_INFINITY);

    return clampDelay(applyJitter(backoff, jitter));
  };
}

const MAX_DELAY_MS = 2 ** 31 - 1;
const MAX_RETRY_AFTER_MS = 60_000;

function matchesStatus(statuses: readonly StatusMatcher[] | undefined, code: number | undefined) {
  if (!statuses || code == null) {
    return false;
  }

  return statuses.some((matcher) =>
    typeof matcher === 'number' ? matcher === code : code >= matcher[0] && code <= matcher[1],
  );
}

function applyJitter(delay: number, jitter: Jitter): number {
  if (jitter === 'full') {
    return Math.random() * delay;
  }
  if (jitter === 'equal') {
    return delay / 2 + Math.random() * (delay / 2);
  }
  return delay;
}

export function clampDelay(delay: number): number {
  if (delay === Number.POSITIVE_INFINITY) {
    return MAX_DELAY_MS;
  }
  if (!Number.isFinite(delay)) {
    return 0;
  }
  return Math.min(Math.max(delay, 0), MAX_DELAY_MS);
}

function readRetryAfter<T>(result: Result<HttpResponse<T>, HttpError>): number | null {
  const headers = result.match(
    (res) => res.headers,
    (error) => error.response?.headers,
  );

  const value = headers?.get('retry-after')?.trim();
  if (!value) {
    return null;
  }

  if (/^\d+$/.test(value)) {
    return Number(value) * 1000;
  }

  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
}
