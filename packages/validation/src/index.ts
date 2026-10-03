import {
  array,
  boolean,
  number,
  object,
  optional,
  string,
} from "./schema.ts";

const v = Object.freeze({ array, boolean, number, object, optional, string });

export default v;
export { array, boolean, number, object, optional, string };
export {
  ArraySchema,
  BooleanSchema,
  NumberSchema,
  ObjectSchema,
  OptionalSchema,
  Schema,
  StringSchema,
} from "./schema.ts";
export { ValidationError } from "./validation-error.ts";

export type {
  CoercionOptions,
  Infer,
  ObjectOutput,
  ObjectShape,
  SafeParseResult,
} from "./schema.ts";
export type {
  ValidationIssue,
  ValidationIssueCode,
  ValidationPath,
} from "./validation-error.ts";
