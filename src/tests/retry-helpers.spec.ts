import { err, ok, type Result } from 'neverthrow';
import { afterEach, describe, expect, test, vi } from 'vitest';

import type { HttpError, HttpResponse, RequestContext } from '../client';
import { createHttpError, type HttpErrorReason } from '../errors';
import { delayWith, retryOnTransient, retryWhen } from '../retry';

afterEach(() => {
  vi.restoreAllMocks();
});

type Outcome = Result<HttpResponse<unknown>, HttpError>;

function context(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    id: 'test-id',
    url: new URL('https://example.com/data'),
    method: 'GET',
    attempt: 0,
    startedAt: 0,
    duration: 0,
    init: { headers: {} },
    ...overrides,
  };
}

/**
 * A status failure, as `attempt()` builds it: both `statusCode` and `response` are set. `Response`
 * only accepts 200-599, so out-of-range codes carry `statusCode` alone — which is the field the
 * matcher reads anyway.
 */
function status(statusCode: number, headers?: Record<string, string>): Outcome {
  const inRange = statusCode >= 200 && statusCode <= 599;

  return err(
    createHttpError({
      reason: 'status',
      statusCode,
      response: inRange ? new Response(null, { status: statusCode, headers }) : undefined,
    }),
  );
}

function transport(reason: HttpErrorReason): Outcome {
  return err(createHttpError({ reason }));
}

function success(headers?: Record<string, string>): Outcome {
  return ok(new Response(null, { status: 200, headers }) as unknown as HttpResponse<unknown>);
}

describe('retryWhen', () => {
  test('matches exact statuses and inclusive ranges', () => {
    const policy = retryWhen({ statuses: [429, [500, 599]] });

    expect(policy(context(), status(429))).toBe(true);
    expect(policy(context(), status(500))).toBe(true);
    expect(policy(context(), status(599))).toBe(true);

    expect(policy(context(), status(499))).toBe(false);
    expect(policy(context(), status(600))).toBe(false);
    expect(policy(context(), transport('network'))).toBe(false);
  });

  test('matches statusCode even when the error carries no response', () => {
    const policy = retryWhen({ statuses: [[500, 599]] });
    const withoutResponse = err(createHttpError({ reason: 'status', statusCode: 503 }));

    expect(withoutResponse._unsafeUnwrapErr().response).toBeUndefined();
    expect(policy(context(), withoutResponse)).toBe(true);
  });

  test('matches reasons', () => {
    const policy = retryWhen({ reasons: ['network', 'timeout'] });

    expect(policy(context(), transport('network'))).toBe(true);
    expect(policy(context(), transport('timeout'))).toBe(true);
    expect(policy(context(), status(500))).toBe(false);
  });

  test('predicate receives the error and the ctx', () => {
    const predicate = vi.fn(() => true);
    const ctx = context({ method: 'POST' });

    expect(retryWhen({ predicate })(ctx, status(418))).toBe(true);
    expect(predicate).toHaveBeenCalledWith(status(418)._unsafeUnwrapErr(), ctx);
  });

  test('fields are OR-ed and short-circuit before the predicate', () => {
    const predicate = vi.fn(() => false);
    const policy = retryWhen({ reasons: ['network'], statuses: [429], predicate });

    expect(policy(context(), transport('network'))).toBe(true);
    expect(policy(context(), status(429))).toBe(true);
    expect(predicate).not.toHaveBeenCalled();

    expect(policy(context(), status(404))).toBe(false);
    expect(predicate).toHaveBeenCalledTimes(1);
  });

  test('an ok result never retries, whatever the options say', () => {
    const predicate = vi.fn(() => true);

    expect(retryWhen({ statuses: [200], predicate })(context(), success())).toBe(false);
    expect(predicate).not.toHaveBeenCalled();
  });

  test('an empty policy never retries', () => {
    expect(retryWhen()(context(), status(500))).toBe(false);
    expect(retryWhen({})(context(), transport('network'))).toBe(false);
  });
});

describe('retryOnTransient', () => {
  test.each([500, 503, 599, 429, 408])('retries %i', (code) => {
    expect(retryOnTransient(context(), status(code))).toBe(true);
  });

  test.each(['network', 'timeout'] as const)('retries %s', (reason) => {
    expect(retryOnTransient(context(), transport(reason))).toBe(true);
  });

  test.each([400, 401, 404, 409])('does not retry %i', (code) => {
    expect(retryOnTransient(context(), status(code))).toBe(false);
  });

  test('does not retry an ok result', () => {
    expect(retryOnTransient(context(), success())).toBe(false);
  });
});

