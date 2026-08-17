import querystring from 'node:querystring';
import { parse as urlParse } from 'node:url';

import { errAsync, fromPromise, okAsync, Result, ResultAsync } from 'neverthrow';
import { createHttpError, HttpClientError } from './http-client.errors';

// TODO: use input istead of plain str url
export type Input = Parameters<typeof fetch>[0];
export type Init = Parameters<typeof fetch>[1] & {
  data?: any;
  query?: Record<string, any>;
};

export type HttpError = HttpClientError;

export type HttpResponse<T> = Omit<
  Response,
  'text' | 'json' | 'blob' | 'formData' | 'arrayBuffer'
> & {
  text: () => ResultAsync<string, HttpError>;
  json: () => ResultAsync<T, HttpError>;
  blob: () => ResultAsync<Blob, HttpError>;
  formData: () => ResultAsync<FormData, HttpError>;
  arrayBuffer: () => ResultAsync<ArrayBuffer, HttpError>;
};

export type HttpClientDefaultConfig = Omit<RequestInit, 'body' | 'method'> & {
  baseUrl?: string;

  interceptRequest?: (url: string, config: Init) => void;
  inspectError?: (error: HttpError) => void;
  inspectResponse?: (
    res: Omit<Response, 'text' | 'json' | 'blob' | 'formData' | 'arrayBuffer' | 'body'>,
  ) => void;

  retries?: number;
  retryDelay?: <T>(attempt: number, result: Result<HttpResponse<T>, HttpError>) => number;
  retryOn?: <T>(attempt: number, result: Result<HttpResponse<T>, HttpError>) => boolean;
};

/**
 * ### HTTP Client
 *
 * An HTTP client with retry functionality, callbacks, and error handling using [neverthrow](https://github.com/supermacro/neverthrow).
 *
 * It utilizes the fetch API under the hood and provides an API similar to fetch with additional options.
 *
 * Usage:
 *
 * ```typescript
 * const client = createHttpClient({
 *   baseUrl: 'https://example.com',
 *   retries: 3,
 *   retryDelay: (attempt) => Math.pow(2, attempt) * 1000,
 *   retryOn: retryOnStatus([401, 500]),
 *   // interceptRequest, inspectResponse, inspectError
 * });
 *
 * const { message } = await client
 *   .get<{ message: string }>('/data')
 *   .andThen((res) => res.json())
 *   .unwrapOr({ message: 'hello' });
 * ```
 */
