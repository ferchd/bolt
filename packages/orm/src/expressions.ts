import type { SqlDialect, SqlValue } from "@bolt/database";

export type ExpressionNode =
  | { readonly kind: "column"; readonly alias: string; readonly name: string }
  | { readonly kind: "value"; readonly value: SqlValue }
  | { readonly kind: "binary"; readonly operator: "=" | "<>" | ">" | ">=" | "<" | "<=" | "+" | "-"; readonly left: ExpressionNode; readonly right: ExpressionNode }
  | { readonly kind: "logical"; readonly operator: "AND" | "OR"; readonly nodes: readonly ExpressionNode[] }
  | { readonly kind: "not"; readonly node: ExpressionNode }
  | { readonly kind: "null"; readonly node: ExpressionNode; readonly negate: boolean }
  | { readonly kind: "in"; readonly node: ExpressionNode; readonly values: readonly ExpressionNode[] }
  | { readonly kind: "like"; readonly node: ExpressionNode; readonly value: ExpressionNode }
  | { readonly kind: "aggregate"; readonly name: "COUNT" | "SUM" | "AVG" | "MIN" | "MAX"; readonly node?: ExpressionNode; readonly distinct: boolean };
export type PredicateResult<T> = null extends T ? boolean | null : boolean;
export interface SqlExpression<T = unknown> {
  readonly valueType: T;
  readonly node: ExpressionNode;
  readonly codec?: { readonly encode?: (value: unknown) => SqlValue; readonly decode?: (value: unknown) => T };
}