describe('delayWith', () => {
  const at = (attempt: number) => context({ attempt });

  test('defaults to 1000ms doubling per attempt', () => {
    const delay = delayWith();

    expect([0, 1, 2].map((n) => delay(at(n), status(500)))).toEqual([1000, 2000, 4000]);
  });

  test('honours base and factor', () => {
    expect([0, 1, 2].map((n) => delayWith({ base: 200 })(at(n), status(500)))).toEqual([
      200, 400, 800,
    ]);
    expect([0, 1, 2].map((n) => delayWith({ base: 200, factor: 3 })(at(n), status(500)))).toEqual([
      200, 600, 1800,
    ]);
  });

  test('caps at max', () => {
    const delay = delayWith({ base: 200, max: 1000 });

    expect([0, 1, 2, 3, 4].map((n) => delay(at(n), status(500)))).toEqual([
      200, 400, 800, 1000, 1000,
    ]);
  });

  test('full jitter spans [0, delay]', () => {
    const delay = delayWith({ base: 200, jitter: 'full' });

    vi.spyOn(Math, 'random').mockReturnValue(0);
    expect(delay(at(1), status(500))).toBe(0);

    vi.spyOn(Math, 'random').mockReturnValue(0.999999);
    expect(delay(at(1), status(500))).toBeCloseTo(400, 1);
  });

  test('equal jitter spans [delay/2, delay]', () => {
    const delay = delayWith({ base: 200, jitter: 'equal' });

    vi.spyOn(Math, 'random').mockReturnValue(0);
    expect(delay(at(1), status(500))).toBe(200);

    vi.spyOn(Math, 'random').mockReturnValue(0.999999);
    expect(delay(at(1), status(500))).toBeCloseTo(400, 1);
  });

  test('caps before it jitters', () => {
    const delay = delayWith({ base: 200, max: 1000, jitter: 'equal' });

    // Attempt 5 would be 6400ms uncapped; jitter must apply to 1000, not to 6400.
    vi.spyOn(Math, 'random').mockReturnValue(0);
    expect(delay(at(5), status(500))).toBe(500);

    vi.spyOn(Math, 'random').mockReturnValue(0.999999);
    expect(delay(at(5), status(500))).toBeCloseTo(1000, 1);
  });

  test('clamps an uncapped backoff to the setTimeout ceiling', () => {
    expect(delayWith({ base: 1000 })(at(1024), status(500))).toBe(2 ** 31 - 1);
  });
});

describe('delayWith retryAfter', () => {
  const retryAfter = (value: string) => status(503, { 'retry-after': value });

  test('reads a delay-seconds header', () => {
    expect(delayWith({ retryAfter: true })(context(), retryAfter('2'))).toBe(2000);
  });

  test('reads an http-date header', () => {
    const at = new Date(Date.now() + 5000).toUTCString();
    const delay = delayWith({ retryAfter: true })(context(), retryAfter(at));

    expect(delay).toBeGreaterThan(3500);
    expect(delay).toBeLessThanOrEqual(5000);
  });

  test('a date in the past means retry now', () => {
    const at = new Date(Date.now() - 5000).toUTCString();

    expect(delayWith({ retryAfter: true })(context(), retryAfter(at))).toBe(0);
  });

  test('caps at 60s by default and at max when given', () => {
    expect(delayWith({ retryAfter: true })(context(), retryAfter('3600'))).toBe(60_000);
    expect(delayWith({ retryAfter: true, max: 5000 })(context(), retryAfter('3600'))).toBe(5000);
  });

  test('falls through to the backoff when the header is missing or malformed', () => {
    const delay = delayWith({ base: 200, retryAfter: true });

    expect(delay(context({ attempt: 1 }), status(503))).toBe(400);
    expect(delay(context({ attempt: 1 }), retryAfter('soon'))).toBe(400);
    expect(delay(context({ attempt: 1 }), retryAfter(''))).toBe(400);
  });

  test('a server-supplied delay is never jittered, the fallback backoff is', () => {
    const delay = delayWith({ base: 200, retryAfter: true, jitter: 'equal' });
    vi.spyOn(Math, 'random').mockReturnValue(0);

    expect(delay(context({ attempt: 1 }), retryAfter('2'))).toBe(2000);
    expect(delay(context({ attempt: 1 }), status(503))).toBe(200);
  });

  test('reads the header off an ok result too', () => {
    const delay = delayWith({ retryAfter: true });

    expect(delay(context(), success({ 'retry-after': '3' }))).toBe(3000);
  });

  test('the header is ignored unless retryAfter is on', () => {
    expect(delayWith({ base: 200 })(context({ attempt: 1 }), retryAfter('2'))).toBe(400);
  });
});
