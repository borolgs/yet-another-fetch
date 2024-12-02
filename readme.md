# Yet another fetch

An HTTP client with retry functionality, callbacks, and error handling using [neverthrow](https://github.com/supermacro/neverthrow).

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
  retryDelay: (attempt) => 2 ** attempt * 1000, // or use retryDelayExp2(1000)
  retryOn: retryOnStatus([401, 500]),
  interceptRequest(url, config) {
    // Object.assign(config.headers, { hello: "world" });
  },
  inspectResponse(response) {
    // app.requestContext.set('setCookies', response.headers.getSetCookie());
  },
  inspectError(error) {
    // console.error(error);
  },
});

const { message } = await client
  .get<{ message: string }>('/data')
  .andThen((res) => res.json())
  .unwrapOr({ message: 'hello' });
```

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
