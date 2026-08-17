# Changelog

## 0.2.0

**Breaking**

- `interceptRequest` / `inspectResponse` / `inspectError` are gone — use `plugins: [{ onAttempt, onSettled }]`.
- `retryOn` / `retryDelay` now take `(ctx, result)` and read the 0-based `ctx.attempt`, so every delay
  fires one step earlier than in 0.1 (`retryDelayExp2(200)` waits 200 ms before the first retry).
- `HttpClientError` carries a required `reason` and no longer has `request`.

**Added**

- `put`, `patch`, `delete`, `head`.
- Plugins with `onAttempt` / `onSettled`, plus `onHookError` for hook failures.
- `RequestContext`: `id`, `url`, `method`, `attempt`, `duration`, shared mutable `init`.
- Per-attempt `timeout` and caller `signal`, at client and call level.
- `requestId` per call and a client-level generator.

**Fixed**

- Bad urls, unserializable `data` and invalid `timeout` return `err(reason: 'config')` instead of
  throwing — "never throws" now holds.

## 0.1.1

Initial release: `request`/`get`/`post`, retries, callbacks, neverthrow results.
