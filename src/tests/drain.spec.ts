import http from 'node:http';
import type { Socket } from 'node:net';
import { expect, test, vi } from 'vitest';

import { createHttpClient } from '../client';

/** `MockAgent` cannot stream, so the endless body needs a real loopback server. */
test('a body that never ends does not stall the retry loop', async () => {
  const sockets: Socket[] = [];
  const server = http.createServer((_req, res) => {
    res.writeHead(503, { 'content-type': 'text/plain' });
    // Headers and a first chunk, then silence: fetch resolves, the body never completes.
    res.write('x'.repeat(1024));
  });
  server.on('connection', (socket) => sockets.push(socket));

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };

  const onAttempt = vi.fn();
  const client = createHttpClient({
    baseUrl: `http://127.0.0.1:${port}`,
    retries: 2,
    retryDelay: () => 0,
    plugins: [{ onAttempt }],
  });

  const started = performance.now();
  const error = (await client.get('/data'))._unsafeUnwrapErr();
  const elapsed = performance.now() - started;

  for (const socket of sockets) {
    socket.destroy();
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));

  expect(error.statusCode).toBe(503);
  // The second attempt ran: the drain gave up rather than waiting on the body.
  expect(onAttempt).toHaveBeenCalledTimes(2);
  expect(elapsed).toBeLessThan(4000);
}, 10_000);

test('a caller abort while draining settles as a Result', async () => {
  const sockets: Socket[] = [];
  const server = http.createServer((_req, res) => {
    res.writeHead(503, { 'content-type': 'text/plain' });
    res.write('x'.repeat(1024));
  });
  server.on('connection', (socket) => sockets.push(socket));

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };

  const controller = new AbortController();
  const client = createHttpClient({
    baseUrl: `http://127.0.0.1:${port}`,
    retries: 2,
    retryDelay: () => 0,
    signal: controller.signal,
  });

  // Mid-drain: the pending read rejects rather than completing.
  setTimeout(() => controller.abort(), 100);
  const result = await client.get('/data');

  for (const socket of sockets) {
    socket.destroy();
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));

  expect(result.isErr()).toBe(true);
}, 10_000);
