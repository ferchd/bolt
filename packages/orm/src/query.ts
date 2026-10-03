import type { SqlDialect, SqlExecutor, SqlValue } from "@bolt/database";
import { decode, entries, fields, type Entity, type Fields } from "./entity.ts";
import { Expr, expressionFingerprint, predicateNode, type ExpressionNode, type SqlExpression, quoteIdentifier, quoteTable, SqlCompiler } from "./expressions.ts";

export type Projection = Readonly<Record<string, SqlExpression>>;
export type ProjectionResult<P extends Projection> = { -readonly [K in keyof P]: P[K]["valueType"] };
export interface CompiledQuery { readonly sql: string; readonly parameters: readonly SqlValue[]; }
interface Join { readonly table: string; readonly alias: string; readonly kind: "INNER" | "LEFT"; readonly on: ExpressionNode; }
interface Ordering { readonly node: ExpressionNode; readonly direction: "ASC" | "DESC"; }
interface QueryState {
  readonly joins: readonly Join[];
  readonly predicates: readonly ExpressionNode[];
  readonly groups: readonly ExpressionNode[];
  readonly having: readonly ExpressionNode[];
  readonly order: readonly Ordering[];
  readonly selection?: Projection;
  readonly limit?: number;
  readonly offset: number;
  readonly distinct: boolean;
}
const initial: QueryState = { joins: [], predicates: [], groups: [], having: [], order: [], offset: 0, distinct: false };