/** A typed SQL expression. Values remain bound parameters; JavaScript callbacks only build ASTs. */
export class Expr<T> {
  declare readonly valueType: T;
  readonly #node: ExpressionNode;
  public constructor(node: ExpressionNode, public readonly codec?: { readonly encode?: (value: unknown) => SqlValue; readonly decode?: (value: unknown) => T }) {
    this.#node = cloneExpression(node);
    this.codec = codec ?? (isPredicate(node) ? { decode: decodeBoolean as (value: unknown) => T } : undefined);
    Object.freeze(this);
  }
  /** AST snapshots cannot mutate a deferred query's captured values. */
  public get node(): ExpressionNode { return cloneExpression(this.#node); }
  public eq(value: T | SqlExpression<T>): Expr<PredicateResult<T>> { return this.compare("=", value); }
  public ne(value: T | SqlExpression<T>): Expr<PredicateResult<T>> { return this.compare("<>", value); }
  public gt(value: T | SqlExpression<T>): Expr<PredicateResult<T>> { return this.compare(">", value); }
  public gte(value: T | SqlExpression<T>): Expr<PredicateResult<T>> { return this.compare(">=", value); }
  public lt(value: T | SqlExpression<T>): Expr<PredicateResult<T>> { return this.compare("<", value); }
  public lte(value: T | SqlExpression<T>): Expr<PredicateResult<T>> { return this.compare("<=", value); }
  public isNull(): Expr<boolean> { return new Expr({ kind: "null", node: this.node, negate: false }); }
  public isNotNull(): Expr<boolean> { return new Expr({ kind: "null", node: this.node, negate: true }); }
  public in(values: readonly T[]): Expr<PredicateResult<T>> { return new Expr({ kind: "in", node: this.node, values: values.map(value => nodeOf(this.codec?.encode ? this.codec.encode(value) : value)) }); }
  public plus(this: Expr<number>, value: number | Expr<number>): Expr<number> { return new Expr({ kind: "binary", operator: "+", left: this.node, right: nodeOf(value) }, { decode: decodeNumber }); }
  public minus(this: Expr<number>, value: number | Expr<number>): Expr<number> { return new Expr({ kind: "binary", operator: "-", left: this.node, right: nodeOf(value) }, { decode: decodeNumber }); }
  public startsWith(this: Expr<string>, value: string): Expr<boolean> { return this.pattern(`${escapeLike(value)}%`); }
  public endsWith(this: Expr<string>, value: string): Expr<boolean> { return this.pattern(`%${escapeLike(value)}`); }
  public contains(this: Expr<string>, value: string): Expr<boolean> { return this.pattern(`%${escapeLike(value)}%`); }
  private pattern(value: string): Expr<boolean> { return new Expr({ kind: "like", node: this.node, value: nodeOf(value) }); }
  private compare(operator: "=" | "<>" | ">" | ">=" | "<" | "<=", value: T | SqlExpression<T>): Expr<PredicateResult<T>> {
    const right = nodeOf(value instanceof Expr || value === null ? value : this.codec?.encode ? this.codec.encode(value) : value);
    if (right.kind === "value" && right.value === null && (operator === "=" || operator === "<>")) {
      return new Expr({ kind: "null", node: this.node, negate: operator === "<>" });
    }
    return new Expr({ kind: "binary", operator, left: this.node, right });
  }
}

export function value<T extends SqlValue>(input: T): Expr<T> { return new Expr(nodeOf(input), typeof input === "boolean" ? { decode: persisted => decodeBoolean(persisted) as T } : undefined); }
export function predicateNode(expression: SqlExpression<boolean | null>): ExpressionNode {
  const node = expression.node;
  if (isPredicate(node)) return node;
  return { kind: "binary", operator: "=", left: node, right: nodeOf(expression.codec?.encode ? expression.codec.encode(true) : true) };
}
export function and<T extends boolean | null>(...expressions: readonly SqlExpression<T>[]): Expr<PredicateResult<T>> { return new Expr({ kind: "logical", operator: "AND", nodes: expressions.map(predicateNode) }); }
export function or<T extends boolean | null>(...expressions: readonly SqlExpression<T>[]): Expr<PredicateResult<T>> { return new Expr({ kind: "logical", operator: "OR", nodes: expressions.map(predicateNode) }); }
export function not<T extends boolean | null>(expression: SqlExpression<T>): Expr<PredicateResult<T>> { return new Expr({ kind: "not", node: predicateNode(expression) }); }
export function count(expression?: SqlExpression, distinct = false): Expr<number> {
  if (!expression && distinct) throw new Error("Distinct count requires an expression");
  return new Expr({ kind: "aggregate", name: "COUNT", ...(expression ? { node: expression.node } : {}), distinct }, { decode: input => {
    const result = Number(input); if (!Number.isSafeInteger(result) || result < 0) throw new RangeError("Count exceeds JavaScript safe integer range"); return result;
  } });
}
export function sum(expression: SqlExpression<number>): Expr<number | null> { return numericAggregate("SUM", expression); }
export function avg(expression: SqlExpression<number>): Expr<number | null> { return numericAggregate("AVG", expression); }
export function min<T>(expression: SqlExpression<T>): Expr<T | null> { return aggregate("MIN", expression); }
export function max<T>(expression: SqlExpression<T>): Expr<T | null> { return aggregate("MAX", expression); }
function numericAggregate(name: "SUM" | "AVG", expression: SqlExpression<number>): Expr<number | null> {
  return new Expr({ kind: "aggregate", name, node: expression.node, distinct: false }, { decode: input => {
    if (input === null) return null;
    return decodeNumber(input);
  } });
}
function decodeNumber(input: unknown): number {
  if (typeof input !== "number" && typeof input !== "bigint" && typeof input !== "string") throw new TypeError("Numeric expression did not return a SQL number");
  const result = Number(input); if (!Number.isFinite(result) || (Number.isInteger(result) && !Number.isSafeInteger(result))) throw new RangeError("Numeric expression exceeds JavaScript precision"); return result;
}
function decodeBoolean(input: unknown): boolean {
  if (input === true || input === 1 || input === 1n || input === "1") return true;
  if (input === false || input === 0 || input === 0n || input === "0") return false;
  throw new TypeError("Predicate projection did not return a SQL boolean");
}
function isPredicate(node: ExpressionNode): boolean {
  return node.kind === "logical" || node.kind === "not" || node.kind === "null" || node.kind === "in" || node.kind === "like" || (node.kind === "binary" && node.operator !== "+" && node.operator !== "-");
}
function aggregate<T>(name: "COUNT" | "SUM" | "AVG" | "MIN" | "MAX", expression?: SqlExpression, distinct = false): Expr<T> {
  return new Expr({ kind: "aggregate", name, ...(expression ? { node: expression.node } : {}), distinct }, expression?.codec?.decode ? { decode: input => input === null ? null as T : expression.codec!.decode!(input) as T } : undefined);
}
function escapeLike(input: string): string { return input.replace(/[!%_\[]/g, char => `!${char}`); }
export function nodeOf(input: unknown): ExpressionNode {
  if (input instanceof Expr) return input.node;
  if (input === null || typeof input === "string" || typeof input === "bigint" || typeof input === "boolean" || input instanceof Date || input instanceof Uint8Array || (typeof input === "number" && Number.isFinite(input))) {
    return { kind: "value", value: input };
  }
  throw new TypeError("SQL expressions require a scalar SQL value; use a column codec for structured data");
}
export function quoteIdentifier(identifier: string, dialect: SqlDialect): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) throw new TypeError(`Invalid SQL identifier: ${identifier}`);
  if (dialect === "mysql" || dialect === "mariadb") return `\`${identifier}\``;
  if (dialect === "mssql") return `[${identifier}]`;
  return `"${identifier}"`;
}
export function quoteTable(table: string, dialect: SqlDialect): string { return table.split(".").map(part => quoteIdentifier(part, dialect)).join("."); }

export class SqlCompiler {
  public readonly parameters: SqlValue[] = [];
  public constructor(public readonly dialect: SqlDialect) { }
  public bind(input: SqlValue): string {
    if (nodeOf(input).kind !== "value") throw new TypeError("SQL parameters must be scalar values");
    if (typeof input === "number" && Number.isInteger(input) && !Number.isSafeInteger(input)) throw new RangeError("Unsafe SQL integers require bigint or an exact string");
    if (input instanceof Date && !Number.isFinite(input.getTime())) throw new TypeError("Invalid SQL date");
    const maxParameters = this.dialect === "mssql" ? 2100 : this.dialect === "sqlite" ? 32766 : 65535;
    if (this.parameters.length >= maxParameters) throw new RangeError(`The ${this.dialect} query exceeds ${maxParameters} parameters; use explicit batches`);
    this.parameters.push(input);
    switch (this.dialect) {
      case "postgresql": return `$${this.parameters.length}`;
      case "mssql": return `@p${this.parameters.length}`;
      case "oracle": return `:p${this.parameters.length}`;
      default: return "?";
    }
  }
  public expression(node: ExpressionNode): string {
    switch (node.kind) {
      case "column": return `${quoteIdentifier(node.alias, this.dialect)}.${quoteIdentifier(node.name, this.dialect)}`;
      case "value": return this.bind((this.dialect === "mssql" || this.dialect === "oracle") && typeof node.value === "boolean" ? (node.value ? 1 : 0) : node.value);
      case "binary": {
        if (!["=", "<>", ">", ">=", "<", "<=", "+", "-"].includes(node.operator)) throw new TypeError("Invalid SQL binary operator");
        return `(${this.scalar(node.left)} ${node.operator} ${this.scalar(node.right)})`;
      }
      case "logical": {
        if (node.operator !== "AND" && node.operator !== "OR") throw new TypeError("Invalid SQL logical operator");
        return node.nodes.length ? `(${node.nodes.map(item => this.predicate(item)).join(` ${node.operator} `)})` : (node.operator === "AND" ? "(1 = 1)" : "(1 = 0)");
      }
      case "not": return `(NOT ${this.predicate(node.node)})`;
      case "null": return `(${this.scalar(node.node)} IS ${node.negate ? "NOT " : ""}NULL)`;
      case "in": {
        if (!node.values.length) return "(1 = 0)";
        const size = this.dialect === "oracle" ? 1000 : node.values.length;
        const parts: string[] = [];
        for (let start = 0; start < node.values.length; start += size) parts.push(`${this.scalar(node.node)} IN (${node.values.slice(start, start + size).map(item => this.scalar(item)).join(", ")})`);
        return `(${parts.join(" OR ")})`;
      }
      case "like": return `(${this.scalar(node.node)} LIKE ${this.scalar(node.value)} ESCAPE '!')`;
      case "aggregate": {
        if (!["COUNT", "SUM", "AVG", "MIN", "MAX"].includes(node.name)) throw new TypeError("Invalid SQL aggregate");
        const name = this.dialect === "mssql" && node.name === "COUNT" ? "COUNT_BIG" : node.name;
        let operand = node.node ? this.scalar(node.node) : "*";
        // JS number aggregates use floating numeric semantics; SQL Server AVG(int) would otherwise truncate.
        if (this.dialect === "mssql" && (node.name === "AVG" || node.name === "SUM")) operand = `CAST(${operand} AS FLOAT)`;
        return `${name}(${node.distinct ? "DISTINCT " : ""}${operand})`;
      }
      default: throw new TypeError("Invalid SQL expression node");
    }
  }
  /** Older Oracle and SQL Server require predicates to become scalar values explicitly. */
  public scalar(node: ExpressionNode): string {
    if ((this.dialect === "mssql" || this.dialect === "oracle") && isPredicate(node)) {
      // Compile twice so positional transports receive a binding for each occurrence. Preserve SQL UNKNOWN.
      return `(CASE WHEN ${this.expression(node)} THEN 1 WHEN NOT ${this.expression(node)} THEN 0 ELSE NULL END)`;
    }
    return this.expression(node);
  }
  public predicate(node: ExpressionNode): string {
    if ((this.dialect === "mssql" || this.dialect === "oracle") && !isPredicate(node)) return `(${this.scalar(node)} = 1)`;
    return this.expression(node);
  }
}

function cloneExpression(node: ExpressionNode): ExpressionNode {
  switch (node.kind) {
    case "column": return { ...node };
    case "value": return { ...node, value: node.value instanceof Date ? new Date(node.value.getTime()) : node.value instanceof Uint8Array ? node.value.slice() : node.value };
    case "binary": return { ...node, left: cloneExpression(node.left), right: cloneExpression(node.right) };
    case "logical": return { ...node, nodes: node.nodes.map(cloneExpression) };
    case "not": case "null": return { ...node, node: cloneExpression(node.node) };
    case "in": return { ...node, node: cloneExpression(node.node), values: node.values.map(cloneExpression) };
    case "like": return { ...node, node: cloneExpression(node.node), value: cloneExpression(node.value) };
    case "aggregate": return { ...node, ...(node.node ? { node: cloneExpression(node.node) } : {}) };
    default: throw new TypeError("Invalid SQL expression node");
  }
}
/** JSON-safe structural comparison, preserving bigint and binary literal types. */
export function expressionFingerprint(node: ExpressionNode): string {
  return JSON.stringify(node, (_key, input: unknown) => typeof input === "bigint" ? { bigint: input.toString() } : input instanceof Uint8Array ? { bytes: Array.from(input) } : input);
}
