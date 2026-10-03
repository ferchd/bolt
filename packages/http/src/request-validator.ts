import {
  ValidationError,
  type Infer,
  type Schema,
} from "@bolt/validation";

import type { HttpContext } from "./context.ts";
import { HttpError } from "./http-error.ts";

export class RequestValidator {
  public constructor(private readonly context: HttpContext) {}

  public async body<Definition extends Schema<unknown>>(
    schema: Definition,
  ): Promise<Infer<Definition>> {
    let input: unknown;

    try {
      input = await this.context.request.json();
    } catch (error) {
      throw new HttpError(400, "Request body must contain valid JSON", {
        cause: error,
        code: "INVALID_JSON",
      });
    }

    return this.parse(schema, input);
  }

  public params<Definition extends Schema<unknown>>(
    schema: Definition,
  ): Infer<Definition> {
    return this.parse(schema, this.context.params);
  }

  public query<Definition extends Schema<unknown>>(
    schema: Definition,
  ): Infer<Definition> {
    return this.parse(schema, queryToObject(this.context.query));
  }

  private parse<Definition extends Schema<unknown>>(
    schema: Definition,
    input: unknown,
  ): Infer<Definition> {
    try {
      return schema.parse(input) as Infer<Definition>;
    } catch (error) {
      if (!(error instanceof ValidationError)) {
        throw error;
      }

      throw new HttpError(422, "The request is invalid", {
        cause: error,
        code: "VALIDATION_ERROR",
        details: { issues: error.issues },
      });
    }
  }
}

function queryToObject(query: URLSearchParams): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};

  for (const key of new Set(query.keys())) {
    const values = query.getAll(key);
    result[key] = values.length === 1 ? values[0] ?? "" : values;
  }

  return result;
}
