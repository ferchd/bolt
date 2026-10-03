import { HttpError } from "./http-error.ts";

export interface ErrorResponseOptions {
  readonly development?: boolean;
}

export function toResponse(value: unknown): Response {
  if (value instanceof Response) {
    return value;
  }

  if (value === undefined) {
    return new Response(null, { status: 204 });
  }

  if (typeof value === "string" || value instanceof Blob) {
    return new Response(value);
  }

  return Response.json(value);
}

export function toErrorResponse(
  error: unknown,
  options: ErrorResponseOptions = {},
): Response {
  if (error instanceof HttpError) {
    return Response.json(
      {
        error: {
          code: error.code,
          ...(error.details === undefined ? {} : { details: error.details }),
          message: error.message,
        },
      },
      {
        headers: error.headers,
        status: error.status,
      },
    );
  }

  return Response.json(
    {
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message:
          options.development && error instanceof Error
            ? error.message
            : "Internal Server Error",
        ...(options.development && error instanceof Error && error.stack
          ? { stack: error.stack }
          : {}),
      },
    },
    { status: 500 },
  );
}
