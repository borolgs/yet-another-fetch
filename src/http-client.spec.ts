import nock from 'nock';

import { createHttpClient } from './http-client';

describe('httpClient', () => {
  const baseUrl = 'https://example.com';

  beforeEach(() => {
    nock.disableNetConnect();
    nock.cleanAll();
  });

  describe('handle HTTP errors properly', () => {
    test('404', async () => {
      const inspectError = jest.fn();
      const client = createHttpClient({ baseUrl, inspectError });

      nock(baseUrl).get('/data').reply(404, { message: 'Not Found' });

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

    nock(baseUrl)
      .persist()
      .get('/data')
      .reply(200, { message: 'Success!' }, { 'Content-Type': 'application/json' });

    const result = (
      await client.request('/data', { method: 'GET' }).andThen((r) => r.json())
    )._unsafeUnwrap();
    const result2 = (await client.get('/data').andThen((r) => r.json()))._unsafeUnwrap();

    expect(result).toEqual({ message: 'Success!' });
    expect(result2).toEqual({ message: 'Success!' });
  });

  test('handle JSON parse error', async () => {
    const client = createHttpClient({ baseUrl });

    nock(baseUrl)
      .persist()
      .get('/data')
      .reply(200, 'message: Success', { 'Content-Type': 'application/json' });

    const result = await client.request('/data', { method: 'GET' }).andThen((r) => r.json());

    expect(result.isErr()).toBe(true);
    expect((result._unsafeUnwrapErr().cause as any).name).toBe('SyntaxError');
  });

  test('handle non-JSON response', async () => {
    const client = createHttpClient({ baseUrl });

    nock(baseUrl).get('/data').reply(200, 'plain text', { 'Content-Type': 'text/plain' });

    const result = (
      await client.request('/data', { method: 'GET' }).andThen((r) => r.text())
    )._unsafeUnwrap();

    expect(result).toBe('plain text');
  });

  test('make a POST request with JSON payload successfully', async () => {
    const client = createHttpClient({ baseUrl });

    const requestData = { name: 'John', age: 30 };
    nock(baseUrl)
      .persist()
      .post('/data', JSON.stringify(requestData))
      .reply(200, { message: 'Data received' });

    const result = (
      await client
        .request('/data', { method: 'POST', data: requestData })
        .andThen((res) => res.json())
    )._unsafeUnwrap();
    expect(result).toEqual({ message: 'Data received' });
  });

  test('call callbacks', async () => {
    const interceptRequest = jest.fn();
    const inspectResponse = jest.fn();
    const client = createHttpClient({
      baseUrl,
      interceptRequest,
      inspectResponse,
    });

    nock(baseUrl).get('/data').reply(200, { message: 'Success!' });

    const result = await client.request('/data', { method: 'GET' });

    expect(result.isOk()).toBe(true);
    expect(interceptRequest).toHaveBeenCalledTimes(1);
    expect(inspectResponse).toHaveBeenCalledTimes(1);
  });

  test('merge defaultInit and init properly', async () => {
    const interceptRequest = jest.fn();
    const client = createHttpClient({
      baseUrl,
      interceptRequest,
      headers: {
        'X-Custom-Header': 'customValue',
      },
      mode: 'cors',
    });

    nock(baseUrl, {
      reqheaders: {
        'Content-Type': 'application/json',
        'X-Custom-Header': 'newValue',
        Authorization: 'Bearer token123',
      },
    })
      .get('/data?someParam=true&anotherParam=someValue2&thirdParam=thirdValue#omg')
      .reply(200, { message: 'Data received' });

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
    expect(interceptRequest.mock.lastCall[1]).toMatchObject({
      credentials: 'same-origin',
      mode: 'no-cors',
    });
  });

  test('retry failed requests according to retry options', async () => {
    const client = createHttpClient({
      baseUrl,
      retries: 3,
      retryDelay: () => 10,
    });

    nock(baseUrl)
      .get('/data')
      .replyWithError('Request failed')
      .get('/data')
      .replyWithError('Request failed')
      .get('/data')
      .reply(200, { message: 'Data received' });

    const result = await client.request('/data', {
      method: 'GET',
    });

    expect(result.isOk()).toBe(true);
  });
});
