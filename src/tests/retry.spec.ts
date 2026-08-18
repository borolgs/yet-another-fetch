import { describe, expect, test, vi } from 'vitest';

import { createHttpClient, type RequestContext } from '../client';
import { delayWith } from '../retry';
import { baseUrl, setupMockAgent } from './helpers';

const agent = setupMockAgent();

test('retry failed requests according to retry options', async () => {
  const client = createHttpClient({ baseUrl, retries: 3, retryDelay: () => 10 });

  agent.intercept({ method: 'GET', path: '/data' }).replyWithError(new Error('Request failed'));
  agent.intercept({ method: 'GET', path: '/data' }).replyWithError(new Error('Request failed'));
  agent.intercept({ method: 'GET', path: '/data' }).reply(200, { message: 'Success' });

  const result = await client.request('/data', {
    method: 'GET',
  });

  expect(result.isOk()).toBe(true);
});

describe('the default retryOn', () => {
  /** `onAttempt` fires once per fetch, so it is the attempt counter. */
  function clientCountingAttempts() {
    const onAttempt = vi.fn();
    const client = createHttpClient({
      baseUrl,
      retries: 3,
      retryDelay: () => 10,
      plugins: [{ onAttempt }],
    });
    return { client, onAttempt };
  }

  test('does not retry a 404', async () => {
    const { client, onAttempt } = clientCountingAttempts();
    agent.intercept({ method: 'GET', path: '/data' }).reply(404, 'nope').persist();

    const error = (await client.get('/data'))._unsafeUnwrapErr();

    expect(error.statusCode).toBe(404);
    expect(onAttempt).toHaveBeenCalledTimes(1);
  });

  test('retries a 503 until the budget runs out', async () => {
    const { client, onAttempt } = clientCountingAttempts();
    agent.intercept({ method: 'GET', path: '/data' }).reply(503, 'nope').persist();

    const error = (await client.get('/data'))._unsafeUnwrapErr();

    expect(error.statusCode).toBe(503);
    expect(onAttempt).toHaveBeenCalledTimes(3);
  });

  test('retries a transport failure', async () => {
    const { client, onAttempt } = clientCountingAttempts();
    agent.intercept({ method: 'GET', path: '/data' }).replyWithError(new Error('Request failed'));
    agent.intercept({ method: 'GET', path: '/data' }).reply(200, { message: 'Success' });

    const result = await client.get('/data');

    expect(result.isOk()).toBe(true);
    expect(onAttempt).toHaveBeenCalledTimes(2);
  });
});

describe('retry helpers', () => {
  test('delayWith waits base before the first retry', async () => {
    const backoff = delayWith({ base: 200 });
    // `ctx` is one mutable object, so record `attempt` at call time, not by reference.
    const attempts: number[] = [];
    const delays: number[] = [];
    const retryDelay: typeof backoff = (ctx, result) => {
      attempts.push(ctx.attempt);
      const delay = backoff(ctx, result);
      delays.push(delay);
      return delay;
    };
    const client = createHttpClient({ baseUrl, retries: 3, retryDelay });

    for (let i = 0; i < 3; i++) {
      agent.intercept({ method: 'GET', path: '/data' }).replyWithError(new Error('Request failed'));
    }

    const started = performance.now();
    await client.get('/data');
    const elapsed = performance.now() - started;

    expect(attempts).toEqual([0, 1]);
    expect(delays).toEqual([200, 400]);
    // 200 + 400, not the 0.1 behaviour of 400 + 800.
    expect(elapsed).toBeGreaterThanOrEqual(600);
    expect(elapsed).toBeLessThan(1000);
  });

  test('retryOn receives the ctx', async () => {
    const retryOn = vi.fn(() => false);
    const client = createHttpClient({ baseUrl, retries: 3, retryOn });

    agent.intercept({ method: 'GET', path: '/data' }).reply(500, 'nope');

    await client.get('/data');

    expect(retryOn).toHaveBeenCalledTimes(1);
    const [ctx] = retryOn.mock.calls[0] as unknown as [RequestContext];
    expect(ctx.attempt).toBe(0);
    expect(ctx.url.href).toBe(`${baseUrl}/data`);
    expect(ctx.method).toBe('GET');
  });
});