export function createHttpClient(config: HttpClientDefaultConfig = {}) {
  const { baseUrl, interceptRequest, inspectError, inspectResponse, retries, ...defaultConfig } =
    config;

  const retryDelay = config.retryDelay ?? (() => 1000);
  const retryOn =
    config.retryOn ??
    (<T>(attempt: number, result: Result<HttpResponse<T>, HttpError>) => {
      return result.match(
        () => false,
        () => true,
      );
    });

  /**
   * Fetch Wrapper
   * 1. Merges initialization options with default configuration.
   * 2. Maps responses that are not OK (400...5xx) to `HttpError`.
   * 3. Wraps the promises in `ResultAsync`.
   */

  function request<T>(url: string, init?: Init): ResultAsync<HttpResponse<T>, HttpError> {
    const { headers, body, data, query, ...config } = init ?? {};
    const defaultHeaders = defaultConfig.headers ?? {};

    // TODO: delete base url query?
    const targetUrlStr = baseUrl ? baseUrl + url : url;

    let targetUrl: URL;
    try {
      targetUrl = new URL(targetUrlStr);

      if (query) {
        const urlQuery = urlParse(targetUrlStr, true).query;
        targetUrl.search = `?${querystring.stringify({ ...urlQuery, ...query })}`;
      }
    } catch (err) {
      return errAsync(
        createHttpError({
          reason: 'config',
          message: `Invalid request url: ${targetUrlStr}`,
          cause: err,
        }),
      );
    }

    let targetBody: RequestInit['body'];
    try {
      targetBody = data ? JSON.stringify(data) : body;
    } catch (err) {
      return errAsync(
        createHttpError({
          reason: 'config',
          message: 'Failed to serialize request data',
          cause: err,
        }),
      );
    }

    const targetInit = {
      ...defaultConfig,
      ...config,
      headers: { ...defaultHeaders, ...headers },
      body: targetBody,
    };

    interceptRequest?.(targetUrl.toString(), targetInit);

    return fromPromise(fetch(targetUrl, targetInit), (err) =>
      createHttpError({ reason: 'network', cause: err }),
    )
      .andThen((res) => {
        if (!res.ok) {
          return errAsync(
            createHttpError({
              reason: 'status',
              message: res.statusText,
              status: res.statusText,
              statusCode: res.status,
              response: res,
            }),
          );
        }

        // res.json(): Promise<T> -> ResultAsync<T, HttpError>
        const resProxy = wrapBodyMethods<T>(res);

        inspectResponse?.(res);

        return okAsync(resProxy);
      })
      .mapErr((err) => {
        inspectError?.(err);
        return err;
      });
  }

  async function _requestWithRetry<T>(url: string, init?: Init) {
    let attempt = 0;
    let shouldRetry = false;

    let res: Result<HttpResponse<T>, HttpError>;
    do {
      if (shouldRetry) {
        await new Promise((resolve) => setTimeout(resolve, retryDelay(attempt, res!)));
      }
      res = await request<T>(url, init);
      shouldRetry = retryOn(attempt, res);

      attempt++;
    } while (retries != null && shouldRetry && attempt < retries);

    return res;
  }

  const requestWithRetry = <T>(url: string, init?: Init) =>
    new ResultAsync(_requestWithRetry<T>(url, init));

  return {
    request: requestWithRetry,
    get: <T>(url: string, init?: Omit<Init, 'method' | 'data' | 'body'>) =>
      requestWithRetry<T>(url, { ...init, method: 'GET' }),
    head: <T>(url: string, init?: Omit<Init, 'method' | 'data' | 'body'>) =>
      requestWithRetry<T>(url, { ...init, method: 'HEAD' }),
    delete: <T>(url: string, init?: Omit<Init, 'method' | 'data' | 'body'>) =>
      requestWithRetry<T>(url, { ...init, method: 'DELETE' }),
    post: <T>(url: string, init?: Omit<Init, 'method'>) =>
      requestWithRetry<T>(url, { ...init, method: 'POST' }),
    put: <T>(url: string, init?: Omit<Init, 'method'>) =>
      requestWithRetry<T>(url, { ...init, method: 'PUT' }),
    patch: <T>(url: string, init?: Omit<Init, 'method'>) =>
      requestWithRetry<T>(url, { ...init, method: 'PATCH' }),
  };
}

export type HttpClient = ReturnType<typeof createHttpClient>;

export function retryOnStatus(statuses: number[]): HttpClientDefaultConfig['retryOn'] {
  return <T>(attempt: number, result: Result<HttpResponse<T>, HttpError>) =>
    result.match(
      (res) => statuses.includes(res.status),
      (err) => {
        if (statuses.includes(err.response?.status ?? -1)) {
          return true;
        }
        return false;
      },
    );
}

export function retryDelayExp2(startDelay = 1000): HttpClientDefaultConfig['retryDelay'] {
  return (attempt: number) => 2 ** attempt * startDelay;
}

function wrapBodyMethods<T>(res: Response): HttpResponse<T> {
  return new Proxy(res, {
    get(target: any, prop) {
      if (
        ['json', 'arrayBuffer', 'blob', 'formData', 'text'].includes(prop.toString()) &&
        typeof target[prop] === 'function'
      ) {
        return new Proxy(target[prop], {
          apply: (target, _, argumentsList) => {
            return ResultAsync.fromPromise(Reflect.apply(target, res, argumentsList) as any, (e) =>
              createHttpError({ reason: 'parse', cause: e }),
            );
          },
        });
      }

      const value = Reflect.get(target, prop, res);
      return typeof value === 'function' ? value.bind(res) : value;
    },
  });
}
