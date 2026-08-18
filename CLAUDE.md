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

## Conventions

- **Comments** are fine, but short and to the point. Comment the "why" — an upstream quirk, a magic
  constant's origin, why the obvious alternative doesn't work. Never restate what the line already
  says (that a flag gates something, that a variable starts `null`); if the comment paraphrases the
  code, delete it. A comment longer than a line or two is only for a real hack or genuinely tricky
  logic — and that's itself a signal the code should be reworked. No section banners or step
  narration.
- **Function order**: main/public function first, then helpers in order of usage, so the file reads
  top-down.

**Errors are values on the inside too.** neverthrow is the public surface, so the internals use it
for the same reason rather than only at the boundary: a helper that can fail returns
`Result` / `ResultAsync` and the caller composes it. A `try` sitting in the middle of a happy path is
a smell — it is control flow standing in for a return type.

- A `try` belongs only at an *edge*, where a foreign API throws instead of returning: `new URL`,
  `JSON.stringify`, `Headers.set`. Wrap it in the smallest helper that can own the failure and return
  a `Result` — `toHeaders` and `prepare`'s three guards are the shape to copy.
- `Result.fromThrowable` / `ResultAsync.fromThrowable` / `fromPromise` exist for exactly that wrap;
  reach for them before hand-rolling `try/catch`.
- **`fromPromise` does not cover its own argument.** `fromPromise(f(x), mapErr)` evaluates `f(x)`
  first, so a synchronous throw there escapes the mapper, rejects the `ResultAsync` and breaks
  "never throws" for every caller using `.unwrapOr()`. `fetch()` itself never throws synchronously
  (it returns a rejected promise) — the risk is whatever you compute *into* its init object.
- Only errors that reach a caller need to be `HttpClientError` with a `reason`. An internal helper
  may return a looser `Result<T, unknown>` and let the call site classify it — `attempt` running
  `toHeaders`' error through `transportError` is the example.

## Architecture

Three files in `src/`, all re-exported via `index.ts`; tests live in `src/tests/`.

`client.ts` — `createHttpClient(config)` returns `{ request, get, head, delete, post, put, patch }`,
all `ResultAsync<HttpResponse<T>, HttpError>` (neverthrow), never throwing. `get`/`head`/`delete` take
`Omit<Init, 'method' | 'data' | 'body'>`; the rest `Omit<Init, 'method'>`.

Shape: `prepare → loop { onAttempt, fetch } → settle → onSettled`.

- `prepare` builds url and init **once**, before the loop, and everything that can throw lives there
  (URL + `query` merge, `JSON.stringify(data)`, timeout validation), coming back as
  `err(reason: 'config')` — that is what makes "never throws" hold. No ctx exists yet, so a `'config'`
  error carries `url` + `method` only and fires no hook at all.
- Headers are normalized in two stages: `toHeaderRecord` flattens every `HeadersInit` shape to a
  lowercase `Record<string, string>` in `prepare` (so client and call defaults *override* instead of
  comma-joining), and `toHeaders` collapses the record back into `Headers` at fetch time — that
  second pass is what makes a plugin's `ctx.init.headers.Authorization` win over a lowercase default.
- `data` is serialized when it is not `undefined` (`data: 0` sends `"0"`) and defaults
  `content-type: application/json` only when the caller set none. `query` is applied onto
  `targetUrl.searchParams`: `null`/`undefined` values are skipped, arrays `append` one param each,
  everything else `set`s — `Init['query']` is typed to keep nested objects out at compile time.
- `RequestContext` is one object per *logical* call: survives retries, threaded into every hook, its
  scalars landing on every error via `httpErrorFrom`. `ctx.init` is deliberately shared mutable state
  across attempts — what `onAttempt` writes persists, and `ctx.init.headers` is a plain, always
  present, lowercase-keyed record. `ctx.url` is observability only; `ctx.href`
  (snapshotted in `prepare`) is what fetch gets *and* what errors report, so mutating `ctx.url` moves
  neither.
- `wrapBodyMethods` proxies the native `Response` so body methods return `ResultAsync`. Everything
  goes through `res` as receiver — `Reflect.apply(target, res, …)` (a25b72c) and
  `Reflect.get(target, prop, res)` with functions bound to `res` — or accessors like `status` / `ok` /
  `headers` blow up on the private `#state`.
- Retry: `retryOn(ctx, result)` / `retryDelay(ctx, result)` read `ctx.attempt` (0-based, the attempt
  that just failed); `retries` unset = none, and a non-integer/negative/`NaN` `retries` degrades to
  unset rather than adding an error path. `'abort'` breaks the loop before `retryOn` is consulted,
  so only `status | network | timeout` reach it. Defaults are `retryOnTransient` and a flat
  `() => 1000` — deliberately not `delayWith()`, which would turn a flat 1 s into 1/2/4 s.
  `retryOn` is also **not** consulted on the final attempt or when `retries` is unset: the answer is
  already decided, so a side-effecting predicate under-counts. Deliberate.
- Before sleeping, the retried-away response is drained (`drainBody`) by *reading* it: `cancel()` up
  front kills the keep-alive socket. A 1 s ceiling bounds the read, and only there is the reader
  cancelled. The terminal error's `response` is left unread for the caller. `sleep(ms, signal)` also
  resolves on abort, and an abort during the backoff settles as `reason: 'abort'` instead of the
  stale upstream failure.
