import { describe, expect, test } from 'vitest';

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
