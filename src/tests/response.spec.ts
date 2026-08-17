import { expect, test } from 'vitest';

import { createHttpClient } from '../client';
import { baseUrl, setupMockAgent } from './helpers';

const agent = setupMockAgent();

test('handle JSON response', async () => {
  const client = createHttpClient({ baseUrl });

  agent
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
    .intercept({ method: 'GET', path: '/data' })
    .reply(200, 'message: Success', { headers: { 'Content-Type': 'application/json' } });

  const result = await client.request('/data', { method: 'GET' }).andThen((r) => r.json());

  expect(result.isErr()).toBe(true);

  expect((result._unsafeUnwrapErr().cause as any).name).toBe('SyntaxError');
});

test('handle non-JSON response', async () => {
  const client = createHttpClient({ baseUrl });

  agent
    .intercept({ method: 'GET', path: '/data' })
    .reply(200, 'plain text', { headers: { 'Content-Type': 'text/plain' } });

  const result = (
    await client.request('/data', { method: 'GET' }).andThen((r) => r.text())
  )._unsafeUnwrap();

  expect(result).toBe('plain text');
});
