import { describe, expect, test, vi } from 'vitest';

import { createHttpClient } from '../client';
import { baseUrl, setupMockAgent } from './helpers';

const agent = setupMockAgent();

describe('request context', () => {
  test('ctx.init mutations persist across the attempts of one call', async () => {
    const client = createHttpClient({
      baseUrl,
      retries: 3,
      retryDelay: () => 1,
      plugins: [
        {
          onAttempt: (ctx) => {
            if (ctx.attempt === 0) {
              (ctx.init.headers as Record<string, string>)['x-attempt-0'] = 'written';
            }
          },
        },
      ],
    });

    agent.intercept({ method: 'GET', path: '/data' }).replyWithError(new Error('Request failed'));
    agent.intercept({ method: 'GET', path: '/data' }).replyWithError(new Error('Request failed'));
    // Only matches if the header written on attempt 0 survived into attempt 2.
    agent
      .intercept({ method: 'GET', path: '/data', headers: { 'x-attempt-0': 'written' } })
      .reply(200, '');

    const result = await client.get('/data');

    expect(result.isOk()).toBe(true);
  });

  test('ctx.init does not leak between two calls on the same client', async () => {
    const seen: (string | undefined)[] = [];
    const client = createHttpClient({
      baseUrl,
      plugins: [
        {
          onAttempt: (ctx) => {
            const headers = ctx.init.headers as Record<string, string>;
            seen.push(headers['x-call']);
            headers['x-call'] = 'set';
          },
        },
      ],
    });

    agent.intercept({ method: 'GET', path: '/data' }).reply(200, '').persist();

    await client.get('/data');
    await client.get('/data');

    expect(seen).toEqual([undefined, undefined]);
  });

  test('mutating ctx.url does not change where the request goes', async () => {
    const client = createHttpClient({
      baseUrl,
      plugins: [
        {
          onAttempt: (ctx) => {
            ctx.url.pathname = '/somewhere-else';
          },
        },
      ],
    });

    // Net connect is disabled and only /data is mocked, so a rewritten url cannot succeed.
    agent.intercept({ method: 'GET', path: '/data' }).reply(200, '');

    const result = await client.get('/data');

    expect(result.isOk()).toBe(true);
  });

  test('mutating ctx.url does not change the url errors report', async () => {
    const client = createHttpClient({
      baseUrl,
      plugins: [
        {
          onAttempt: (ctx) => {
            ctx.url.pathname = '/somewhere-else';
          },
        },
      ],
    });

    agent.intercept({ method: 'GET', path: '/data' }).reply(404, '');

    const error = (await client.get('/data'))._unsafeUnwrapErr();

    expect(error.url).toBe(`${baseUrl}/data`);
  });

  test('errors carry the context scalars', async () => {
    let ctxId: string | undefined;
    const client = createHttpClient({
      baseUrl,
      plugins: [
        {
          onAttempt: (ctx) => {
            ctxId = ctx.id;
          },
        },
      ],
    });

    agent.intercept({ method: 'GET', path: '/data' }).reply(404, { message: 'Not Found' });

    const error = (await client.get('/data'))._unsafeUnwrapErr();

    expect(error).toMatchObject({
      reason: 'status',
      statusCode: 404,
      url: `${baseUrl}/data`,
      method: 'GET',
      attempt: 0,
    });
    expect(error.requestId).toBe(ctxId);
  });

  test('a parse error carries the context scalars too', async () => {
    const client = createHttpClient({ baseUrl });

    agent
      .intercept({ method: 'GET', path: '/data' })
      .reply(200, 'message: Success', { headers: { 'Content-Type': 'application/json' } });

    const error = (await client.get('/data').andThen((res) => res.json()))._unsafeUnwrapErr();

    expect(error).toMatchObject({
      reason: 'parse',
      url: `${baseUrl}/data`,
      method: 'GET',
      attempt: 0,
    });
    expect(error.requestId).toEqual(expect.any(String));
  });

  describe('requestId', () => {
    test('defaults to a generated uuid', async () => {
      let ctxId: string | undefined;
      const client = createHttpClient({
        baseUrl,
        plugins: [
          {
            onAttempt: (ctx) => {
              ctxId = ctx.id;
            },
          },
        ],
      });

      agent.intercept({ method: 'GET', path: '/data' }).reply(200, '');

      await client.get('/data');

      expect(ctxId).toMatch(/^[0-9a-f-]{36}$/);
    });

    test('the client-level generator overrides the default', async () => {
      let ctxId: string | undefined;
      const client = createHttpClient({
        baseUrl,
        requestId: () => 'from-client',
        plugins: [
          {
            onAttempt: (ctx) => {
              ctxId = ctx.id;
            },
          },
        ],
      });

      agent.intercept({ method: 'GET', path: '/data' }).reply(200, '');

      await client.get('/data');

      expect(ctxId).toBe('from-client');
    });

    test('a per-call requestId overrides the client-level generator', async () => {
      let ctxId: string | undefined;
      const client = createHttpClient({
        baseUrl,
        requestId: () => 'from-client',
        plugins: [
          {
            onAttempt: (ctx) => {
              ctxId = ctx.id;
            },
          },
        ],
      });

      agent.intercept({ method: 'GET', path: '/data' }).reply(200, '');

      await client.get('/data', { requestId: 'from-call' });

      expect(ctxId).toBe('from-call');
    });

    test('a throwing generator falls back to a uuid and reports to onHookError', async () => {
      let ctxId: string | undefined;
      const onHookError = vi.fn();
      const client = createHttpClient({
        baseUrl,
        onHookError,
        requestId: () => {
          throw new Error('boom');
        },
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
      expect(onHookError).toHaveBeenCalledWith(expect.any(Error), { hook: 'requestId' });
    });
  });
});
