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

Two files in `src/`, both re-exported via `index.ts`; tests live in `src/tests/`.

`client.ts` — `createHttpClient(config)` returns
`{ request, get, head, delete, post, put, patch }`. Everything returns
`ResultAsync<HttpResponse<T>, HttpError>` (neverthrow), never throws. `get`/`head`/`delete` take
`Omit<Init, 'method' | 'data' | 'body'>`; `post`/`put`/`patch` take `Omit<Init, 'method'>`.

- `prepare()` merges init with default config, builds the URL (`baseUrl + url`, `query` merged into
  the existing search params) and sets `body` from `data` via `JSON.stringify`; `attempt()` runs the
  fetch and maps non-2xx responses to an `errAsync(HttpClientError)`.
- URL construction / the `query` merge and `JSON.stringify(data)` are each in a `try/catch` that
  returns `errAsync(reason: 'config')` — that is what makes "never throws" actually hold.
- `wrapBodyMethods` returns a `Proxy` over the native `Response` so `json/text/blob/formData/
  arrayBuffer` return `ResultAsync` instead of a promise. Everything goes through `res` as receiver —
  body methods via `Reflect.apply(target, res, …)` (commit a25b72c), and every other property via
  `Reflect.get(target, prop, res)` with function values bound to `res`, so accessors like `status` /
  `ok` / `headers` don't blow up on private `#state`.
- The shape is `prepare(ctx) → loop { onAttempt, fetch } → settle → onSettled`. `prepare` builds the
  url and init **once**, before the loop; everything that can throw lives there and comes back as
  `err(reason: 'config')` — no ctx exists yet, so a `'config'` error fires no hook at all.
- `RequestContext` is one object per *logical* call: it survives retries, is threaded into every
  hook, and its scalars land on every error via `httpErrorFrom`. `ctx.init` is deliberately shared
  mutable state across attempts — what `onAttempt` writes persists. `ctx.url` is observability
  only: `ctx.href` (snapshotted in `prepare`) is what fetch is given *and* what errors report, so a
  hook mutating `ctx.url` can move neither the request nor the error metadata.
- Retry: `retryOn(ctx, result)` / `retryDelay(ctx, result)` read `ctx.attempt` (0-based, the attempt
  that just failed). `retries` unset = no retries. `retryOnStatus` / `retryDelayExp2` are the
  built-in helpers. `reason: 'abort'` breaks the loop before `retryOn` is consulted.
- `timeout` is per attempt. `attemptSignals(caller, ms)` is called **inside** the loop — a fired
  `AbortSignal.timeout` stays aborted forever, so hoisting it would kill every retry instantly (there
  is a test that fails if you do). The effective caller signal is `init.signal ?? config.signal`,
  resolved in `prepare`, per-call wins, never merged. `transportError` classifies from
  `signals.timeout?.aborted` → `'timeout'`, then `signals.caller?.aborted` → `'abort'`, else
  `'network'` — never from `AbortSignal.any()`'s reason, which a caller can forge. The effective
  timeout is validated in `prepare` (`isValidTimeout`: integer, `0 … 2**32-1`) and returns
  `err(reason: 'config')` — `AbortSignal.timeout` throws a `RangeError` outside that range, and it
  runs inside the loop, outside any error mapping.
- Plugins (`onAttempt` / `onSettled`) run in array order. `onSettled` fires exactly once per call
  that reached the fetch stage, after `ctx.duration` is set (measured to response headers, not to
  body read). A throwing hook goes to `onHookError` and never fails the request; `onHookError` is
  unset by default, and the library never writes to `console` on its own.
- Every hook goes through one function, `runHook(hook, plugin, call)`: it never throws, and
  `undefined` back means "unusable, use the fallback" — so `retryOn`/`retryDelay`/`requestId` fail
  closed for free. Hooks are **sync**; `() => void` also accepts an `async` one, whose rejection
  would reach `unhandledRejection` and kill the process, so a returned thenable is adopted into
  `onHookError` and its value dropped.

`errors.ts` — `HttpClientError` plus the `createHttpError` factory (only sets fields
that are present) and `isHttpClientError` guard. Every error carries a required
`reason: HttpErrorReason` (`'status' | 'network' | 'timeout' | 'abort' | 'parse' | 'config'`) — it is
a required field on the factory input so no new error path can forget it.

## Tests

Tests live in `src/tests/`, split by concern: `request` (methods, init merge), `response` (body
methods / proxy), `errors` (reasons, never-throws), `retry`, `context` (`ctx` + `requestId`),
`plugins`, `hook-errors`, `timeout` (timeout + signal). The mock's `.delay(ms)` is how a slow
upstream is simulated.

`tests/helpers.ts` exports `baseUrl` and `setupMockAgent()` — call it once per file at module
scope. It installs a fresh undici `MockAgent` + `setGlobalDispatcher` with `disableNetConnect()` in
`beforeEach` (and `vi.restoreAllMocks()` in `afterEach`), and returns `{ intercept }`, a shortcut
for `agent.get(baseUrl).intercept(...)` that still chains `.reply()` / `.replyWithError()` /
`.persist()`. Use `_unsafeUnwrapErr()` / `_unsafeUnwrap()` to assert on results.

## Notes

- Node-only by design; the readme deliberately points users to openapi-fetch + fetch-retry as
  better-supported alternatives. Keep the scope small — don't grow the API beyond what's asked.
- `AbortSignal.any` puts a floor under the runtime: `engines` declares `node >= 20.3.0`.
- The timeout signal stays live after the response headers, so it also bounds the lazy body read —
  standard `fetch` behaviour, but it means a body pulled late enough fails with `reason: 'parse'`.