/** Immutable, deferred server-side query. Callback bodies construct expressions; they never filter rows in JavaScript. */
export class Query<T extends object, R = T, S = Fields<T>> {
  private constructor(
    private readonly executor: SqlExecutor,
    private readonly entity: Entity<T>,
    private readonly scope: S,
    private readonly state: QueryState,
    private readonly materialize?: (value: T) => T,
  ) { }
  public static from<T extends object>(executor: SqlExecutor, entity: Entity<T>, materialize?: (value: T) => T): Query<T> {
    return new Query(executor, entity, fields(entity, "t0"), initial, materialize);
  }
  public where(predicate: (scope: S) => SqlExpression<boolean | null>): Query<T, R, S> {
    this.assertUnpaged("where");
    return this.copy({ predicates: [...this.state.predicates, predicateNode(requireExpr(predicate(this.scope)))] });
  }
  public select<P extends Projection>(selector: (scope: S) => P): Query<T, ProjectionResult<P>, S> {
    const selection = selector(this.scope);
    const selectionEntries = Object.entries(selection);
    if (!selectionEntries.length) throw new Error("A projection must contain at least one expression");
    for (const [key, expression] of selectionEntries) { quoteIdentifier(key, this.executor.dialect); requireExpr(expression); }
    return new Query(this.executor, this.entity, this.scope, { ...this.state, selection: Object.freeze({ ...selection }) }, this.materialize);
  }
  public orderBy(selector: (scope: S) => SqlExpression, direction: "asc" | "desc" = "asc"): Query<T, R, S> {
    this.assertUnpaged("orderBy");
    return this.copy({ order: [{ node: requireExpr(selector(this.scope)).node, direction: orderDirection(direction) }] });
  }
  public thenBy(selector: (scope: S) => SqlExpression, direction: "asc" | "desc" = "asc"): Query<T, R, S> {
    this.assertUnpaged("thenBy");
    if (!this.state.order.length) throw new Error("thenBy requires orderBy");
    return this.copy({ order: [...this.state.order, { node: requireExpr(selector(this.scope)).node, direction: orderDirection(direction) }] });
  }
  public take(limit: number): Query<T, R, S> {
    pageNumber(limit);
    return this.copy({ limit: Math.min(this.state.limit ?? limit, limit) });
  }
  public skip(offset: number): Query<T, R, S> {
    pageNumber(offset);
    pageNumber(this.state.offset + offset);
    return this.copy({ offset: this.state.offset + offset, ...(this.state.limit === undefined ? {} : { limit: Math.max(0, this.state.limit - offset) }) });
  }
  public distinct(): Query<T, R, S> { this.assertUnpaged("distinct"); return this.copy({ distinct: true }); }
  public join<U extends object>(entity: Entity<U>, on: (left: S, right: Fields<U>) => SqlExpression<boolean | null>): Query<T, R, { left: S; right: Fields<U> }> {
    return this.addJoin(entity, on, "INNER");
  }
  public leftJoin<U extends object>(entity: Entity<U>, on: (left: S, right: Fields<U>) => SqlExpression<boolean | null>): Query<T, R, { left: S; right: Fields<{ [K in keyof U]: U[K] | null }> }> {
    return this.addJoin(entity, on, "LEFT") as unknown as Query<T, R, { left: S; right: Fields<{ [K in keyof U]: U[K] | null }> }>;
  }
  public groupBy(selector: (scope: S) => SqlExpression | readonly SqlExpression[]): Query<T, R, S> {
    this.assertUnpaged("groupBy");
    const selected = selector(this.scope);
    const groups = (Array.isArray(selected) ? selected : [selected]) as readonly SqlExpression[];
    if (!groups.length) throw new Error("groupBy requires at least one expression");
    return this.copy({ groups: groups.map(expr => requireExpr(expr).node) });
  }
  public having(predicate: (scope: S) => SqlExpression<boolean | null>): Query<T, R, S> {
    this.assertUnpaged("having");
    if (!this.state.groups.length) throw new Error("having requires groupBy");
    return this.copy({ having: [...this.state.having, predicateNode(requireExpr(predicate(this.scope)))] });
  }
  public compile(dialect: SqlDialect = this.executor.dialect): CompiledQuery { return this.compileSelect(dialect, false); }
  public async toList(): Promise<R[]> {
    const compiled = this.compile();
    const result = await this.executor.execute(compiled.sql, compiled.parameters);
    return result.rows.map(row => this.readRow(row));
  }
  public async first(): Promise<R | null> { return (await this.take(1).toList())[0] ?? null; }
  public async firstOrThrow(): Promise<R> { const row = await this.first(); if (row === null) throw new Error("Query returned no rows"); return row; }
  public async single(): Promise<R | null> {
    const rows = await this.take(2).toList();
    if (rows.length > 1) throw new Error("Query returned more than one row");
    return rows[0] ?? null;
  }
  public async singleOrThrow(): Promise<R> { const row = await this.single(); if (row === null) throw new Error("Query returned no rows"); return row; }
  public async any(): Promise<boolean> { return (await this.take(1).toList()).length > 0; }
  public async count(): Promise<number> {
    const compiled = this.compileSelect(this.executor.dialect, true);
    const alias = quoteIdentifier("bolt_count", this.executor.dialect);
    const tableAlias = quoteIdentifier("bolt_count_source", this.executor.dialect);
    const as = this.executor.dialect === "oracle" ? " " : " AS ";
    const result = await this.executor.execute(`SELECT ${this.executor.dialect === "mssql" ? "COUNT_BIG" : "COUNT"}(*) AS ${alias} FROM (${compiled.sql})${as}${tableAlias}`, compiled.parameters);
    const row = result.rows[0];
    return checkedCount(row?.["bolt_count"] ?? row?.["BOLT_COUNT"]);
  }
  private addJoin<U extends object>(entity: Entity<U>, on: (left: S, right: Fields<U>) => SqlExpression<boolean | null>, kind: "INNER" | "LEFT"): Query<T, R, { left: S; right: Fields<U> }> {
    this.assertUnpaged("join");
    const alias = `t${this.state.joins.length + 1}`;
    const right = fields(entity, alias);
    const join: Join = { table: entity.table, alias, kind, on: predicateNode(requireExpr(on(this.scope, right))) };
    return new Query(this.executor, this.entity, { left: this.scope, right }, { ...this.state, joins: [...this.state.joins, join] }, this.materialize);
  }
  private copy(patch: Partial<QueryState>): Query<T, R, S> { return new Query(this.executor, this.entity, this.scope, { ...this.state, ...patch }, this.materialize); }
  private assertUnpaged(operation: string): void {
    if (this.state.limit !== undefined || this.state.offset) throw new Error(`${operation} must precede take/skip; subqueries after pagination are not implicit`);
  }
  private readRow(row: Record<string, unknown>): R {
    if (this.state.selection) {
      const result: Record<string, unknown> = {};
      for (const [key, expression] of Object.entries(this.state.selection)) result[key] = row[key] === null ? null : expression.codec?.decode ? expression.codec.decode(row[key]) : row[key];
      return result as R;
    }
    const instance = decode(this.entity, row);
    return (this.materialize ? this.materialize(instance) : instance) as unknown as R;
  }
  private compileSelect(dialect: SqlDialect, forCount: boolean): CompiledQuery {
    const compiler = new SqlCompiler(dialect);
    const q = (identifier: string): string => quoteIdentifier(identifier, dialect);
    const selection = this.state.selection;
    if (this.state.groups.length && !selection) throw new Error("Grouped queries require an explicit aggregate projection");
    if (this.state.groups.length && selection) {
      for (const expression of Object.values(selection)) validateGrouped(expression.node, this.state.groups);
      for (const expression of this.state.having) validateGrouped(expression, this.state.groups);
      for (const expression of this.state.order) validateGrouped(expression.node, this.state.groups);
    }
    const columns = selection
      ? Object.entries(selection).map(([key, expression]) => `${compiler.scalar(expression.node)} AS ${q(key)}`)
      : entries(this.entity).map(([key, column]) => `${q("t0")}.${q(column.name ?? key)} AS ${q(key)}`);
    const as = dialect === "oracle" ? " " : " AS ";
    let sql = `SELECT ${this.state.distinct ? "DISTINCT " : ""}${columns.join(", ")} FROM ${quoteTable(this.entity.table, dialect)}${as}${q("t0")}`;
    for (const join of this.state.joins) sql += ` ${join.kind} JOIN ${quoteTable(join.table, dialect)}${as}${q(join.alias)} ON ${compiler.predicate(join.on)}`;
    if (this.state.predicates.length) sql += ` WHERE ${this.state.predicates.map(node => compiler.predicate(node)).join(" AND ")}`;
    if (this.state.groups.length) sql += ` GROUP BY ${this.state.groups.map(node => compiler.scalar(node)).join(", ")}`;
    if (this.state.having.length) sql += ` HAVING ${this.state.having.map(node => compiler.predicate(node)).join(" AND ")}`;
    // An ungrouped aggregate projection produces exactly one row; pagination only includes/excludes it.
    if (!this.state.groups.length && selection && Object.values(selection).some(expr => containsAggregate(expr.node)) && Object.values(selection).every(expr => !containsUngroupedColumn(expr.node))) {
      if (this.state.offset > 0 || this.state.limit === 0) sql = `SELECT * FROM (${sql})${as}${q("bolt_empty")} WHERE 1 = 0`;
      return { sql, parameters: [...compiler.parameters] };
    }
    const paged = this.state.limit !== undefined || this.state.offset > 0;
    let ordering = this.state.order;
    if (paged && !ordering.length) {
      if (this.state.groups.length || this.state.distinct || (selection && Object.values(selection).some(expr => containsAggregate(expr.node)))) throw new Error("Pagination over groups, aggregates or DISTINCT requires explicit orderBy");
      ordering = this.entity.keys.map(key => ({ node: { kind: "column", alias: "t0", name: this.entity.columns[key].name ?? key }, direction: "ASC" as const }));
    }
    if (ordering.length && (!forCount || paged)) sql += ` ORDER BY ${ordering.map(order => `${compiler.scalar(order.node)} ${order.direction}`).join(", ")}`;
    if (paged) {
      if (dialect === "mssql" || dialect === "oracle") {
        sql += ` OFFSET ${compiler.bind(this.state.offset)} ROWS`;
        if (this.state.limit !== undefined) sql += ` FETCH NEXT ${compiler.bind(Math.max(1, this.state.limit))} ROWS ONLY`;
        if (this.state.limit === 0) sql = `SELECT * FROM (${sql})${as}${q("bolt_empty")} WHERE 1 = 0`;
      } else {
        if (this.state.limit !== undefined) sql += ` LIMIT ${compiler.bind(this.state.limit)}`;
        else if (dialect === "sqlite") sql += " LIMIT -1";
        else if (dialect === "mysql" || dialect === "mariadb") sql += " LIMIT 18446744073709551615";
        if (this.state.offset) sql += ` OFFSET ${compiler.bind(this.state.offset)}`;
      }
    }
    return { sql, parameters: [...compiler.parameters] };
  }
}

