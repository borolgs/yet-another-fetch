/**
 * Why the error happened. Lets `retryOn` and error metrics classify a failure
 * without string-matching a message.
 *
 * - `status` — the server answered with a non-2xx status
 * - `network` — `fetch` itself rejected (dns, connection reset, ...)
 * - `timeout` — the request timed out
 * - `abort` — the caller aborted the request
 * - `parse` — reading the response body failed
 * - `config` — the call could not be built at all (bad url, unserializable data)
 */
export type HttpErrorReason = 'status' | 'network' | 'timeout' | 'abort' | 'parse' | 'config';

export type CreateHttpClientError = {
  reason: HttpErrorReason;
  message?: string;
  cause?: any;
  status?: string;
  statusCode?: number;
  response?: Response;
};

export class HttpClientError extends Error {
  reason: HttpErrorReason;
  status?: string;
  statusCode?: number;
  name = 'HttpClientError';

  response?: Response;

  url?: string;
  method?: string;
  attempt?: number;
  requestId?: string;

  constructor(message: string, reason: HttpErrorReason = 'network') {
    super(message);
    this.reason = reason;
    Error.captureStackTrace?.(this, this.constructor);
  }
}

export function createHttpError({
  reason,
  message,
  cause,
  status,
  statusCode,
  response,
}: CreateHttpClientError): HttpClientError {
  const error = new HttpClientError(message ?? 'Http Client Error', reason);

  if (cause) {
    error.cause = cause;
  }
  if (status) {
    error.status = status;
  }
  if (statusCode) {
    error.statusCode = statusCode;
  }
  if (response) {
    error.response = response;
  }

  return error;
}

export function isHttpClientError(err: any): err is HttpClientError {
  return err instanceof HttpClientError;
}
