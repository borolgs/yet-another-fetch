import { describe, expect, test, vi } from 'vitest';

import { createHttpClient, type HttpClientPlugin } from '../client';
import { baseUrl, setupMockAgent } from './helpers';

const agent = setupMockAgent();

describe('plugins', () => {
  test('3 network failures: onAttempt x3, onSettled x1', async () => {
    const attempts: Array<{ id: string; attempt: number }> = [];
    const settled: Array<{ id: string; attempt: number; isErr: boolean }> = [];

    const client = createHttpClient({
      baseUrl,
      retries: 3,
      retryDelay: () => 1,
      plugins: [
        {
          onAttempt: (ctx) => attempts.push({ id: ctx.id, attempt: ctx.attempt }),
          onSettled: (ctx, result) =>
            settled.push({ id: ctx.id, attempt: ctx.attempt, isErr: result.isErr() }),
        },
      ],
    });

    for (let i = 0; i < 3; i++) {
      agent.intercept({ method: 'GET', path: '/data' }).replyWithError(new Error('Request failed'));
    }

    const result = await client.get('/data');

    expect(result.isErr()).toBe(true);
    expect(attempts.map((a) => a.attempt)).toEqual([0, 1, 2]);
    expect(settled).toEqual([{ id: attempts[0].id, attempt: 2, isErr: true }]);
    expect(new Set(attempts.map((a) => a.id)).size).toBe(1);
  });

  test('500 then 200: onAttempt x2, one ok in onSettled with attempt === 1', async () => {
    const onAttempt = vi.fn();
    const onSettled = vi.fn();

    const client = createHttpClient({
      baseUrl,
      retries: 3,
      retryDelay: () => 1,
      plugins: [{ onAttempt, onSettled }],
    });

    agent.intercept({ method: 'GET', path: '/data' }).reply(500, 'nope');
    agent.intercept({ method: 'GET', path: '/data' }).reply(200, '');

    const result = await client.get('/data');

    expect(result.isOk()).toBe(true);
    expect(onAttempt).toHaveBeenCalledTimes(2);
    expect(onSettled).toHaveBeenCalledTimes(1);

    const [ctx, settledResult] = onSettled.mock.calls[0];
    expect(ctx.attempt).toBe(1);
    expect(settledResult.isOk()).toBe(true);
  });

  test('onSettled fires exactly once on a plain success', async () => {
    const onSettled = vi.fn();
    const client = createHttpClient({ baseUrl, plugins: [{ onSettled }] });

    agent.intercept({ method: 'GET', path: '/data' }).reply(200, '');

    await client.get('/data');

    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onSettled.mock.calls[0][0].attempt).toBe(0);
  });

  test('a plugin with only onSettled works', async () => {
    const onSettled = vi.fn();
    const client = createHttpClient({ baseUrl, plugins: [{ onSettled }] });

    agent.intercept({ method: 'GET', path: '/data' }).reply(200, '');

    const result = await client.get('/data');

    expect(result.isOk()).toBe(true);
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  test('onAttempt mutating ctx.init.headers reaches fetch', async () => {
    const client = createHttpClient({
      baseUrl,
      plugins: [
        {
          onAttempt: (ctx) => {
            (ctx.init.headers as Record<string, string>).Authorization = 'Bearer token';
          },
        },
      ],
    });

    agent
      .intercept({
        method: 'GET',
        path: '/data',
        headers: { Authorization: 'Bearer token' },
      })
      .reply(200, '');

    const result = await client.get('/data');

    expect(result.isOk()).toBe(true);
  });

  test('plugins run in array order', async () => {
    const order: string[] = [];
    const plugin = (name: string): HttpClientPlugin => ({
      name,
      onAttempt: () => order.push(`${name}:attempt`),
      onSettled: () => order.push(`${name}:settled`),
    });

    const client = createHttpClient({ baseUrl, plugins: [plugin('a'), plugin('b')] });

    agent.intercept({ method: 'GET', path: '/data' }).reply(200, '');

    await client.get('/data');

    expect(order).toEqual(['a:attempt', 'b:attempt', 'a:settled', 'b:settled']);
  });

  test('a "config" error fires no hook at all', async () => {
    const onAttempt = vi.fn();
    const onSettled = vi.fn();
    const requestId = vi.fn(() => 'id');

    const client = createHttpClient({
      baseUrl: 'not-a-url',
      requestId,
      plugins: [{ onAttempt, onSettled }],
    });

    const result = await client.get('/data');

    expect(result._unsafeUnwrapErr().reason).toBe('config');
    expect(onAttempt).not.toHaveBeenCalled();
    expect(onSettled).not.toHaveBeenCalled();
    expect(requestId).not.toHaveBeenCalled();
  });

  describe('duration', () => {
    test('is finite and >= 0 on a plain success', async () => {
      const onSettled = vi.fn();
      const client = createHttpClient({ baseUrl, plugins: [{ onSettled }] });

      agent.intercept({ method: 'GET', path: '/data' }).reply(200, '');

      await client.get('/data');

      const { duration } = onSettled.mock.calls[0][0];
      expect(Number.isFinite(duration)).toBe(true);
      expect(duration).toBeGreaterThanOrEqual(0);
    });

    test('includes the retry delay', async () => {
      const onSettled = vi.fn();
      const client = createHttpClient({
        baseUrl,
        retries: 2,
        retryDelay: () => 20,
        plugins: [{ onSettled }],
      });

      agent.intercept({ method: 'GET', path: '/data' }).replyWithError(new Error('Request failed'));
      agent.intercept({ method: 'GET', path: '/data' }).reply(200, '');

      await client.get('/data');

      expect(onSettled.mock.calls[0][0].duration).toBeGreaterThanOrEqual(20);
    });
  });
});
