# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
pnpm test                          # vitest run
pnpm vitest run -t 'handle JSON response'   # single test by name
pnpm build                         # smartbundle (reads package.json "exports": ./src/index.ts)
pnpm lint                          # biome check --write ./src (lint + organize imports)
pnpm format                        # biome format --write ./src
```

## Architecture

Three files in `src/`, all re-exported via `index.ts`; tests live in `src/tests/`.

`client.ts` — `createHttpClient(config)` returns `{ request, get, head, delete, post, put, patch }`,
all `ResultAsync<HttpResponse<T>, HttpError>` (neverthrow), never throwing. `get`/`head`/`delete` take
`Omit<Init, 'method' | 'data' | 'body'>`; the rest `Omit<Init, 'method'>`.

Shape: `prepare → loop { onAttempt, fetch } → settle → onSettled`.

- `prepare` builds url and init **once**, before the loop, and everything that can throw lives there
  (URL + `query` merge, `JSON.stringify(data)`, timeout validation), coming back as
  `err(reason: 'config')` — that is what makes "never throws" hold. No ctx exists yet, so a `'config'`
  error fires no hook at all.
- `RequestContext` is one object per *logical* call: survives retries, threaded into every hook, its
  scalars landing on every error via `httpErrorFrom`. `ctx.init` is deliberately shared mutable state
  across attempts — what `onAttempt` writes persists. `ctx.url` is observability only; `ctx.href`
  (snapshotted in `prepare`) is what fetch gets *and* what errors report, so mutating `ctx.url` moves
  neither.
- `wrapBodyMethods` proxies the native `Response` so body methods return `ResultAsync`. Everything
  goes through `res` as receiver — `Reflect.apply(target, res, …)` (a25b72c) and
  `Reflect.get(target, prop, res)` with functions bound to `res` — or accessors like `status` / `ok` /
  `headers` blow up on the private `#state`.
- Retry: `retryOn(ctx, result)` / `retryDelay(ctx, result)` read `ctx.attempt` (0-based, the attempt
  that just failed); `retries` unset = none. `'abort'` breaks the loop before `retryOn` is consulted,
  so only `status | network | timeout` reach it. Defaults are `retryOnTransient` and a flat
  `() => 1000` — deliberately not `delayWith()`, which would turn a flat 1 s into 1/2/4 s.
- `timeout` is per attempt, and `attemptSignals(caller, ms)` runs **inside** the loop: a fired
  `AbortSignal.timeout` stays aborted forever, so hoisting it kills every retry instantly (a test
  catches it). Caller signal is `init.signal ?? config.signal`, per-call wins, never merged.
  `transportError` classifies from `signals.timeout?.aborted` → `signals.caller?.aborted` →
  `'network'`, never from `AbortSignal.any()`'s reason, which a caller can forge. `isValidTimeout`
  range-checks in `prepare` because `AbortSignal.timeout` throws a `RangeError` outside `0 … 2**32-1`,
  inside the loop where nothing maps errors.
- Plugins run in array order. `onSettled` fires exactly once per call that reached fetch, after
  `ctx.duration` is set (measured to response headers, not body read).
- Every hook goes through `runHook`: it never throws, and `undefined` back means "unusable, use the
  fallback", so `retryOn`/`retryDelay`/`requestId` fail closed for free. Hooks are **sync** — a
  returned thenable is adopted into `onHookError` and dropped, since its rejection would otherwise
  reach `unhandledRejection`. `onHookError` is unset by default; the library never writes to `console`.

`errors.ts` — `HttpClientError` plus the `createHttpError` factory (only sets fields
that are present) and `isHttpClientError` guard. Every error carries a required
`reason: HttpErrorReason` (`'status' | 'network' | 'timeout' | 'abort' | 'parse' | 'config'`) — it is
a required field on the factory input so no new error path can forget it.

`retry.ts` — `retryWhen` / `retryOnTransient` / `delayWith`, plus the `RetryOn` / `RetryDelay` types
`client.ts` uses for its config fields. Pure functions of `(ctx, result)`.

- One-way at runtime: `client.ts` imports the *value* `retryOnTransient`, while `retry.ts` imports only
  **types** from `client.ts` / `errors.ts`. Keep those `import type` or the cycle becomes real.
- `retryWhen({ reasons, statuses, predicate })` — fields OR-ed and short-circuited in that order, so
  `predicate` can only widen. `Ok` never retries, `retryWhen({})` never retries. `statuses` takes
  inclusive `[from, to]` ranges and matches `error.statusCode`, **not** `error.response.status`, which
  is only set for `reason: 'status'`. No and/not combinators on purpose.
- `delayWith` caps **before** it jitters (tested). A `Retry-After` value wins over the backoff and is
  never jittered — shortening it would retry before the server allowed — and is capped at
  `max ?? 60_000`. Both paths clamp to `2 ** 31 - 1`, past which `setTimeout` fires immediately.
- A delay helper must always return a number: `runHook` reads `undefined` as a failure and stops
  retrying.

## Tests

Split by concern in `src/tests/`: `request`, `response`, `errors`, `retry` (loop + the default
`retryOn`), `retry-helpers` (the builders, pure — no `MockAgent`), `context`, `plugins`, `hook-errors`,
`timeout`. The mock's `.delay(ms)` simulates a slow upstream.

`tests/helpers.ts` exports `baseUrl` and `setupMockAgent()` — call it once per file at module scope. It
installs a fresh undici `MockAgent` with `disableNetConnect()` in `beforeEach` (and
`vi.restoreAllMocks()` in `afterEach`) and returns `{ intercept }`, which still chains `.reply()` /
`.replyWithError()` / `.persist()`. Assert with `_unsafeUnwrap()` / `_unsafeUnwrapErr()`.

## Notes

- Node-only by design; the readme deliberately points users to openapi-fetch + fetch-retry as
  better-supported alternatives. Keep the scope small — don't grow the API beyond what's asked.
- `AbortSignal.any` puts a floor under the runtime: `engines` declares `node >= 20.3.0`.
- The timeout signal stays live after the response headers, so it also bounds the lazy body read —
  standard `fetch` behaviour, but it means a body pulled late enough fails with `reason: 'parse'`.
