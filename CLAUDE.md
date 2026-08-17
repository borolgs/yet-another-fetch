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

Three files in `src/`, all exported via `index.ts`.

`http-client.ts` — `createHttpClient(config)` returns
`{ request, get, head, delete, post, put, patch }`. Everything returns
`ResultAsync<HttpResponse<T>, HttpError>` (neverthrow), never throws. `get`/`head`/`delete` take
`Omit<Init, 'method' | 'data' | 'body'>`; `post`/`put`/`patch` take `Omit<Init, 'method'>`.

- `request()` merges init with default config, builds the URL (`baseUrl + url`, `query` merged into
  the existing search params), sets `body` from `data` via `JSON.stringify`, and maps non-2xx
  responses to an `errAsync(HttpClientError)`.
- URL construction / the `query` merge and `JSON.stringify(data)` are each in a `try/catch` that
  returns `errAsync(reason: 'config')` — that is what makes "never throws" actually hold.
- `wrapBodyMethods` returns a `Proxy` over the native `Response` so `json/text/blob/formData/
  arrayBuffer` return `ResultAsync` instead of a promise. Everything goes through `res` as receiver —
  body methods via `Reflect.apply(target, res, …)` (commit a25b72c), and every other property via
  `Reflect.get(target, prop, res)` with function values bound to `res`, so accessors like `status` /
  `ok` / `headers` don't blow up on private `#state`.
- Retry lives in `_requestWithRetry`: a do/while loop calling `retryOn(attempt, result)` and
  sleeping `retryDelay(attempt, result)`. `retries` unset = no retries. `retryOnStatus` /
  `retryDelayExp2` are the built-in helpers.
- Callbacks: `interceptRequest` mutates the outgoing init in place; `inspectResponse` /
  `inspectError` are side-effect-only.

`http-client.errors.ts` — `HttpClientError` plus the `createHttpError` factory (only sets fields
that are present) and `isHttpClientError` guard. Every error carries a required
`reason: HttpErrorReason` (`'status' | 'network' | 'timeout' | 'abort' | 'parse' | 'config'`) — it is
a required field on the factory input so no new error path can forget it.

## Tests

`http-client.spec.ts` mocks the network with undici's `MockAgent` + `setGlobalDispatcher`, with
`disableNetConnect()`. Use `_unsafeUnwrapErr()` / `_unsafeUnwrap()` to assert on results.

## Notes

- Node-only by design; the readme deliberately points users to openapi-fetch + fetch-retry as
  better-supported alternatives. Keep the scope small — don't grow the API beyond what's asked.
- `timeout` and `AbortSignal` handling do not exist yet, so the `'timeout'` / `'abort'` reasons are
  declared but never produced. Stage 3 fills them in.
