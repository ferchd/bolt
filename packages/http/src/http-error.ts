export interface HttpErrorOptions {
  readonly cause?: unknown;
  readonly code?: string;
  readonly details?: unknown;
  readonly headers?: HeadersInit;
}

export class HttpError extends Error {
  public override readonly name = "HttpError";
  public readonly code: string;
  public readonly details?: unknown;
  public readonly headers: Headers;

  public constructor(
    public readonly status: number,
    message: string,
    options: HttpErrorOptions = {},
  ) {
    validateStatus(status);
    super(message, { cause: options.cause });
    this.code = options.code ?? `HTTP_${status}`;
    this.details = options.details;
    this.headers = new Headers(options.headers);
  }
}

export function abort(
  status: number,
  message: string,
  options?: HttpErrorOptions,
): never {
  throw new HttpError(status, message, options);
}

function validateStatus(status: number): void {
  if (!Number.isInteger(status) || status < 400 || status > 599) {
    throw new RangeError("HTTP error status must be an integer from 400 to 599");
  }
}