- `timeout` is per attempt, and `attemptSignals(caller, ms)` runs **inside** the loop: a fired
  `AbortSignal.timeout` stays aborted forever, so hoisting it kills every retry instantly (a test
  catches it). Caller signal is `init.signal ?? config.signal`, per-call wins, never merged.
  A per-call `signal: null` opts out of the client-level one, and anything that is not an
  `AbortSignal` (the `controller`-instead-of-`controller.signal` slip) is ignored — `AbortSignal.any()`
  would throw on it. `transportError` classifies from `signals.timeout?.aborted` →
  `signals.caller?.aborted` → a fallback reason, never from `AbortSignal.any()`'s reason, which a
  caller can forge; `wrapBodyMethods` reuses it with a `'parse'` fallback, so a late body read is
  labelled by what actually aborted it. `isValidTimeout` range-checks in `prepare` because
  `AbortSignal.timeout` throws a `RangeError` above `2**32-1` — and the bound is the tighter
  `2**31-1`, past which Node's timer overflows and aborts after 1 ms.
- Plugins run in array order. `onSettled` fires exactly once per call that reached fetch, after
  `ctx.duration` is set (measured to response headers, not body read).
- Every hook goes through `runHook`: it never throws, and `undefined` back means "unusable, use the
  fallback", so `retryOn`/`retryDelay`/`requestId` fail closed for free. Because `undefined` conflates
  "threw" / "was async" / "returned undefined", the two retry call sites type-check the value as well
  and report anything off-shape to `onHookError` before falling back. Hooks are **sync** — a returned
  thenable is caught *inside* the `try` (a throwing `then` getter is a hook failure too) and adopted
  into `onHookError`, since its rejection would otherwise reach `unhandledRejection`. Plugins are
  called as methods (`plugin.onAttempt(ctx)`), so a class- or object-based plugin keeps its `this`.
  `onHookError` is unset by default; the library never writes to `console`.

`errors.ts` — `HttpClientError` plus the `createHttpError` factory (only sets fields
that are present) and `isHttpClientError` guard. Every error carries a required
`reason: HttpErrorReason` (`'status' | 'network' | 'timeout' | 'abort' | 'parse' | 'config'`) — it is
a required field on the factory input so no new error path can forget it.

- The optional fields are plain declarations, kept off the instance by `useDefineForClassFields: false`
  in `tsconfig.json` — `target: ESNext` implies it otherwise, and each field would then be emitted as
  an own enumerable `undefined`, making the factory's "only what is set" pointless. Do not drop that
  flag as redundant. The factory's guards are `!= null`, so a real `status: 0` or an empty
  `statusText` survives.

`retry.ts` — `retryWhen` / `retryOnTransient` / `delayWith`, plus the `RetryOn` / `RetryDelay` types
`client.ts` uses for its config fields. Pure functions of `(ctx, result)`.

- One-way at runtime: `client.ts` imports the *value* `retryOnTransient`, while `retry.ts` imports only
  **types** from `client.ts` / `errors.ts`. Keep those `import type` or the cycle becomes real.
- `retryWhen({ reasons, statuses, predicate })` — fields OR-ed and short-circuited in that order, so
  `predicate` can only widen. `Ok` never retries, `retryWhen({})` never retries. `statuses` takes
  inclusive `[from, to]` ranges and matches `error.statusCode ?? error.response?.status`. No and/not
  combinators on purpose.
- `delayWith` caps **before** it jitters (tested). A `Retry-After` value wins over the backoff and is
  never jittered — shortening it would retry before the server allowed. Its ceiling is its own:
  `retryAfter: true` → 60 s, `retryAfter: { max }` → `max`; the backoff `max` does not touch it, or a
  `max: 30_000` would retry 30 s into an hour-long ban window. Both paths clamp to `2 ** 31 - 1`, past
  which `setTimeout` fires immediately, and `clampDelay` maps `NaN`/`-Infinity` to `0` — a hang is
  worse than a fast retry.
- `Retry-After` dates are matched against the three RFC 9110 formats before `Date.parse` sees them:
  V8 reads `1.5` as a 2001 date, i.e. a 0 ms delay against an endpoint that just rate-limited you.
  Anything unrecognized returns `null` and falls through to the backoff.
- A delay helper must always return a number: `runHook` reads `undefined` as a failure and stops
  retrying.

## Tests

Split by concern in `src/tests/`: `request`, `response`, `errors`, `retry` (loop + the default
`retryOn`), `retry-helpers` (the builders, pure — no `MockAgent`), `context`, `plugins`, `hook-errors`,
`timeout`, `drain` (a real loopback server — `MockAgent` cannot stream a body). The mock's `.delay(ms)` simulates a slow upstream.

`tests/helpers.ts` exports `baseUrl` and `setupMockAgent()` — call it once per file at module scope. It
installs a fresh undici `MockAgent` with `disableNetConnect()` in `beforeEach`, and in `afterEach`
restores mocks, calls `assertNoPendingInterceptors()` and closes the agent. That assertion is the net
under "the client skipped a fetch entirely", so a test that never reaches the network (a `'config'`
error) must register no interceptor. It returns `{ intercept }`, which still chains `.reply()` /
`.replyWithError()` / `.persist()`. Assert with `_unsafeUnwrap()` / `_unsafeUnwrapErr()`.

## Notes

- Node-only by design; the readme deliberately points users to openapi-fetch + fetch-retry as
  better-supported alternatives. Keep the scope small — don't grow the API beyond what's asked.
- `AbortSignal.any` puts a floor under the runtime: `engines` declares `node >= 20.3.0`.
- The timeout signal stays live after the response headers, so it also bounds the lazy body read —
  standard `fetch` behaviour, but it means a body pulled late enough fails with `reason: 'timeout'`
  (or `'abort'`); `'parse'` is only the fallback for a genuine decode failure.
