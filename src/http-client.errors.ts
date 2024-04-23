export type CreateHttpClientError = {
  message?: string;
  cause?: any;
  status?: string;
  statusCode?: number;
  request?: Request;
  response?: Response;
};

export class HttpClientError extends Error {
  status?: string;
  statusCode?: number;
  name = 'HttpClientError';

  request?: Request;
  response?: Response;

  constructor(message: string) {
    super(message);
    Error.captureStackTrace?.(this, this.constructor);
  }
}

export function createHttpError({
  message,
  cause,
  status,
  statusCode,
  request,
  response,
}: CreateHttpClientError): HttpClientError {
  const error = new HttpClientError(message ?? 'Http Client Error');

  if (cause) {
    error.cause = cause;
  }
  if (status) {
    error.status = status;
  }
  if (statusCode) {
    error.statusCode = statusCode;
  }
  if (request) {
    error.request = request;
  }
  if (response) {
    error.response = response;
  }

  return error;
}

export function isHttpClientError(err: any): err is HttpClientError {
  return err instanceof HttpClientError;
}
