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
