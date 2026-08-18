import type { MockInterceptor } from 'undici/types/mock-interceptor';
import { describe, expect, test, vi } from 'vitest';

import { createHttpClient, type RequestContext } from '../client';
import { baseUrl, setupMockAgent } from './helpers';

const agent = setupMockAgent();

describe('methods', () => {
  test.for(['GET', 'HEAD', 'DELETE', 'POST', 'PUT', 'PATCH'] as const)('%s', async (method) => {
    const client = createHttpClient({ baseUrl });

    agent.intercept({ method, path: '/data' }).reply(200, '');

    const result =
      await client[method.toLowerCase() as 'get' | 'head' | 'delete' | 'post' | 'put' | 'patch'](
        '/data',
      );

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().status).toBe(200);
  });
});

test('make a POST request with JSON payload successfully', async () => {
  const client = createHttpClient({ baseUrl });

  const requestData = { name: 'John', age: 30 };

  agent
    .intercept({ method: 'POST', path: '/data', body: JSON.stringify(requestData) })
    .reply(200, { message: 'Data received' });

  const result = (
    await client
      .request('/data', { method: 'POST', data: requestData })
      .andThen((res) => res.json())
  )._unsafeUnwrap();
  expect(result).toEqual({ message: 'Data received' });
});

test('merge defaultInit and init properly', async () => {
  let seenInit: RequestContext['init'] | undefined;
  const client = createHttpClient({
    baseUrl,
    plugins: [
      {
        onAttempt: (ctx) => {
          seenInit = ctx.init;
        },
      },
    ],
    headers: {
      'X-Custom-Header': 'customValue',
    },
    mode: 'cors',
  });

  agent
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
  expect(seenInit).toMatchObject({
    credentials: 'same-origin',
    mode: 'no-cors',
  });
});

/** Normalizes the headers the mock saw on the wire to lowercase keys. */
function wireHeaders(
  headers: MockInterceptor.MockResponseCallbackOptions['headers'],
): Record<string, string> {
  if (!headers) {
    return {};
  }
  if (headers instanceof Headers) {
    const record: Record<string, string> = {};
    headers.forEach((value, key) => {
      record[key] = value;
    });
    return record;
  }
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value)]),
  );
}

/** Captures what actually reached the wire; assertions on `ctx.init` would not catch #1/#2. */
function captureRequest() {
  const seen: { headers: Record<string, string>; path: string; body: unknown } = {
    headers: {},
    path: '',
    body: undefined,
  };

  const reply = (opts: MockInterceptor.MockResponseCallbackOptions) => {
    seen.headers = wireHeaders(opts.headers);
    seen.path = opts.path;
    seen.body = opts.body;
    return '';
  };

  return { seen, reply };
}

describe('headers', () => {
  test('a plugin overrides a default whose name is cased differently', async () => {
    const { seen, reply } = captureRequest();
    const client = createHttpClient({
      baseUrl,
      headers: { authorization: 'Bearer STATIC' },
      plugins: [
        {
          onAttempt: (ctx) => {
            ctx.init.headers.Authorization = 'Bearer FRESH';
          },
        },
      ],
    });

    agent.intercept({ method: 'GET', path: '/data' }).reply(200, reply);

    const result = await client.get('/data');

    expect(result.isOk()).toBe(true);
    expect(seen.headers.authorization).toBe('Bearer FRESH');
  });

  test('a plugin overrides a default whose name is cased the other way', async () => {
    const { seen, reply } = captureRequest();
    const client = createHttpClient({
      baseUrl,
      headers: { Authorization: 'Bearer STATIC' },
      plugins: [
        {
          onAttempt: (ctx) => {
            ctx.init.headers.authorization = 'Bearer FRESH';
          },
        },
      ],
    });

    agent.intercept({ method: 'GET', path: '/data' }).reply(200, reply);

    const result = await client.get('/data');

    expect(result.isOk()).toBe(true);
    expect(seen.headers.authorization).toBe('Bearer FRESH');
  });

  test('a per-call header overrides a differently cased default', async () => {
    const { seen, reply } = captureRequest();
    const client = createHttpClient({ baseUrl, headers: { 'X-Custom': 'default' } });

    agent.intercept({ method: 'GET', path: '/data' }).reply(200, reply);

    const result = await client.get('/data', { headers: { 'x-custom': 'call' } });

    expect(result.isOk()).toBe(true);
    expect(seen.headers['x-custom']).toBe('call');
  });

  test('headers given as a Headers instance reach the server', async () => {
    const { seen, reply } = captureRequest();
    const client = createHttpClient({ baseUrl, headers: new Headers({ 'x-default': 'v' }) });

    agent.intercept({ method: 'GET', path: '/data' }).reply(200, reply);

    const result = await client.get('/data', { headers: new Headers({ 'x-call': 'w' }) });

    expect(result.isOk()).toBe(true);
    expect(seen.headers['x-default']).toBe('v');
    expect(seen.headers['x-call']).toBe('w');
  });

  test('headers given as string[][] reach the server', async () => {
    const { seen, reply } = captureRequest();
    const client = createHttpClient({ baseUrl, headers: [['x-default', 'v']] });

    agent.intercept({ method: 'GET', path: '/data' }).reply(200, reply);

    const result = await client.get('/data', { headers: [['x-call', 'w']] });

    expect(result.isOk()).toBe(true);
    expect(seen.headers['x-default']).toBe('v');
    expect(seen.headers['x-call']).toBe('w');
  });

  test('ctx.init.headers is a plain lowercase record', async () => {
    let seenHeaders: Record<string, string> | undefined;
    const client = createHttpClient({
      baseUrl,
      headers: new Headers({ 'X-Default': 'v' }),
      plugins: [
        {
          onAttempt: (ctx) => {
            seenHeaders = { ...ctx.init.headers };
          },
        },
      ],
    });

    agent.intercept({ method: 'GET', path: '/data' }).reply(200, '');

    await client.get('/data', { headers: { 'X-Call': 'w' } });

    expect(seenHeaders).toEqual({ 'x-default': 'v', 'x-call': 'w' });
  });
});

