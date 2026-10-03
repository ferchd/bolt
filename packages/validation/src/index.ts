import {
  array,
  boolean,
  date,
  enumeration,
  file,
  literal,
  nullable,
  number,
  object,
  optional,
  string,
  union,
  uuid,
} from "./schema.ts";

const v = Object.freeze({
  array,
  boolean,
  date,
  enum: enumeration,
  file,
  literal,
  nullable,
  number,
  object,
  optional,
  string,
  union,
  uuid,
});

export default v;
export {
  array,
  boolean,
  date,
  enumeration,
  file,
  literal,
  nullable,
  number,
  object,
  optional,
  string,
  union,
  uuid,
};
export { enumeration as enum };
export {
  ArraySchema,
  BooleanSchema,
  DateSchema,
  DefaultSchema,
  EnumSchema,
  FileSchema,
  LiteralSchema,
  NullableSchema,
  NumberSchema,
  ObjectSchema,
  OptionalSchema,
  RefinementSchema,
  Schema,
  StringSchema,
  TransformSchema,
  UnionSchema,
} from "./schema.ts";
export { ValidationError } from "./validation-error.ts";

export type {
  CoercionOptions,
  DateOptions,
  Infer,
  LiteralValue,
  ObjectOutput,
  ObjectShape,
  PartialObjectShape,
  SafeParseResult,
} from "./schema.ts";
export type {
  ValidationIssue,
  ValidationIssueCode,
  ValidationPath,
} from "./validation-error.ts";
