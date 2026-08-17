import { MockAgent, setGlobalDispatcher } from 'undici';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { createHttpClient } from './http-client';

describe('httpClient', () => {
  const baseUrl = 'https://example.com';

  let agent: MockAgent;

  beforeEach(() => {
    agent = new MockAgent();

    setGlobalDispatcher(agent);
    agent.disableNetConnect();
  });

  describe('handle HTTP errors properly', () => {
    test('404', async () => {
      const inspectError = vi.fn();
      const client = createHttpClient({ baseUrl, inspectError });

      agent
        .get(baseUrl)
        .intercept({ method: 'GET', path: '/data' })
        .reply(404, { message: 'Not Found' });

      const result = (await client.request('/data', { method: 'GET' }))._unsafeUnwrapErr();

      expect(result).toMatchObject({
        status: 'Not Found',
        statusCode: 404,
      });

      expect(inspectError).toHaveBeenCalledTimes(1);
    });

    test('404 carries reason "status"', async () => {
      const client = createHttpClient({ baseUrl });

      agent
        .get(baseUrl)
        .intercept({ method: 'GET', path: '/data' })
        .reply(404, { message: 'Not Found' });

      const error = (await client.get('/data'))._unsafeUnwrapErr();

      expect(error.reason).toBe('status');
    });

    test('transport failure carries reason "network"', async () => {
      const client = createHttpClient({ baseUrl });

      agent
        .get(baseUrl)
        .intercept({ method: 'GET', path: '/data' })
        .replyWithError(new Error('Request failed'));

      const error = (await client.get('/data'))._unsafeUnwrapErr();

      expect(error.reason).toBe('network');
    });

    test('body parse failure carries reason "parse"', async () => {
      const client = createHttpClient({ baseUrl });

      agent
        .get(baseUrl)
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

  describe('methods', () => {
    test.for(['GET', 'HEAD', 'DELETE', 'POST', 'PUT', 'PATCH'] as const)('%s', async (method) => {
      const client = createHttpClient({ baseUrl });

      agent.get(baseUrl).intercept({ method, path: '/data' }).reply(200, '');

      const result =
        await client[method.toLowerCase() as 'get' | 'head' | 'delete' | 'post' | 'put' | 'patch'](
          '/data',
        );

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().status).toBe(200);
    });
  });

  test('handle JSON response', async () => {
    const client = createHttpClient({ baseUrl });

    agent
      .get(baseUrl)
      .intercept({ method: 'GET', path: '/data' })
      .reply(200, { message: 'Success!' }, { headers: { 'Content-Type': 'application/json' } })
      .persist();

    const result = (
      await client.request('/data', { method: 'GET' }).andThen((r) => r.json())
    )._unsafeUnwrap();
    const result2 = (await client.get('/data').andThen((r) => r.json()))._unsafeUnwrap();

    expect(result).toEqual({ message: 'Success!' });
    expect(result2).toEqual({ message: 'Success!' });
  });

  test('read response metadata through the proxy', async () => {
    const client = createHttpClient({ baseUrl });

    agent
      .get(baseUrl)
      .intercept({ method: 'GET', path: '/data' })
      .reply(200, { message: 'Success!' }, { headers: { 'Content-Type': 'application/json' } });

    const res = (await client.get('/data'))._unsafeUnwrap();

    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(res.clone().status).toBe(200);
  });

  test('handle JSON parse error', async () => {
    const client = createHttpClient({ baseUrl });

    agent
      .get(baseUrl)
      .intercept({ method: 'GET', path: '/data' })
      .reply(200, 'message: Success', { headers: { 'Content-Type': 'application/json' } });

    const result = await client.request('/data', { method: 'GET' }).andThen((r) => r.json());

    expect(result.isErr()).toBe(true);

    expect((result._unsafeUnwrapErr().cause as any).name).toBe('SyntaxError');
  });

  test('handle non-JSON response', async () => {
    const client = createHttpClient({ baseUrl });

    agent
      .get(baseUrl)
      .intercept({ method: 'GET', path: '/data' })
      .reply(200, 'plain text', { headers: { 'Content-Type': 'text/plain' } });

    const result = (
      await client.request('/data', { method: 'GET' }).andThen((r) => r.text())
    )._unsafeUnwrap();

    expect(result).toBe('plain text');
  });

  test('make a POST request with JSON payload successfully', async () => {
    const client = createHttpClient({ baseUrl });

    const requestData = { name: 'John', age: 30 };

    agent
      .get(baseUrl)
      .intercept({ method: 'POST', path: '/data', body: JSON.stringify(requestData) })
      .reply(200, { message: 'Data received' });

    const result = (
      await client
        .request('/data', { method: 'POST', data: requestData })
        .andThen((res) => res.json())
    )._unsafeUnwrap();
    expect(result).toEqual({ message: 'Data received' });
  });

  test('call callbacks', async () => {
    const interceptRequest = vi.fn();
    const inspectResponse = vi.fn();
    const client = createHttpClient({ baseUrl, interceptRequest, inspectResponse });

    agent
      .get(baseUrl)
      .intercept({ method: 'GET', path: '/data' })
      .reply(200, { message: 'Success!' });

    const result = await client.request('/data', { method: 'GET' });

    expect(result.isOk()).toBe(true);
    expect(interceptRequest).toHaveBeenCalledTimes(1);
    expect(inspectResponse).toHaveBeenCalledTimes(1);
  });

  test('merge defaultInit and init properly', async () => {
    const interceptRequest = vi.fn();
    const client = createHttpClient({
      baseUrl,
      interceptRequest,
      headers: {
        'X-Custom-Header': 'customValue',
      },
      mode: 'cors',
    });

    agent
      .get(baseUrl)
      .intercept({
        method: 'GET',
        path: '/data?someParam=true&anotherParam=someValue2&thirdParam=thirdValue#omg',
        headers: {
          'Content-Type': 'application/json',
          'X-Custom-Header': 'newValue',
          Authorization: 'Bearer token123',
        },
      })
      .reply(200, { message: 'Success!' });

    const result = await client.get(
      '/data?someParam=true&anotherParam=someValue2&thirdParam=thirdValue#omg',
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer token123',
          'X-Custom-Header': 'newValue',
        },
        query: {
          anotherParam: 'someValue2',
          thirdParam: 'thirdValue',
        },
        mode: 'no-cors',
        credentials: 'same-origin',
      },
    );

    expect(result.isOk()).toBe(true);
    expect(interceptRequest.mock.calls.at(-1)![1]).toMatchObject({
      credentials: 'same-origin',
      mode: 'no-cors',
    });
  });

  test('retry failed requests according to retry options', async () => {
    const client = createHttpClient({ baseUrl, retries: 3, retryDelay: () => 10 });

    agent
      .get(baseUrl)
      .intercept({ method: 'GET', path: '/data' })
      .replyWithError(new Error('Request failed'));
    agent
      .get(baseUrl)
      .intercept({ method: 'GET', path: '/data' })
      .replyWithError(new Error('Request failed'));
    agent
      .get(baseUrl)
      .intercept({ method: 'GET', path: '/data' })
      .reply(200, { message: 'Success' });

    const result = await client.request('/data', {
      method: 'GET',
    });

    expect(result.isOk()).toBe(true);
  });
});
