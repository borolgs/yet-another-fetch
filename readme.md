# Yet another fetch

An HTTP client with retry functionality, plugins, and error handling using [neverthrow](https://github.com/supermacro/neverthrow).

It utilizes the fetch API under the hood and provides an API similar to fetch with additional options.

> [!IMPORTANT]  
> **Only for Node.js!**  
> It's assumed that for the frontend, it's better to use specialized solutions like [Tanstack Query](https://tanstack.com/query/latest) or [Farfetched](https://ff.effector.dev/).

## Usage

```bash
pnpm i yet-another-fetch
```

```ts
import { createHttpClient, retryOnStatus, retryDelayExp2 } from 'yet-another-fetch';

const client = createHttpClient({
  baseUrl: 'https://example.com',
  retries: 3,
  retryDelay: retryDelayExp2(1000), // or (ctx) => 2 ** ctx.attempt * 1000
  retryOn: retryOnStatus([401, 500]),
  plugins: [
    {
      name: 'logger',
      onSettled(ctx, result) {
        log.info({
          requestId: ctx.id,
          method: ctx.method,
          url: ctx.url.href,
          attempts: ctx.attempt + 1,
          duration: ctx.duration,
          status: result.match(
            (res) => res.status,
            (err) => err.statusCode,
          ),
        });
      },
    },
  ],
});

const { message } = await client
  .get<{ message: string }>('/data')
  .andThen((res) => res.json())
  .unwrapOr({ message: 'hello' });
```

`createHttpClient` returns `{ request, get, head, delete, post, put, patch }`. Every method returns a
`ResultAsync<HttpResponse<T>, HttpError>` and **never throws** — including on a malformed URL or
unserializable `data`. `get`/`head`/`delete` take `Omit<Init, 'method' | 'data' | 'body'>`;
`post`/`put`/`patch` take `Omit<Init, 'method'>`.

`Init` is a `RequestInit` plus `data` (JSON-serialized into the body), `query` (merged into the URL's
search params) and `requestId`.

The response is a proxy over the native `Response`: `json`/`text`/`blob`/`formData`/`arrayBuffer`
return a `ResultAsync` instead of a promise, everything else (`status`, `ok`, `headers`, …) behaves
as usual.

## Plugins

A plugin is a plain object with two optional hooks. Plugins run in array order.

| hook | fires | job |
| --- | --- | --- |
| `onAttempt(ctx)` | before every attempt | **mutate** `ctx.init` — the only hook that changes the request |
| `onSettled(ctx, result)` | **once per logical call** | observe the final `Result` |

```ts
const auth = {
  name: 'auth',
  onAttempt(ctx) {
    // runs again before each retry, so it always reads the current token
    ctx.init.headers = { ...ctx.init.headers, authorization: `Bearer ${tokens.current()}` };
  },
};
```

**`onSettled` fires exactly once for every call that reaches the fetch stage.** Retries do not
multiply it: three attempts produce three `onAttempt` calls and one `onSettled` with
`ctx.attempt === 2`. The documented exception is `reason: 'config'` — those failures happen while the
context is still being built, so there is no `ctx` to hand a plugin and **no hook fires at all**.
`reason: 'parse'` is the other blind spot: body reads are lazy, so a parse failure happens long after
`onSettled` has already fired.

**`onSettled` must not consume the body.** On the ok branch the result carries the very response the
caller is about to read; on the err branch the same `Response` hangs off `err.response`. Use
`res.clone()` if you need the body — and pay for it. The status needs no body access: `res.status` on
the ok branch, `err.statusCode` on the err one.

**Hooks are synchronous.** An `async` hook cannot be awaited by the client, so `onAttempt` cannot
refresh a token before retrying — something else has to refresh it out of band and the hook reads the
current value. A hook that returns a promise is reported to `onHookError` and its value dropped.

**`ctx.init` is shared across attempts of one call**, which is what makes the example above work. It
also means an appending mutation (`headers['x-trace'] += …`) accumulates over retries. Mutations do
not leak between separate calls.

### Failing hooks

A throwing plugin is reported and **never** fails the request:

```ts
createHttpClient({
  onHookError(err, { hook, plugin }) {
    log.error({ err, hook, plugin }, 'http client hook failed');
  },
});
```

`hook` is one of `'onAttempt' | 'onSettled' | 'retryOn' | 'retryDelay' | 'requestId'`. There is **no
default**: with `onHookError` unset, hook errors are swallowed silently and the library never writes
to `console` on its own — so hook bugs are invisible until you wire it up. `onHookError` throwing is
swallowed too; it is the end of the reporting chain.

It is a *bug* channel, not a *traffic* one: hook failures never appear in `onSettled`'s err branch, so
a metrics plugin can trust that everything it sees is real upstream behaviour. Hooks that return a
value fail closed — a throwing `retryOn`/`retryDelay` stops retrying and returns the last result, and
a throwing `requestId` falls back to `crypto.randomUUID()`.

## Request context

One object per **logical** call, shared across its attempts and threaded into every hook.

| field | |
| --- | --- |
| `id` | correlation id — `Init['requestId']`, else the client-level `requestId()`, else `crypto.randomUUID()` |
| `url` | the final `URL` (baseUrl + path + merged query). **Observability only** — mutating it moves nothing |
| `method` | the HTTP method |
| `attempt` | 0-based index of the attempt in flight |
| `startedAt` | `performance.now()` when the call started |
| `duration` | `0` until `onSettled`; measured to response headers, **not** to the body read, and includes retry delays |
| `init` | the fetch-ready init — **mutate this in `onAttempt`** |

To carry data from `onAttempt` to `onSettled`, keep a `WeakMap` keyed on `ctx` inside your plugin's
closure.

## Errors

Every failure is an `HttpClientError` (`isHttpClientError` is exported as a guard) carrying a
`reason` plus log-friendly scalars:

```ts
class HttpClientError extends Error {
  reason: 'status' | 'network' | 'timeout' | 'abort' | 'parse' | 'config';
  url?: string;
  method?: string;
  attempt?: number;
  requestId?: string;
  status?: string;
  statusCode?: number;
  response?: Response;
}
```

| `reason` | |
| --- | --- |
| `status` | the server answered with a non-2xx status |
| `network` | `fetch` itself rejected (dns, connection reset, …) |
| `timeout` | the request timed out |
| `abort` | the caller aborted the request |
| `parse` | reading the response body failed |
| `config` | the call could not be built at all — bad URL, unserializable `data` |

`err.requestId` is `ctx.id`, so an error found in the logs points back at the `onSettled` line for the
same call. `'config'` errors are the one kind built without a context, so they carry no
url/method/attempt/requestId.

> `timeout` / `abort` are declared but not produced yet — `timeout` and `AbortSignal` handling land in
> a later release.

## Retry

`retries: 3` means **3 attempts total**. Unset means no retries.

`retryOn(ctx, result)` decides whether to retry, `retryDelay(ctx, result)` returns the delay in ms.
Both read `ctx.attempt` — 0-based, the index of the attempt that *just failed*. `retryOnStatus` and
`retryDelayExp2` are the built-in helpers; by default any error is retried after 1000 ms.

**A streaming request body is not replayable.** Retries re-send the same `body` reference, so a
`ReadableStream` (or anything else single-use) fails on attempt 2. Retries are supported for `data`
(a fresh `JSON.stringify` result), strings and buffers; use stream bodies with `retries` unset.

## Migrating from 0.1

| 0.1 | 0.2 |
| --- | --- |
| `interceptRequest(url, init)` | plugin `onAttempt(ctx)` — mutate `ctx.init`; the url is `ctx.url` (read-only) |
| `inspectResponse(res)` (ok only) | plugin `onSettled(ctx, result)` — ok branch, but it **fires for failures too** |
| `inspectError(err)` (per attempt) | plugin `onSettled(ctx, result)` — err branch, **once per call** |
| `retryOn(attempt, result)` | `retryOn(ctx, result)` |
| `retryDelay(attempt, result)` | `retryDelay(ctx, result)` — **every delay halves**, see below |
| `error.request` (always `undefined`) | `error.url` / `error.method` / `error.requestId` / `error.attempt` |
| — | `error.reason` |

The two rows collapsing onto `onSettled` are the ones to watch: an observer that used to fire per
attempt now fires once per call, and the error path no longer has a hook of its own.

`retryDelay` used to receive the *post-increment* attempt while `retryOn` received the
*pre-increment* one — for the same gap. Both now get the 0-based index of the failed attempt, which
means `retryDelayExp2(200)` waits 200 ms before the first retry instead of 400 ms. **Every configured
delay halves**; double your `startDelay` to keep the old timing.

## Do I Need This?

Probably not. Start with more popular alternatives like [openapi-fetch](https://openapi-ts.dev/openapi-fetch/) and [fetch-retry](https://github.com/jonbern/fetch-retry):

```ts
import createFetchClient from 'openapi-fetch';
import fetchRetry from 'fetch-retry';
import type { paths } from './my-openapi-3-schema'; // generated by openapi-typescript

const client = createFetchClient<paths>({
  baseUrl,
  fetch: fetchRetry(fetch, {
    retries: 1,
    retryDelay: (attempt, error, response) => {
      return 2 ** attempt * 1000;
    },
  }),
});
client.use({
  async onRequest({ request, options }) {},
  async onResponse({ request, response, options }) {},
  async onError({ error }) {},
});

const { data, error } = await client.GET('/data', {});
```
