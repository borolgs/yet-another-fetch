import { MockAgent, setGlobalDispatcher } from 'undici';
import { describe, test, expect, vi, beforeEach } from 'vitest';

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
