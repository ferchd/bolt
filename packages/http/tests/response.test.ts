import { describe, expect, test } from "bun:test";

import {
  abort,
  HttpError,
  toErrorResponse,
  toResponse,
} from "../src/index.ts";

describe("HTTP responses", () => {
  test("normalizes common handler results", async () => {
    const json = toResponse({ created: true });
    const text = toResponse("hello");
    const empty = toResponse(undefined);

    expect(await json.json()).toEqual({ created: true });
    expect(await text.text()).toBe("hello");
    expect(empty.status).toBe(204);
  });

  test("renders expected HTTP errors as JSON", async () => {
    const response = toErrorResponse(
      new HttpError(422, "The request is invalid", {
        code: "INVALID_REQUEST",
        details: { field: "email" },
        headers: { "retry-after": "10" },
      }),
    );

    expect(response.status).toBe(422);
    expect(response.headers.get("retry-after")).toBe("10");
    expect(await response.json()).toEqual({
      error: {
        code: "INVALID_REQUEST",
        details: { field: "email" },
        message: "The request is invalid",
      },
    });
  });

  test("hides unexpected errors outside development", async () => {
    const error = new Error("database password leaked");
    const production = toErrorResponse(error);
    const development = toErrorResponse(error, { development: true });

    expect(await production.json()).toEqual({
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "Internal Server Error",
      },
    });
    expect(await development.text()).toContain("database password leaked");
  });

  test("provides an abort helper", () => {
    expect(() => abort(404, "User not found")).toThrow(HttpError);
    expect(() => new HttpError(200, "Not an error")).toThrow(RangeError);
  });
});
