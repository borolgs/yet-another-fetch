import { describe, expect, test, vi } from 'vitest';

import { createHttpClient } from '../client';
import { baseUrl, setupMockAgent } from './helpers';

const agent = setupMockAgent();

describe('handle HTTP errors properly', () => {
  test('404', async () => {
    const onSettled = vi.fn();
    const client = createHttpClient({ baseUrl, plugins: [{ onSettled }] });

    agent.intercept({ method: 'GET', path: '/data' }).reply(404, { message: 'Not Found' });

    const result = (await client.request('/data', { method: 'GET' }))._unsafeUnwrapErr();

    expect(result).toMatchObject({
      status: 'Not Found',
      statusCode: 404,
    });

    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onSettled.mock.calls[0][1].isErr()).toBe(true);
  });

  test('404 carries reason "status"', async () => {
    const client = createHttpClient({ baseUrl });

    agent.intercept({ method: 'GET', path: '/data' }).reply(404, { message: 'Not Found' });

    const error = (await client.get('/data'))._unsafeUnwrapErr();

    expect(error.reason).toBe('status');
  });

  test('transport failure carries reason "network"', async () => {
    const client = createHttpClient({ baseUrl });

    agent.intercept({ method: 'GET', path: '/data' }).replyWithError(new Error('Request failed'));

    const error = (await client.get('/data'))._unsafeUnwrapErr();

    expect(error.reason).toBe('network');
  });

  test('body parse failure carries reason "parse"', async () => {
    const client = createHttpClient({ baseUrl });

    agent
      .intercept({ method: 'GET', path: '/data' })
      .reply(200, 'message: Success', { headers: { 'Content-Type': 'application/json' } });

    const error = (await client.get('/data').andThen((res) => res.json()))._unsafeUnwrapErr();

    expect(error.reason).toBe('parse');
  });
});

describe('never throws', () => {
  test('a malformed url returns an err instead of throwing', async () => {
    const client = createHttpClient();

    const result = await client.get('//bad');

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().reason).toBe('config');
  });

  test('a malformed baseUrl returns an err instead of throwing', async () => {
    const client = createHttpClient({ baseUrl: 'not-a-url' });

    const result = await client.get('/data');

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().reason).toBe('config');
  });

  test('circular data returns an err instead of throwing', async () => {
    const client = createHttpClient({ baseUrl });

    const data: any = { name: 'John' };
    data.self = data;

    const result = await client.post('/data', { data });

    expect(result.isErr()).toBe(true);

    const error = result._unsafeUnwrapErr();
    expect(error.reason).toBe('config');
    expect((error.cause as any).name).toBe('TypeError');
  });
});