describe('data', () => {
  test('sets content-type: application/json', async () => {
    const { seen, reply } = captureRequest();
    const client = createHttpClient({ baseUrl });

    agent.intercept({ method: 'POST', path: '/data' }).reply(200, reply);

    const result = await client.post('/data', { data: { a: 1 } });

    expect(result.isOk()).toBe(true);
    expect(seen.headers['content-type']).toBe('application/json');
    expect(seen.body).toBe('{"a":1}');
  });

  test('a caller-set content-type wins, whatever its casing', async () => {
    const { seen, reply } = captureRequest();
    const client = createHttpClient({ baseUrl });

    agent.intercept({ method: 'POST', path: '/data' }).reply(200, reply);

    const result = await client.post('/data', {
      data: { a: 1 },
      headers: { 'Content-Type': 'application/vnd.api+json' },
    });

    expect(result.isOk()).toBe(true);
    expect(seen.headers['content-type']).toBe('application/vnd.api+json');
  });

  test("a raw body keeps fetch's own content-type", async () => {
    const { seen, reply } = captureRequest();
    const client = createHttpClient({ baseUrl });

    agent.intercept({ method: 'POST', path: '/data' }).reply(200, reply);

    const result = await client.post('/data', { body: 'raw' });

    expect(result.isOk()).toBe(true);
    expect(seen.headers['content-type']).toBe('text/plain;charset=UTF-8');
  });

  test.for([
    [0, '0'],
    ['', '""'],
    [false, 'false'],
    [null, 'null'],
  ] as const)(
    'falsy data %s serializes instead of falling through to body',
    async ([data, wire]) => {
      const { seen, reply } = captureRequest();
      const client = createHttpClient({ baseUrl });

      agent.intercept({ method: 'POST', path: '/data' }).reply(200, reply);

      const result = await client.post('/data', { data, body: 'FALLBACK-BODY' });

      expect(result.isOk()).toBe(true);
      expect(seen.body).toBe(wire);
    },
  );
});

describe('query', () => {
  test('omits undefined and null values', async () => {
    const { seen, reply } = captureRequest();
    const client = createHttpClient({ baseUrl });

    agent.intercept({ method: 'GET', path: '/data?a=1' }).reply(200, reply);

    const result = await client.get('/data', { query: { a: 1, b: undefined, c: null } });

    expect(result.isOk()).toBe(true);
    expect(seen.path).toBe('/data?a=1');
  });

  test('expands arrays into one param per item', async () => {
    const { seen, reply } = captureRequest();
    const client = createHttpClient({ baseUrl });

    agent.intercept({ method: 'GET', path: '/data?c=x&c=y' }).reply(200, reply);

    const result = await client.get('/data', { query: { c: ['x', 'y'] } });

    expect(result.isOk()).toBe(true);
    expect(seen.path).toBe('/data?c=x&c=y');
  });

  test('an empty query leaves no trailing ?', async () => {
    const { seen, reply } = captureRequest();
    const client = createHttpClient({ baseUrl });

    agent.intercept({ method: 'GET', path: '/data' }).reply(200, reply);

    const result = await client.get('/data', { query: {} });

    expect(result.isOk()).toBe(true);
    expect(seen.path).toBe('/data');
  });

  test('overrides a param already present in the url', async () => {
    const { seen, reply } = captureRequest();
    const client = createHttpClient({ baseUrl });

    agent.intercept({ method: 'GET', path: '/data?a=2&b=3' }).reply(200, reply);

    const result = await client.get('/data?a=1', { query: { a: 2, b: 3 } });

    expect(result.isOk()).toBe(true);
    expect(seen.path).toBe('/data?a=2&b=3');
  });

  test('emits no deprecation warning', async () => {
    const emitWarning = vi.spyOn(process, 'emitWarning');
    const client = createHttpClient({ baseUrl });

    agent.intercept({ method: 'GET', path: '/data?a=1' }).reply(200, '');

    await client.get('/data', { query: { a: 1 } });

    expect(emitWarning).not.toHaveBeenCalled();
  });
});