describe('retry loop safety', () => {
  test.each([Number.NaN, -1, 2.5])('retries: %p degrades to a single attempt', async (retries) => {
    const onAttempt = vi.fn();
    const client = createHttpClient({
      baseUrl,
      retries,
      retryDelay: () => 0,
      plugins: [{ onAttempt }],
    });

    agent.intercept({ method: 'GET', path: '/data' }).reply(503, 'nope').persist();

    const error = (await client.get('/data'))._unsafeUnwrapErr();

    expect(error.statusCode).toBe(503);
    expect(onAttempt).toHaveBeenCalledTimes(1);
  });

  test('a caller abort during the backoff settles promptly with reason: abort', async () => {
    const controller = new AbortController();
    const onAttempt = vi.fn();
    const client = createHttpClient({
      baseUrl,
      retries: 3,
      retryDelay: () => 2000,
      signal: controller.signal,
      plugins: [{ onAttempt }],
    });

    // A single interceptor: a second fetch would fail as a net-connect error, not an abort.
    agent.intercept({ method: 'GET', path: '/data' }).reply(503, 'nope');
    setTimeout(() => controller.abort(), 20);

    const started = performance.now();
    const error = (await client.get('/data'))._unsafeUnwrapErr();
    const elapsed = performance.now() - started;

    expect(error.reason).toBe('abort');
    expect(elapsed).toBeLessThan(1000);
    expect(onAttempt).toHaveBeenCalledTimes(1);
  });

  test('a signal that is not an AbortSignal cannot break the backoff', async () => {
    const uncaught = vi.fn();
    process.on('uncaughtException', uncaught);
    const client = createHttpClient({
      baseUrl,
      retries: 2,
      retryDelay: () => 10,
      // The AbortController slip: an object with no addEventListener.
      signal: {} as unknown as AbortSignal,
    });

    agent.intercept({ method: 'GET', path: '/data' }).reply(503, 'nope').persist();

    // Settles as a Result rather than rejecting; the request is simply not cancellable.
    const result = await client.get('/data');
    // The crash came from the timer callback, after the sleep had already resolved.
    await new Promise((resolve) => setTimeout(resolve, 50));
    process.off('uncaughtException', uncaught);

    expect(result.isErr()).toBe(true);
    expect(uncaught).not.toHaveBeenCalled();
  });

  test.each([Number.NaN, -1, Number.POSITIVE_INFINITY])(
    'a retryDelay of %p stops the retries instead of reaching setTimeout',
    async (delay) => {
      const emitWarning = vi.spyOn(process, 'emitWarning');
      const onHookError = vi.fn();
      const onAttempt = vi.fn();
      const client = createHttpClient({
        baseUrl,
        retries: 3,
        retryDelay: () => delay,
        onHookError,
        plugins: [{ onAttempt }],
      });

      agent.intercept({ method: 'GET', path: '/data' }).reply(503, 'nope').persist();

      const error = (await client.get('/data'))._unsafeUnwrapErr();

      expect(error.statusCode).toBe(503);
      expect(onAttempt).toHaveBeenCalledTimes(1);
      expect(emitWarning).not.toHaveBeenCalled();
      expect(onHookError).toHaveBeenCalledWith(expect.any(TypeError), { hook: 'retryDelay' });
    },
  );

  test('a retryDelay returning a symbol is reported instead of throwing', async () => {
    const onHookError = vi.fn();
    const client = createHttpClient({
      baseUrl,
      retries: 2,
      retryDelay: () => Symbol('nope') as unknown as number,
      onHookError,
    });

    agent.intercept({ method: 'GET', path: '/data' }).reply(503, 'nope').persist();

    const error = (await client.get('/data'))._unsafeUnwrapErr();

    expect(error.statusCode).toBe(503);
    expect(onHookError).toHaveBeenCalledWith(expect.any(TypeError), { hook: 'retryDelay' });
  });
});

describe('connection hygiene', () => {
  test('drains the response of every attempt that is retried away', async () => {
    const retried: Response[] = [];
    const client = createHttpClient({
      baseUrl,
      retries: 3,
      retryDelay: () => 0,
      retryOn: (_ctx, result) => {
        if (result.isErr() && result.error.response) {
          retried.push(result.error.response);
        }
        return result.isErr();
      },
    });

    agent.intercept({ method: 'GET', path: '/data' }).reply(503, 'nope');
    agent.intercept({ method: 'GET', path: '/data' }).reply(503, 'nope');
    agent.intercept({ method: 'GET', path: '/data' }).reply(200, { message: 'Success' });

    const result = await client.get('/data');

    expect(result.isOk()).toBe(true);
    // Captured before the drain, so a false here would mean the drain never ran.
    expect(retried.map((res) => res.bodyUsed)).toEqual([true, true]);
  });

  test('a response body a hook has locked is left alone', async () => {
    const client = createHttpClient({
      baseUrl,
      retries: 2,
      retryDelay: () => 0,
      retryOn: (_ctx, result) => {
        if (result.isErr()) {
          result.error.response?.body?.getReader();
        }
        return true;
      },
    });

    agent.intercept({ method: 'GET', path: '/data' }).reply(503, 'nope').persist();

    // The drain must not take a second reader: that throws, out of the never-throws path.
    const error = (await client.get('/data'))._unsafeUnwrapErr();

    expect(error.statusCode).toBe(503);
  });

  test('leaves the terminal error response unread', async () => {
    const client = createHttpClient({ baseUrl, retries: 2, retryDelay: () => 0 });

    agent.intercept({ method: 'GET', path: '/data' }).reply(503, 'nope').persist();

    const error = (await client.get('/data'))._unsafeUnwrapErr();

    expect(error.response?.bodyUsed).toBe(false);
    await expect(error.response?.text()).resolves.toBe('nope');
  });
});
