import { expect, test, vi } from 'vitest';

import { createHttpClient } from '../client';
import { baseUrl, setupMockAgent } from './helpers';

const agent = setupMockAgent();

/** Aborts once the request is in flight, so the abort is not classified before fetch starts. */
function abortSoon(controller: AbortController, reason?: unknown) {
  setTimeout(() => controller.abort(reason), 10);
}

test('a timed-out attempt is retried and the retry reaches the network', async () => {
  const onAttempt = vi.fn();
  const client = createHttpClient({
    baseUrl,
    timeout: 30,
    retries: 2,
    retryDelay: () => 0,
    plugins: [{ onAttempt }],
  });

  agent.intercept({ method: 'GET', path: '/data' }).reply(200, { message: 'slow' }).delay(300);
  agent.intercept({ method: 'GET', path: '/data' }).reply(200, { message: 'fast' });

  const res = (await client.get<{ message: string }>('/data'))._unsafeUnwrap();
  const body = (await res.json())._unsafeUnwrap();

  // The second attempt is not instantly killed by attempt one's already-fired timeout.
  expect(onAttempt).toHaveBeenCalledTimes(2);
  expect(body).toEqual({ message: 'fast' });
});

test('a timeout error carries the ctx scalars', async () => {
  const client = createHttpClient({ baseUrl, timeout: 30, requestId: () => 'req-1' });

  agent.intercept({ method: 'GET', path: '/data' }).reply(200, {}).delay(300);

  const error = (await client.get('/data'))._unsafeUnwrapErr();

  expect(error.reason).toBe('timeout');
  expect(error.message).toBe('Request timed out after 30ms');
  expect(error.url).toBe(`${baseUrl}/data`);
  expect(error.method).toBe('GET');
  expect(error.attempt).toBe(0);
  expect(error.requestId).toBe('req-1');
});

test('a per-call timeout overrides the client-level one', async () => {
  const client = createHttpClient({ baseUrl, timeout: 300 });

  agent.intercept({ method: 'GET', path: '/data' }).reply(200, {}).delay(300);

  const error = (await client.get('/data', { timeout: 30 }))._unsafeUnwrapErr();

  expect(error.reason).toBe('timeout');
  expect(error.message).toBe('Request timed out after 30ms');
});

test('a caller abort is not retried, even with retryOn: () => true', async () => {
  const onAttempt = vi.fn();
  const controller = new AbortController();
  const client = createHttpClient({
    baseUrl,
    retries: 3,
    retryDelay: () => 0,
    retryOn: () => true,
    plugins: [{ onAttempt }],
  });

  agent.intercept({ method: 'GET', path: '/data' }).reply(200, {}).delay(300).persist();

  abortSoon(controller);
  const error = (await client.get('/data', { signal: controller.signal }))._unsafeUnwrapErr();

  expect(error.reason).toBe('abort');
  expect(onAttempt).toHaveBeenCalledTimes(1);
});

test('a caller aborting with a TimeoutError reason is still an abort', async () => {
  const controller = new AbortController();
  const client = createHttpClient({ baseUrl, timeout: 300 });

  agent.intercept({ method: 'GET', path: '/data' }).reply(200, {}).delay(300);

  abortSoon(controller, new DOMException('too slow', 'TimeoutError'));
  const error = (await client.get('/data', { signal: controller.signal }))._unsafeUnwrapErr();

  expect(error.reason).toBe('abort');
});

test('a client-level signal aborts the call', async () => {
  const controller = new AbortController();
  const client = createHttpClient({ baseUrl, signal: controller.signal });

  agent.intercept({ method: 'GET', path: '/data' }).reply(200, {}).delay(300);

  abortSoon(controller);
  const error = (await client.get('/data'))._unsafeUnwrapErr();

  expect(error.reason).toBe('abort');
});

test('a per-call signal replaces the client-level one instead of merging with it', async () => {
  const clientController = new AbortController();
  const callController = new AbortController();
  const client = createHttpClient({ baseUrl, signal: clientController.signal });

  agent.intercept({ method: 'GET', path: '/data' }).reply(200, { message: 'ok' }).delay(50);

  // The client-level signal fires; the call only listens to its own.
  abortSoon(clientController);
  const result = await client.get('/data', { signal: callController.signal });

  expect(result.isOk()).toBe(true);
});

test.each([
  ['negative', -1],
  ['fractional', 1.5],
  ['NaN', Number.NaN],
  ['infinite', Number.POSITIVE_INFINITY],
  ['out of range', 2 ** 32],
  // Accepted by AbortSignal.timeout, but Node's timer overflows and aborts after 1ms.
  ['past the timer range', 2 ** 31],
])('an %s timeout is a config error instead of a throw', async (_label, timeout) => {
  const onAttempt = vi.fn();
  const client = createHttpClient({ baseUrl, plugins: [{ onAttempt }] });

  agent.intercept({ method: 'GET', path: '/data' }).reply(200, {}).persist();

  const error = (await client.get('/data', { timeout }))._unsafeUnwrapErr();

  expect(error.reason).toBe('config');
  expect(error.message).toContain('Invalid timeout');
  // A 'config' error never reaches the fetch stage, so no hook fires.
  expect(onAttempt).not.toHaveBeenCalled();
});

test('an invalid client-level timeout is a config error', async () => {
  const client = createHttpClient({ baseUrl, timeout: -1 });

  agent.intercept({ method: 'GET', path: '/data' }).reply(200, {});

  const error = (await client.get('/data'))._unsafeUnwrapErr();

  expect(error.reason).toBe('config');
});

test('a valid per-call timeout overrides an invalid client-level one', async () => {
  const client = createHttpClient({ baseUrl, timeout: -1 });

  agent.intercept({ method: 'GET', path: '/data' }).reply(200, { message: 'ok' });

  const result = await client.get('/data', { timeout: 300 });

  expect(result.isOk()).toBe(true);
});

test('timeout: 0 is valid and aborts immediately', async () => {
  const client = createHttpClient({ baseUrl, timeout: 0 });

  agent.intercept({ method: 'GET', path: '/data' }).reply(200, {}).delay(50);

  const error = (await client.get('/data'))._unsafeUnwrapErr();

  expect(error.reason).toBe('timeout');
});

test('a signal that is not an AbortSignal is ignored instead of throwing', async () => {
  const controller = new AbortController();
  const client = createHttpClient({ baseUrl, timeout: 300 });

  agent.intercept({ method: 'GET', path: '/data' }).reply(200, { message: 'ok' });

  // The classic slip: the controller instead of its signal. AbortSignal.any() would throw on it.
  const result = await client.get('/data', { signal: controller as unknown as AbortSignal });

  expect(result.isOk()).toBe(true);
});

test('a per-call signal: null opts out of the client-level signal', async () => {
  const controller = new AbortController();
  const client = createHttpClient({ baseUrl, signal: controller.signal });

  agent.intercept({ method: 'GET', path: '/data' }).reply(200, { message: 'ok' }).delay(50);

  abortSoon(controller);
  const result = await client.get('/data', { signal: null });

  expect(result.isOk()).toBe(true);
});

test('a per-call signal: undefined still inherits the client-level signal', async () => {
  const controller = new AbortController();
  const client = createHttpClient({ baseUrl, signal: controller.signal });

  agent.intercept({ method: 'GET', path: '/data' }).reply(200, {}).delay(300);

  // How a forwarded optional signal arrives: `{ signal: options.signal }`.
  abortSoon(controller);
  const error = (await client.get('/data', { signal: undefined }))._unsafeUnwrapErr();

  expect(error.reason).toBe('abort');
});
