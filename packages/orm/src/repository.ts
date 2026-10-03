import type { SqlExecutor, SqlOutputParameter, SqlValue } from "@bolt/database";
import { SqlPostCommitError } from "@bolt/database";
import { decode, encode, entityKey, entries, type Entity, type Fields } from "./entity.ts";
import { and, or, Expr, type SqlExpression, quoteIdentifier, quoteTable, SqlCompiler } from "./expressions.ts";
import { Query } from "./query.ts";
import { assertWritable, mssqlCapture, OrmPostCommitError, OrmReconciliationError, publish } from "./mutations.ts";

export class OptimisticLockError extends Error {
  public constructor(public readonly table: string) { super(`The ${table} entity was changed or deleted by another writer`); this.name = "OptimisticLockError"; }
}
export class EntityNotFoundError extends Error {
  public constructor(public readonly table: string) { super(`The ${table} entity no longer exists`); this.name = "EntityNotFoundError"; }
}

/** CRUD with assigned/composite keys and a numeric optimistic version column. */
export class Repository<T extends object> {
  public constructor(private readonly executor: SqlExecutor, public readonly entity: Entity<T>, private readonly materialize?: (instance: T) => T, private readonly transactionBound = false) { }
  /** Use only with the executor supplied by a SqlExecutor.transaction callback. */
  public static inTransaction<T extends object>(executor: SqlExecutor, entity: Entity<T>): Repository<T> { return new Repository(executor, entity, undefined, true); }
  public query(): Query<T> { return Query.from(this.executor, this.entity, this.materialize); }
  public async find(key: Partial<T>): Promise<T | null> {
    validateKey(this.entity, key);
    return this.query().where(scope => keyPredicate(this.entity, key, scope)).single();
  }
  public async insert(values: Partial<T>): Promise<T> {
    const input = cloneInput(this.entity, values);
    let persisted: T | undefined;
    try {
      return await this.runTransaction(async repository => {
        const result = await repository.insertCore(input);
        persisted = this.materialize ? this.materialize(result) : result;
        return persisted;
      });
    } catch (error) {
      if (error instanceof SqlPostCommitError && persisted !== undefined) throw new OrmPostCommitError(error, persisted);
      throw error;
    }
  }
  public async update(instance: T, properties?: readonly (keyof T & string)[]): Promise<T> {
    assertWritable(this.entity, instance);
    const candidate = cloneInput(this.entity, instance) as T;
    let persisted: T | undefined;
    let cleanupError: SqlPostCommitError | undefined;
    try { persisted = await this.runTransaction(async repository => { persisted = await repository.updateCore(candidate, properties); return persisted; }); }
    catch (error) { if (error instanceof SqlPostCommitError && persisted) cleanupError = error; else throw error; }
    if (!persisted) throw new Error("The update did not produce a persisted entity");
    try { assertWritable(this.entity, instance); publish(this.entity, instance, persisted); } catch (cause) { throw new OrmReconciliationError(cause); }
    if (cleanupError) throw cleanupError;
    return instance;
  }
  private async updateCore(instance: T, properties?: readonly (keyof T & string)[]): Promise<T> {
    entityKey(this.entity, instance);
    const compiler = new SqlCompiler(this.executor.dialect);
    const q = (key: keyof T & string): string => quoteIdentifier(this.entity.columns[key].name ?? key, this.executor.dialect);
    const changed = properties ? [...new Set(properties)] : entries(this.entity).map(([key]) => key).filter(key => !this.entity.keys.includes(key) && key !== this.entity.version);
    for (const key of changed) if (!Object.hasOwn(this.entity.columns, key) || this.entity.keys.includes(key) || key === this.entity.version) throw new Error(`Column ${key} cannot be updated explicitly`);
    if (!changed.length) return instance;
    const assignments = changed.map(key => `${q(key)} = ${compiler.bind(encode(this.entity, key, instance[key]))}`);
    const version = this.entity.version;
    if (version) { checkVersion(instance[version]); assignments.push(`${q(version)} = ${q(version)} + 1`); }
    const predicates = this.entity.keys.map(key => `${q(key)} = ${compiler.bind(encode(this.entity, key, instance[key]))}`);
    if (version) predicates.push(`${q(version)} = ${compiler.bind(encode(this.entity, version, instance[version]))}`);
    if (this.executor.dialect === "mssql") {
      const capture = mssqlCapture(this.entity);
      const result = await this.executor.execute(`${capture.prefix}UPDATE ${quoteTable(this.entity.table, "mssql")} SET ${assignments.join(", ")}${capture.output} WHERE ${predicates.join(" AND ")}${capture.finish}`, compiler.parameters);
      assertAffected(result.rows.length, this.entity);
      return decode(this.entity, result.rows[0]!);
    }
    const returning = this.executor.dialect === "sqlite" || this.executor.dialect === "postgresql";
    const result = await this.executor.execute(`UPDATE ${quoteTable(this.entity.table, this.executor.dialect)} SET ${assignments.join(", ")} WHERE ${predicates.join(" AND ")}${returning ? ` RETURNING ${this.entity.keys.map(q).join(", ")}` : ""}`, compiler.parameters);
    if (!version && result.affectedRows === 0 && (this.executor.dialect === "mysql" || this.executor.dialect === "mariadb")) {
      const key: Partial<T> = {};
      for (const property of this.entity.keys) key[property] = instance[property];
      const persisted = await this.find(key);
      if (persisted) return persisted;
    }
    assertAffected(returning ? result.rows.length : result.affectedRows, this.entity);
    const key: Partial<T> = {};
    for (const property of this.entity.keys) key[property] = instance[property];
    const persisted = await this.find(key);
    if (!persisted) throw new Error("The updated entity's primary key was changed or removed by a trigger");
    if (version) checkVersion(persisted[version]);
    return persisted;
  }
  public async delete(instance: T): Promise<void> {
    const candidate = cloneInput(this.entity, instance) as T;
    await this.runTransaction(repository => repository.deleteCore(candidate));
  }
  private async runTransaction<R>(callback: (repository: Repository<T>) => Promise<R>): Promise<R> {
    return this.transactionBound ? callback(this) : this.executor.transaction(executor => callback(Repository.inTransaction(executor, this.entity)));
  }
  private async assertDeleted(instance: T): Promise<void> {
    const key: Partial<T> = {};
    for (const property of this.entity.keys) key[property] = instance[property];
    if (await this.find(key)) throw new Error("The delete trigger retained or recreated the entity; the delete was rolled back");
  }
  private async deleteCore(instance: T): Promise<void> {
    entityKey(this.entity, instance);
    const compiler = new SqlCompiler(this.executor.dialect);
    const q = (key: keyof T & string): string => quoteIdentifier(this.entity.columns[key].name ?? key, this.executor.dialect);
    const predicates = this.entity.keys.map(key => `${q(key)} = ${compiler.bind(encode(this.entity, key, instance[key]))}`);
    if (this.entity.version) { checkVersion(instance[this.entity.version]); predicates.push(`${q(this.entity.version)} = ${compiler.bind(encode(this.entity, this.entity.version, instance[this.entity.version]))}`); }
    if (this.executor.dialect === "mssql") {
      const capture = mssqlCapture(this.entity, true);
      const result = await this.executor.execute(`${capture.prefix}DELETE FROM ${quoteTable(this.entity.table, "mssql")}${capture.output} WHERE ${predicates.join(" AND ")}${capture.finish}`, compiler.parameters);
      assertAffected(result.rows.length, this.entity);
      await this.assertDeleted(instance);
      return;
    }
    const returning = this.executor.dialect === "sqlite" || this.executor.dialect === "postgresql";
    const result = await this.executor.execute(`DELETE FROM ${quoteTable(this.entity.table, this.executor.dialect)} WHERE ${predicates.join(" AND ")}${returning ? ` RETURNING ${this.entity.keys.map(q).join(", ")}` : ""}`, compiler.parameters);
    assertAffected(returning ? result.rows.length : result.affectedRows, this.entity);
    await this.assertDeleted(instance);
  }
  private async insertCore(values: Partial<T>): Promise<T> {
    const input: Partial<T> = { ...values };
    const version = this.entity.version;
    if (version && input[version] === undefined) (input as Record<string, unknown>)[version] = 1;
    if (version) checkVersion(input[version]);
    for (const key of Object.keys(values)) if (!Object.hasOwn(this.entity.columns, key)) throw new Error(`Unknown entity column ${key}`);
    const generated = this.entity.generatedKeys.filter(key => input[key] === undefined);
    const columns = entries(this.entity).filter(([key]) => !generated.includes(key));
    const compiler = new SqlCompiler(this.executor.dialect);
    const q = (name: string): string => quoteIdentifier(name, this.executor.dialect);
    const table = quoteTable(this.entity.table, this.executor.dialect);
    if (generated.length > 1 && this.executor.dialect === "mysql") throw new Error("MySQL can return only one generated AUTO_INCREMENT key per insert");
    const columnSql = columns.map(([key, column]) => q(column.name ?? key)).join(", ");
    const bindings = columns.map(([key]) => compiler.bind(encode(this.entity, key, input[key]))).join(", ");
    const returningKeys = this.entity.keys.map(key => `${q(this.entity.columns[key].name ?? key)} AS ${q(key)}`).join(", ");
    let sql = `INSERT INTO ${table}${columns.length ? ` (${columnSql})` : ""}`;
    if (this.executor.dialect === "mssql") {
      const capture = mssqlCapture(this.entity);
      sql = `${capture.prefix}${sql}${capture.output}${columns.length ? ` VALUES (${bindings})` : " DEFAULT VALUES"}${capture.finish}`;
      const result = await this.executor.execute(sql, compiler.parameters);
      if (result.rows.length !== 1) throw new Error("Inserted primary keys could not be read after triggers; the insert was rolled back");
      return decode(this.entity, result.rows[0]!);
    }
    if (this.executor.dialect === "oracle" && !columns.length) sql += ` (${q(this.entity.columns[this.entity.keys[0]!].name ?? this.entity.keys[0]!)}) VALUES (DEFAULT)`;
    else {
      sql += columns.length ? ` VALUES (${bindings})` : (this.executor.dialect === "mysql" || this.executor.dialect === "mariadb") ? " () VALUES ()" : " DEFAULT VALUES";
    }
    if (this.executor.dialect === "oracle" && generated.length) {
      if (!this.executor.executeWithOutput) throw new Error("The Oracle transport must support output bindings to return generated keys");
      const outputs: SqlOutputParameter[] = generated.map(key => this.entity.columns[key].generatedOutput ?? { type: "decimal", size: 128 });
      sql += ` RETURNING ${generated.map(key => q(this.entity.columns[key].name ?? key)).join(", ")} INTO ${generated.map((_, index) => `:p${compiler.parameters.length + index + 1}`).join(", ")}`;
      const result = await this.executor.executeWithOutput(sql, compiler.parameters, outputs);
      if (result.output.length !== generated.length || result.output.some(value => value === null || value === undefined)) throw new Error("The Oracle provider did not return every generated key");
      const key: Partial<T> = {};
      for (const property of this.entity.keys) key[property] = input[property];
      for (const [index, property] of generated.entries()) {
        const column = this.entity.columns[property];
        (key as Record<string, unknown>)[property] = column.decode ? column.decode(result.output[index]) : result.output[index];
      }
      const persisted = await this.find(key);
      if (!persisted) throw new Error("Generated Oracle primary keys could not be read after triggers");
      return persisted;
    }
    if (this.executor.dialect === "sqlite" || this.executor.dialect === "postgresql" || this.executor.dialect === "mariadb") sql += ` RETURNING ${returningKeys}`;
    const result = await this.executor.execute(sql, compiler.parameters);
    if (result.rows[0]) {
      if (result.rows.length !== 1) throw new Error("The insert did not return one unique primary key");
      const key: Partial<T> = {};
      for (const property of this.entity.keys) {
        const column = this.entity.columns[property];
        (key as Record<string, unknown>)[property] = column.decode ? column.decode(result.rows[0][property]) : result.rows[0][property];
      }
      const persisted = await this.find(key);
      if (!persisted) throw new Error("Inserted primary keys could not be read after triggers");
      return persisted;
    }
    if (generated.length) {
      if (result.insertId === undefined) throw new Error("The SQL provider did not return the generated primary key");
      const property = generated[0]!;
      const column = this.entity.columns[property] as { decode?: (value: unknown) => unknown };
      (input as Record<string, unknown>)[property] = column.decode ? column.decode(result.insertId) : result.insertId;
    }
    const key: Partial<T> = {};
    for (const property of this.entity.keys) key[property] = input[property];
    const persisted = await this.find(key);
    if (!persisted) throw new Error("The inserted entity could not be read back");
    return persisted;
  }
}
function cloneInput<T extends object>(entity: Entity<T>, input: Partial<T>): Partial<T> {
  const result: Record<string, unknown> = {};
  for (const property of Object.keys(input)) {
    if (!Object.hasOwn(entity.columns, property)) throw new Error(`Unknown entity column ${property}`);
    const key = property as keyof T & string;
    if (input[key] === undefined) { result[key] = undefined; continue; }
    const encoded = encode(entity, key, input[key]);
    const copied = encoded instanceof Date ? new Date(encoded.getTime()) : encoded instanceof Uint8Array ? encoded.slice() : encoded;
    const column = entity.columns[key];
    result[key] = column.decode ? column.decode(copied) : copied;
  }
  return result as Partial<T>;
}
export function keyPredicate<T extends object>(entity: Entity<T>, key: Partial<T>, scope: Fields<T>): SqlExpression<boolean | null> {
  return and(...entity.keys.map(property => scope[property].eq(key[property] as T[typeof property])));
}
function validateKey<T extends object>(entity: Entity<T>, key: Partial<T>): void {
  entityKey(entity, key);
  if (Object.keys(key).some(property => !entity.keys.includes(property as keyof T & string))) throw new Error("find accepts only declared primary key properties");
}
function assertAffected<T extends object>(affected: number, entity: Entity<T>): void {
  if (affected === 0) throw entity.version ? new OptimisticLockError(entity.table) : new EntityNotFoundError(entity.table);
  if (affected !== 1) throw new Error("Entity keys must correspond to a unique database constraint");
}
function checkVersion(input: unknown): asserts input is number {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < 0 || input === Number.MAX_SAFE_INTEGER) throw new TypeError("Optimistic version must be a nonnegative safe integer with room to increment");
}

