# Changelog

## 0.2.0

> [!NOTE]
> This release is a full-blown SLOPFLOOD: a mountain of edge cases handled, suspiciously excessive.
> I'll be digging my way out of it over the next few versions.

**Breaking**

- `neverthrow` moved from `dependencies` to `peerDependencies` (`>=8.1.1`): install it
  alongside, so a consumer's own copy is the one the `Result`s come from — a second, pinned
  copy makes every `instanceof` and every type check fail.
- `interceptRequest` / `inspectResponse` / `inspectError` are gone — use `plugins: [{ onAttempt, onSettled }]`.
- `retryOn` / `retryDelay` now take `(ctx, result)` and read the 0-based `ctx.attempt`, so every delay
  fires one step earlier than in 0.1 (`delayWith({ base: 200 })` waits 200 ms before the first retry).
- `retryOnStatus([401, 500])` → `retryWhen({ statuses: [401, 500] })`, which also takes inclusive
  ranges and matches `error.statusCode ?? error.response?.status` — so it now fires for status errors
  that carry no `response`. An `Ok` result no longer matches.
- `retryDelayExp2(n)` → `delayWith({ base: 2 * n })` — the old helper got the already-incremented
  counter, so it waited 2n/4n/8n.
- `retryOn` now defaults to `retryOnTransient` instead of "retry any error": a 4xx other than 408 and
  429 is no longer retried.
- `HttpClientError` carries a required `reason` and no longer has `request`.
- Headers are case-insensitive: client and per-call headers merge as a lowercase
  `Record<string, string>`, so a per-call `authorization` **replaces** a default `Authorization`
  instead of comma-joining with it. A `Headers` instance or a `string[][]` no longer vanishes on the
  way in, and `ctx.init.headers` is that record — plain, always present, lowercase-keyed.
- `data` is serialized whenever it is not `undefined` (`data: 0` sends `"0"`) and sets
  `content-type: application/json` unless the caller set a content type.
- `query` values are typed `string | number | boolean | null | undefined` or an array of those:
  `null`/`undefined` are omitted rather than sent empty, arrays expand to repeated params, `query: {}`
  leaves no trailing `?`, and a nested object is a compile error rather than `[object Object]`.

**Added**

- `put`, `patch`, `delete`, `head`.
- Plugins with `onAttempt` / `onSettled`, plus `onHookError` for hook failures.
- `RequestContext`: `id`, `url`, `method`, `attempt`, `duration`, shared mutable `init`.
- Per-attempt `timeout` and caller `signal`, at client and call level. A per-call `signal: null` opts
  out of the client-level one, and anything that is not an `AbortSignal` is ignored.
- `requestId` per call and a client-level generator.
- `retryWhen({ reasons, statuses, predicate })` and the `retryOnTransient` default.
- `delayWith({ base, factor, max, jitter, retryAfter })` — capped exponential backoff, full/equal
  jitter, and `Retry-After` support with its own ceiling: 60 s by default, `retryAfter: { max }` to
  change it. The backoff `max` does not truncate it.
- `RetryOn` / `RetryDelay` types, so a policy no longer needs
  `NonNullable<HttpClientDefaultConfig['retryOn']>`.
- The response of an attempt that is retried away is drained before the backoff, so its connection
  goes back to the pool. The terminal error's `response` is left unread and is yours to finish.

**Fixed**

- Bad urls, unserializable `data` and invalid `timeout` return `err(reason: 'config')` instead of
  throwing — "never throws" now holds. Those errors carry `url` and `method`.
- `query` no longer goes through the deprecated `url.parse` (DEP0169).
- An invalid `retries` (non-integer, negative, `NaN`) behaves as unset instead of looping forever, and
  a caller abort during the retry backoff settles immediately with `reason: 'abort'`.
- A `retryDelay` returning `NaN` / `Infinity` / a negative number is reported to `onHookError` instead
  of reaching `setTimeout`.
- A `timeout` above `2**31-1` is a config error instead of a silent 1 ms abort.
- Errors no longer carry `undefined` keys for fields that were never set, and an empty `statusText`
  (HTTP/2) yields `HTTP <status>` as the message.
- A body read that fails because the attempt timed out or the caller aborted reports
  `reason: 'timeout'` / `'abort'` instead of `'parse'`; `res.bytes()` is wrapped like the other body
  methods.
- `Retry-After` accepts only the three RFC 9110 date formats, so `1.5`, `+5` and friends fall through
  to the backoff instead of retrying instantly.

## 0.1.1

Initial release: `request`/`get`/`post`, retries, callbacks, neverthrow results.
