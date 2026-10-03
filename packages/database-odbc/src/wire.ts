import type { SqlValue } from "@bolt/database";

export interface WireValue { readonly type: string; readonly value?: string | boolean; }
export function encodeValue(value: SqlValue): WireValue {
  if (value === null) return { type: "null" };
  if (typeof value === "string") return { type: "string", value };
  if (typeof value === "boolean") return { type: "boolean", value };
  if (typeof value === "bigint") {
    if (value < -(2n ** 63n) || value > 2n ** 63n - 1n) throw new RangeError("ODBC bigint parameter exceeds signed 64-bit range; bind larger decimals as strings");
    return { type: "bigint", value: value.toString() };
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("SQL number must be finite");
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) throw new RangeError("Use bigint or a string for integers outside the safe number range");
    return { type: "number", value: value.toString() };
  }
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw new TypeError("Invalid SQL date");
    return { type: "date", value: value.toISOString() };
  }
  if (value instanceof Uint8Array) return { type: "binary", value: Buffer.from(value).toString("base64") };
  throw new TypeError("Unsupported SQL parameter");
}
export function decodeValue(input: unknown): unknown {
  if (!input || typeof input !== "object" || !("type" in input)) throw new Error("Invalid ODBC value protocol");
  const value = input as WireValue;
  if (value.type === "null") return null;
  if (value.type === "boolean" && typeof value.value === "boolean") return value.value;
  if (typeof value.value !== "string") throw new Error("Invalid ODBC value protocol");
  switch (value.type) {
    case "string": case "decimal": case "date": return value.value;
    case "bigint": {
      if (!/^-?\d+$/.test(value.value)) throw new Error("Invalid ODBC bigint protocol");
      return BigInt(value.value);
    }
    case "number": {
      const result = Number(value.value);
      if (!Number.isFinite(result)) throw new Error("Invalid ODBC number protocol");
      return result;
    }
    case "binary": {
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.value)) throw new Error("Invalid ODBC binary protocol");
      return new Uint8Array(Buffer.from(value.value, "base64"));
    }
    default: throw new Error("Unsupported ODBC value protocol");
  }
}