export interface Relation<A extends object, B extends object> {
  readonly source: Entity<A>;
  readonly target: Entity<B>;
  readonly keys: readonly (readonly [keyof A & string, keyof B & string])[];
}
/** Explicit batched eager loading. Composite relation keys use OR/AND; no hidden lazy loading. */
export async function loadRelation<A extends object, B extends object>(executor: SqlExecutor, relation: Relation<A, B>, owners: readonly A[], options: { readonly batchSize?: number } = {}): Promise<Map<A, B[]>> {
  if (!relation.keys.length) throw new Error("A relation must contain at least one key pair");
  for (const [source, target] of relation.keys) if (!Object.hasOwn(relation.source.columns, source) || !Object.hasOwn(relation.target.columns, target)) throw new Error("Unknown relation key");
  const maxSize = Math.floor(500 / relation.keys.length);
  const batchSize = options.batchSize ?? maxSize;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > maxSize) throw new Error("Relation batches must bind at most 500 parameters");
  const output = new Map(owners.map(owner => [owner, [] as B[]]));
  const unique = new Map<string, A[]>();
  for (const owner of owners) {
    const values = relation.keys.map(([source]) => encode(relation.source, source, owner[source]));
    if (values.some(value => value === null)) continue;
    const key = relationKey(values);
    const existing = unique.get(key) ?? [];
    existing.push(owner);
    unique.set(key, existing);
  }
  const groups = [...unique.values()];
  for (let start = 0; start < groups.length; start += batchSize) {
    const batch = groups.slice(start, start + batchSize);
    const targets = await Query.from(executor, relation.target).where(scope => or(...batch.map(group => and(...relation.keys.map(([source, target]) => {
      const owner = group[0]!;
      const input = encode(relation.source, source, owner[source]);
      // Source encodings may differ from target model types; bind the encoded source representation directly.
      return new Expr<boolean>({ kind: "binary", operator: "=", left: scope[target].node, right: { kind: "value", value: input } });
    }))))).toList();
    for (const target of targets) {
      const values = relation.keys.map(([, property]) => encode(relation.target, property, target[property]));
      if (values.some(value => value === null)) continue;
      const key = relationKey(values);
      for (const owner of unique.get(key) ?? []) output.get(owner)!.push(target);
    }
  }
  return output;
}
function relationKey(values: readonly SqlValue[]): string {
  return JSON.stringify(values.map(input => input instanceof Date ? ["date", input.toISOString()] : input instanceof Uint8Array ? ["bytes", Array.from(input)] : [typeof input, typeof input === "bigint" ? input.toString() : input]));
}
