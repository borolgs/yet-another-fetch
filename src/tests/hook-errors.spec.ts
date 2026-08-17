import { describe, expect, test, vi } from 'vitest';

import { createHttpClient } from '../client';
import { baseUrl, setupMockAgent } from './helpers';

const agent = setupMockAgent();

describe('hook errors', () => {
  const throwing = () => {
    throw new Error('plugin is broken');
  };

  test('a throwing onAttempt does not fail the request', async () => {
    const onHookError = vi.fn();
    const client = createHttpClient({
      baseUrl,
      onHookError,
      plugins: [{ name: 'broken', onAttempt: throwing }],
    });

    agent.intercept({ method: 'GET', path: '/data' }).reply(200, '');

    const result = await client.get('/data');

    expect(result.isOk()).toBe(true);
    expect(onHookError).toHaveBeenCalledWith(expect.any(Error), {
      hook: 'onAttempt',
      plugin: 'broken',
    });
  });

  test('a throwing onSettled does not turn a success into an error', async () => {
    const onHookError = vi.fn();
    const client = createHttpClient({
      baseUrl,
      onHookError,
      plugins: [{ name: 'broken', onSettled: throwing }],
    });

    agent.intercept({ method: 'GET', path: '/data' }).reply(200, '');

    const result = await client.get('/data');

    expect(result.isOk()).toBe(true);
    expect(onHookError).toHaveBeenCalledWith(expect.any(Error), {
      hook: 'onSettled',
      plugin: 'broken',
    });
  });

  test('a throwing retryOn fails closed: no retry, last result returned', async () => {
    const onHookError = vi.fn();
    const onAttempt = vi.fn();
    const client = createHttpClient({
      baseUrl,
      retries: 3,
      retryDelay: () => 1,
      retryOn: throwing,
      onHookError,
      plugins: [{ onAttempt }],
    });

    agent.intercept({ method: 'GET', path: '/data' }).reply(500, 'nope');

    const result = await client.get('/data');

    expect(result._unsafeUnwrapErr().statusCode).toBe(500);
    expect(onAttempt).toHaveBeenCalledTimes(1);
    expect(onHookError).toHaveBeenCalledWith(expect.any(Error), { hook: 'retryOn' });
  });

  test('a throwing retryDelay fails closed: no retry, last result returned', async () => {
    const onHookError = vi.fn();
    const onAttempt = vi.fn();
    const client = createHttpClient({
      baseUrl,
      retries: 3,
      retryDelay: throwing,
      onHookError,
      plugins: [{ onAttempt }],
    });

    agent.intercept({ method: 'GET', path: '/data' }).reply(500, 'nope');

    const result = await client.get('/data');

    expect(result._unsafeUnwrapErr().statusCode).toBe(500);
    expect(onAttempt).toHaveBeenCalledTimes(1);
    expect(onHookError).toHaveBeenCalledWith(expect.any(Error), { hook: 'retryDelay' });
  });

  test('with onHookError unset, nothing fails and nothing is logged', async () => {
    const consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => {}),
    );

    const client = createHttpClient({
      baseUrl,
      plugins: [{ name: 'broken', onAttempt: throwing, onSettled: throwing }],
    });

    agent.intercept({ method: 'GET', path: '/data' }).reply(200, '');

    const result = await client.get('/data');

    expect(result.isOk()).toBe(true);
    for (const spy of consoleSpies) {
      expect(spy).not.toHaveBeenCalled();
    }
  });

  describe('async hooks', () => {
    /** Node kills the process on an unhandled rejection, so nothing may escape a hook. */
    async function unhandledRejections(run: () => Promise<unknown>) {
      const seen: unknown[] = [];
      const listener = (reason: unknown) => seen.push(reason);

      process.on('unhandledRejection', listener);
      try {
        await run();
        // Rejections are reported a tick after the microtask queue drains.
        await new Promise((resolve) => setTimeout(resolve, 20));
      } finally {
        process.off('unhandledRejection', listener);
      }

      return seen;
    }

    // `() => void` accepts `async () => {}`, so these are all reachable from typed code.
    const rejecting = async () => {
      throw new Error('plugin is broken');
    };

    test('a rejecting async onAttempt is reported, not thrown at the process', async () => {
      const onHookError = vi.fn();
      const client = createHttpClient({
        baseUrl,
        onHookError,
        plugins: [{ name: 'broken', onAttempt: rejecting }],
      });

      agent.intercept({ method: 'GET', path: '/data' }).reply(200, '');

      let result: Awaited<ReturnType<typeof client.get>> | undefined;
      const escaped = await unhandledRejections(async () => {
        result = await client.get('/data');
      });

      expect(escaped).toEqual([]);
      expect(result?.isOk()).toBe(true);
      expect(onHookError).toHaveBeenCalledWith(expect.any(Error), {
        hook: 'onAttempt',
        plugin: 'broken',
      });
      expect(onHookError).toHaveBeenCalledWith(expect.any(TypeError), {
        hook: 'onAttempt',
        plugin: 'broken',
      });
    });

    test('a rejecting async onSettled is reported, not thrown at the process', async () => {
      const onHookError = vi.fn();
      const client = createHttpClient({
        baseUrl,
        onHookError,
        plugins: [{ name: 'broken', onSettled: rejecting }],
      });

      agent.intercept({ method: 'GET', path: '/data' }).reply(200, '');

      let result: Awaited<ReturnType<typeof client.get>> | undefined;
      const escaped = await unhandledRejections(async () => {
        result = await client.get('/data');
      });

      expect(escaped).toEqual([]);
      expect(result?.isOk()).toBe(true);
      expect(onHookError).toHaveBeenCalledWith(expect.any(Error), {
        hook: 'onSettled',
        plugin: 'broken',
      });
    });

    test('with onHookError unset, a rejecting async hook still escapes nothing', async () => {
      const client = createHttpClient({
        baseUrl,
        plugins: [{ onAttempt: rejecting, onSettled: rejecting }],
      });

      agent.intercept({ method: 'GET', path: '/data' }).reply(200, '');

      let result: Awaited<ReturnType<typeof client.get>> | undefined;
      const escaped = await unhandledRejections(async () => {
        result = await client.get('/data');
      });

      expect(escaped).toEqual([]);
      expect(result?.isOk()).toBe(true);
    });

    test('an async retryOn fails closed instead of retrying on a truthy promise', async () => {
      const onHookError = vi.fn();
      const onAttempt = vi.fn();
      const client = createHttpClient({
        baseUrl,
        retries: 3,
        retryDelay: () => 1,
        // Always-true if the promise were taken at face value.
        retryOn: (async () => false) as never,
        onHookError,
        plugins: [{ onAttempt }],
      });

      agent.intercept({ method: 'GET', path: '/data' }).reply(500, 'nope');

      const result = await client.get('/data');

      expect(result._unsafeUnwrapErr().statusCode).toBe(500);
      expect(onAttempt).toHaveBeenCalledTimes(1);
      expect(onHookError).toHaveBeenCalledWith(expect.any(TypeError), { hook: 'retryOn' });
    });

    test('an async retryDelay fails closed instead of retrying with no delay', async () => {
      const onHookError = vi.fn();
      const onAttempt = vi.fn();
      const client = createHttpClient({
        baseUrl,
        retries: 3,
        retryDelay: (async () => 1) as never,
        onHookError,
        plugins: [{ onAttempt }],
      });

      agent.intercept({ method: 'GET', path: '/data' }).reply(500, 'nope');

      const result = await client.get('/data');

      expect(result._unsafeUnwrapErr().statusCode).toBe(500);
      expect(onAttempt).toHaveBeenCalledTimes(1);
      expect(onHookError).toHaveBeenCalledWith(expect.any(TypeError), { hook: 'retryDelay' });
    });

    test('an async requestId falls back to a uuid', async () => {
      const onHookError = vi.fn();
      let ctxId: string | undefined;
      const client = createHttpClient({
        baseUrl,
        onHookError,
        requestId: (async () => 'from-client') as never,
        plugins: [
          {
            onAttempt: (ctx) => {
              ctxId = ctx.id;
            },
          },
        ],
      });

      agent.intercept({ method: 'GET', path: '/data' }).reply(200, '');

      const result = await client.get('/data');

      expect(result.isOk()).toBe(true);
      expect(ctxId).toMatch(/^[0-9a-f-]{36}$/);
      expect(onHookError).toHaveBeenCalledWith(expect.any(TypeError), { hook: 'requestId' });
    });
  });

  test('a throwing onHookError is swallowed', async () => {
    const client = createHttpClient({
      baseUrl,
      onHookError: throwing,
      plugins: [{ onAttempt: throwing, onSettled: throwing }],
    });

    agent.intercept({ method: 'GET', path: '/data' }).reply(200, '');

    const result = await client.get('/data');

    expect(result.isOk()).toBe(true);
  });
});
