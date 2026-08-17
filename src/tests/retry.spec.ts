import { describe, expect, test, vi } from 'vitest';

import { createHttpClient, type RequestContext, retryDelayExp2 } from '../client';
import { baseUrl, setupMockAgent } from './helpers';

const agent = setupMockAgent();

test('retry failed requests according to retry options', async () => {
  const client = createHttpClient({ baseUrl, retries: 3, retryDelay: () => 10 });

  agent.intercept({ method: 'GET', path: '/data' }).replyWithError(new Error('Request failed'));
  agent.intercept({ method: 'GET', path: '/data' }).replyWithError(new Error('Request failed'));
  agent.intercept({ method: 'GET', path: '/data' }).reply(200, { message: 'Success' });

  const result = await client.request('/data', {
    method: 'GET',
  });

  expect(result.isOk()).toBe(true);
});

describe('retry helpers', () => {
  test('retryDelayExp2 waits startDelay before the first retry', async () => {
    const exp2 = retryDelayExp2(200);
    // `ctx` is one mutable object, so record `attempt` at call time, not by reference.
    const attempts: number[] = [];
    const delays: number[] = [];
    const retryDelay: typeof exp2 = (ctx, result) => {
      attempts.push(ctx.attempt);
      const delay = exp2(ctx, result);
      delays.push(delay);
      return delay;
    };
    const client = createHttpClient({ baseUrl, retries: 3, retryDelay });

    for (let i = 0; i < 3; i++) {
      agent.intercept({ method: 'GET', path: '/data' }).replyWithError(new Error('Request failed'));
    }

    const started = performance.now();
    await client.get('/data');
    const elapsed = performance.now() - started;

    expect(attempts).toEqual([0, 1]);
    expect(delays).toEqual([200, 400]);
    // 200 + 400, not the 0.1 behaviour of 400 + 800.
    expect(elapsed).toBeGreaterThanOrEqual(600);
    expect(elapsed).toBeLessThan(1000);
  });

  test('retryOn receives the ctx', async () => {
    const retryOn = vi.fn(() => false);
    const client = createHttpClient({ baseUrl, retries: 3, retryOn });

    agent.intercept({ method: 'GET', path: '/data' }).reply(500, 'nope');

    await client.get('/data');

    expect(retryOn).toHaveBeenCalledTimes(1);
    const [ctx] = retryOn.mock.calls[0] as unknown as [RequestContext];
    expect(ctx.attempt).toBe(0);
    expect(ctx.url.href).toBe(`${baseUrl}/data`);
    expect(ctx.method).toBe('GET');
  });
});
