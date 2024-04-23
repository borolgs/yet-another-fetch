# Yet another fetch

An HTTP client with retry functionality, callbacks, and error handling using [neverthrow](https://github.com/supermacro/neverthrow).

It utilizes the fetch API under the hood and provides an API similar to fetch with additional options.

Installation:

```bash
pnpm i yet-another-fetch
```

Usage:

```ts
import { createHttpClient, retryOnStatus, retryDelayExp2 } from 'yet-another-fetch';

const client = createHttpClient({
  baseUrl: 'https://example.com',
  retries: 3,
  retryDelay: (attempt) => 2 ** attempt * startDelay, // retryDelayExp2(1000)
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
