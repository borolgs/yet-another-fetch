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
  retryAfter?:
    | boolean
    | {
        max?: number;
      };
};

/** Exponential backoff with optional jitter and `Retry-After` support. */
export function delayWith(options: RetryDelayOptions = {}): RetryDelay {
  const { base = 1000, factor = 2, max, jitter = 'none', retryAfter = false } = options;

  return <T>(ctx: RequestContext, result: Result<HttpResponse<T>, HttpError>) => {
    if (retryAfter) {
      const delay = readRetryAfter(result);
      if (delay != null) {
        // retrying inside a ban window is worse than waiting
        const cap =
          (typeof retryAfter === 'object' ? retryAfter.max : undefined) ?? MAX_RETRY_AFTER_MS;
        return clampDelay(Math.min(delay, cap));
      }
    }

    const backoff = Math.min(base * factor ** ctx.attempt, max ?? Number.POSITIVE_INFINITY);

    return clampDelay(applyJitter(backoff, jitter));
  };
}

const MAX_DELAY_MS = 2 ** 31 - 1;
const MAX_RETRY_AFTER_MS = 60_000;

const DAY = '(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)';
const DAY_LONG = '(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)';
const MONTH = '(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)';
const TIME = '\\d{2}:\\d{2}:\\d{2}';

// RFC 9110 5.6.7: senders MUST use IMF-fixdate, recipients MUST accept all three.
const IMF_FIXDATE = new RegExp(`^${DAY}, \\d{2} ${MONTH} \\d{4} ${TIME} GMT$`);
const RFC_850 = new RegExp(`^${DAY_LONG}, \\d{2}-${MONTH}-\\d{2} ${TIME} GMT$`);
const ASCTIME = new RegExp(`^${DAY} ${MONTH} [ \\d]\\d ${TIME} \\d{4}$`);

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

  const at = parseHttpDate(value);
  return at == null ? null : Math.max(0, at - Date.now());
}

// TODO: V8's two-digit-year pivot is fixed at 1950-2049, RFC 9110 wants a rolling 50-year window,
// so an RFC 850 date with a year >= 50 reads as the past and retries now. Rare enough to leave.
function parseHttpDate(value: string): number | null {
  // asctime carries no zone and V8 reads it as local time; RFC 9110 says it is GMT.
  const stamp = ASCTIME.test(value)
    ? `${value} GMT`
    : IMF_FIXDATE.test(value) || RFC_850.test(value)
      ? value
      : null;
  if (stamp == null) {
    return null;
  }

  const at = Date.parse(stamp);
  return Number.isNaN(at) ? null : at;
}