function requireExpr<T>(input: SqlExpression<T>): SqlExpression<T> { if (!(input instanceof Expr)) throw new TypeError("Query callbacks must return Expr instances; JavaScript comparisons are not SQL expressions"); return input; }
function pageNumber(input: number): void { if (!Number.isSafeInteger(input) || input < 0) throw new TypeError("Pagination requires a nonnegative safe integer"); }
function orderDirection(input: "asc" | "desc"): "ASC" | "DESC" { if (input !== "asc" && input !== "desc") throw new TypeError("Invalid ordering direction"); return input === "asc" ? "ASC" : "DESC"; }
function checkedCount(input: unknown): number { const result = Number(input); if (!Number.isSafeInteger(result) || result < 0) throw new RangeError("Row count exceeds JavaScript safe integer range"); return result; }
function containsAggregate(node: ExpressionNode): boolean {
  if (node.kind === "aggregate") return true;
  if (node.kind === "binary") return containsAggregate(node.left) || containsAggregate(node.right);
  if (node.kind === "logical") return node.nodes.some(containsAggregate);
  if (node.kind === "not" || node.kind === "null" || node.kind === "like" || node.kind === "in") return containsAggregate(node.node);
  return false;
}
function containsUngroupedColumn(node: ExpressionNode): boolean {
  if (node.kind === "aggregate" || node.kind === "value") return false;
  if (node.kind === "column") return true;
  if (node.kind === "binary") return containsUngroupedColumn(node.left) || containsUngroupedColumn(node.right);
  if (node.kind === "logical") return node.nodes.some(containsUngroupedColumn);
  return containsUngroupedColumn(node.node);
}
function validateGrouped(node: ExpressionNode, groups: readonly ExpressionNode[]): void {
  if (groups.some(group => expressionFingerprint(group) === expressionFingerprint(node)) || node.kind === "aggregate" || node.kind === "value") return;
  if (node.kind === "column") throw new Error("Every non-aggregate projection, ordering and having column must be grouped");
  if (node.kind === "binary") { validateGrouped(node.left, groups); validateGrouped(node.right, groups); }
  else if (node.kind === "logical") node.nodes.forEach(item => validateGrouped(item, groups));
  else { validateGrouped(node.node, groups); if (node.kind === "like") validateGrouped(node.value, groups); if (node.kind === "in") node.values.forEach(item => validateGrouped(item, groups)); }
}
