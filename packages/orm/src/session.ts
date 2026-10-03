import type { SqlExecutor, SqlValue } from "@bolt/database";
import { SqlPostCommitError } from "@bolt/database";
import { isDeepStrictEqual } from "node:util";
import { encode, entityKey, entries, keyValue, type Entity } from "./entity.ts";
import { Query } from "./query.ts";
import { Repository } from "./repository.ts";
import { assertWritable, OrmReconciliationError, publish } from "./mutations.ts";

type Model = Record<string, unknown>;
interface Tracked {
  readonly entity: Entity<Model>;
  readonly instance: Model;
  readonly key?: string;
  readonly original: Map<string, SqlValue>;
  state: "clean" | "new" | "removed";
}
export interface FlushResult { readonly inserted: number; readonly updated: number; readonly deleted: number; }
interface RollbackProperty { readonly present: boolean; readonly value: unknown; readonly managed: boolean; published?: unknown; hasPublished: boolean; }
interface PreparedChange { readonly entry: Tracked; readonly persisted?: Model; readonly publishedSnapshot?: Model; readonly saved?: Tracked; }
interface PreparedFlush { readonly changes: readonly PreparedChange[]; readonly identities: Map<Entity<Model>, Map<string, Tracked>>; }

/** Request-scoped identity map and explicit unit of work. dispose() never writes data. */
export class OrmSession {
  readonly #tracked = new Set<Tracked>();
  #identities = new Map<Entity<Model>, Map<string, Tracked>>();
  readonly #executor: SqlExecutor;
  #disposed = false;
  #flushing = false;
  #rollbackManaged?: Map<Model, Map<string, RollbackProperty>>;
  public constructor(private readonly database: SqlExecutor) {
    this.#executor = {
      dialect: database.dialect,
      execute: (sql, parameters) => { this.assertOpen(); return database.execute(sql, parameters); },
      transaction: (callback, options) => { this.assertOpen(); return database.transaction(callback, options); },
      ...(database.executeWithOutput ? { executeWithOutput: (sql, parameters, outputs) => { this.assertOpen(); return database.executeWithOutput!(sql, parameters, outputs); } } satisfies Pick<SqlExecutor, "executeWithOutput"> : {}),
    };
  }
  /** Bind a session to a transaction. Flush explicitly; callback/commit failure restores managed keys and versions. */
  public static async transaction<T>(database: SqlExecutor, callback: (session: OrmSession) => Promise<T>): Promise<T> {
    let session: OrmSession | undefined;
    let callbackCompleted = false;
    try {
      return await database.transaction(async executor => {
        session = new OrmSession(executor);
        session.#rollbackManaged = new Map();
        const result = await callback(session);
        if (session.#flushing) throw new Error("Transaction callbacks must await session.flush()");
        callbackCompleted = true;
        return result;
      });
    } catch (error) {
      if (session && !(callbackCompleted && error instanceof SqlPostCommitError)) for (const [instance, properties] of session.#rollbackManaged ?? []) {
        for (const [key, original] of properties) {
          if (original.hasPublished && (original.managed || isDeepStrictEqual(instance[key], original.published))) {
            const descriptor = Object.getOwnPropertyDescriptor(instance, key);
            if (original.present) Object.defineProperty(instance, key, { ...descriptor, value: original.value }); else delete instance[key];
          }
        }
      }
      throw error;
    } finally { session?.dispose(); }
  }
  public query<T extends object>(entity: Entity<T>): Query<T> {
    this.assertOpen();
    return Query.from(this.#executor, entity, instance => this.attach(entity, instance));
  }
  public async find<T extends object>(entity: Entity<T>, key: Partial<T>): Promise<T | null> {
    this.assertOpen();
    if (Object.keys(key).some(property => !entity.keys.includes(property as keyof T & string))) throw new Error("find accepts only declared primary key properties");
    const erased = entity as unknown as Entity<Model>;
    const entry = this.#identities.get(erased)?.get(entityKey(entity, key));
    if (entry) return entry.state === "removed" ? null : entry.instance as T;
    return new Repository(this.#executor, entity, instance => this.attach(entity, instance)).find(key);
  }
  /** Existing identity wins; repeated reads cannot overwrite unflushed local edits. */
  public attach<T extends object>(entity: Entity<T>, instance: T): T {
    this.assertOpen();
    const key = entityKey(entity, instance);
    const erased = entity as unknown as Entity<Model>;
    const identities = this.#identities.get(erased) ?? new Map<string, Tracked>();
    const existing = identities.get(key);
    if (existing) {
      if (existing.state === "removed") throw new Error("A removed entity cannot be materialized in this session");
      return existing.instance as T;
    }
    const entry: Tracked = { entity: erased, instance: instance as Model, key, original: snapshot(erased, instance as Model), state: "clean" };
    identities.set(key, entry);
    this.#identities.set(erased, identities);
    this.#tracked.add(entry);
    return instance;
  }
  /** Queue an insert. Generated keys/version defaults are assigned to this object only after flush commits. */
  public add<T extends object>(entity: Entity<T>, instance: Partial<T>): void {
    this.assertOpen();
    if (Object.keys(instance).some(property => !Object.hasOwn(entity.columns, property))) throw new Error("An inserted instance contains an unknown entity column");
    if ([...this.#tracked].some(entry => entry.instance === instance)) throw new Error("The instance is already tracked");
    const erased = entity as unknown as Entity<Model>;
    if (entity.keys.every(key => instance[key] !== undefined && instance[key] !== null) && this.#identities.get(erased)?.has(entityKey(entity, instance))) throw new Error("The session already contains this primary key");
    this.#tracked.add({ entity: erased, instance: instance as Model, original: new Map(), state: "new" });
  }
  public remove<T extends object>(entity: Entity<T>, instance: T): void {
    this.assertOpen();
    const entry = [...this.#tracked].find(item => item.entity === entity as unknown as Entity<Model> && item.instance === instance);
    if (entry?.state === "new") { this.#tracked.delete(entry); return; }
    this.attach(entity, instance);
    const tracked = this.#identities.get(entity as unknown as Entity<Model>)!.get(entityKey(entity, instance))!;
    if (tracked.instance !== instance) throw new Error("Remove the canonical instance held by this session");
    tracked.state = "removed";
  }
  public detach<T extends object>(entity: Entity<T>, instance: T): void {
    this.assertOpen();
    const erased = entity as unknown as Entity<Model>;
    for (const entry of this.#tracked) if (entry.entity === erased && entry.instance === instance) {
      this.#tracked.delete(entry);
      if (entry.key) this.#identities.get(erased)?.delete(entry.key);
    }
  }
  public async flush(): Promise<FlushResult> {
    this.assertOpen();
    if (this.#flushing) throw new Error("A session flush is already in progress");
    this.#flushing = true;
    try {
      const plans = [...this.#tracked].map(entry => {
        if (entry.state !== "removed") assertWritable(entry.entity, entry.instance);
        return { entry, candidate: cloneModel(entry.entity, entry.instance), before: fingerprint(entry.entity, entry.instance), dirty: dirtyColumns(entry), state: entry.state };
      });
      if (this.#rollbackManaged) for (const { entry, candidate } of plans) {
        if (!this.#rollbackManaged.has(entry.instance)) {
          this.#rollbackManaged.set(entry.instance, new Map(entries(entry.entity).map(([key]) => [key, { present: Object.hasOwn(entry.instance, key), value: candidate[key], managed: entry.entity.keys.includes(key) || key === entry.entity.version, hasPublished: false }])));
        }
      }
      const counts = { inserted: 0, updated: 0, deleted: 0 };
      if (plans.every(plan => plan.state === "clean" && !plan.dirty.length)) return counts;
      let committed: PreparedFlush | undefined;
      let cleanupError: SqlPostCommitError | undefined;
      try { committed = await this.database.transaction(async executor => {
        const changes: PreparedChange[] = [];
        for (const { entry, candidate, dirty, state } of plans) {
          const repository = Repository.inTransaction(executor, entry.entity);
          if (state === "new") { changes.push(prepare(entry, await repository.insert(candidate))); counts.inserted++; }
          else if (state === "removed") { await repository.delete(candidate); changes.push({ entry }); counts.deleted++; }
          else if (dirty.length) { changes.push(prepare(entry, await repository.update(candidate, dirty))); counts.updated++; }
        }
        for (const { entry, before } of plans) {
          if (fingerprint(entry.entity, entry.instance) !== before) throw new Error("Tracked entities must not be mutated during flush");
          if (entry.state !== "removed") assertWritable(entry.entity, entry.instance);
        }
        // Codec evaluation, key conflicts and all replacement snapshots must succeed before COMMIT.
        const identities = new Map([...this.#identities].map(([entity, map]) => [entity, new Map(map)]));
        for (const { entry } of changes) if (entry.key) identities.get(entry.entity)?.delete(entry.key);
        for (const { entry, saved } of changes) if (saved) {
          const map = identities.get(entry.entity) ?? new Map<string, Tracked>();
          if (map.has(saved.key!)) throw new Error("Conflicting identity produced by an insert");
          map.set(saved.key!, saved); identities.set(entry.entity, map);
        }
        committed = { changes, identities };
        return committed;
      }); }
      catch (error) { if (error instanceof SqlPostCommitError && committed) cleanupError = error; else throw error; }
      if (!committed) throw new Error("Flush did not produce reconciled state");
      try {
        for (const { entry, persisted } of committed.changes) if (persisted) assertWritable(entry.entity, entry.instance);
        // No codecs, identity computations or user-defined setters run after COMMIT.
        for (const { entry, persisted, publishedSnapshot } of committed.changes) if (persisted) {
          publish(entry.entity, entry.instance, persisted);
          for (const [key, property] of this.#rollbackManaged?.get(entry.instance) ?? []) { property.published = publishedSnapshot![key]; property.hasPublished = true; }
        }
      } catch (cause) {
        this.#tracked.clear(); this.#identities.clear(); this.#disposed = true;
        throw new OrmReconciliationError(cause);
      }
      for (const { entry, saved } of committed.changes) {
        this.#tracked.delete(entry);
        if (saved) this.#tracked.add(saved);
      }
      this.#identities = committed.identities;
      if (cleanupError) throw cleanupError;
      return counts;
    } finally { this.#flushing = false; }
  }
  public dispose(): void {
    if (this.#flushing) throw new Error("Cannot dispose a session while flushing");
    this.#tracked.clear(); this.#identities.clear(); this.#disposed = true;
  }
  private assertOpen(): void {
    if (this.#disposed) throw new Error("The ORM session is disposed");
    if (this.#flushing) throw new Error("The ORM session cannot be accessed while flushing; await flush first");
  }
}

function snapshot(entity: Entity<Model>, instance: Model): Map<string, SqlValue> {
  return new Map(entries(entity).map(([key]) => [key, cloneValue(encode(entity, key, instance[key]))]));
}
function cloneValue(input: SqlValue): SqlValue { return input instanceof Date ? new Date(input.getTime()) : input instanceof Uint8Array ? input.slice() : input; }
function cloneModel(entity: Entity<Model>, instance: Model): Model {
  const result: Model = {};
  for (const [key, column] of entries(entity)) {
    if (instance[key] === undefined && (entity.generatedKeys.includes(key) || key === entity.version)) continue;
    const input = cloneValue(encode(entity, key, instance[key]));
    result[key] = column.decode ? column.decode(input) : input;
  }
  return result;
}
function prepare(entry: Tracked, persisted: Model): PreparedChange {
  const key = entityKey(entry.entity, persisted);
  const original = snapshot(entry.entity, persisted);
  return { entry, persisted, publishedSnapshot: cloneModel(entry.entity, persisted), saved: { ...entry, key, original, state: "clean" } };
}
function sameValue(left: SqlValue, right: SqlValue): boolean { return JSON.stringify(keyValue(left)) === JSON.stringify(keyValue(right)); }
function dirtyColumns(entry: Tracked): string[] {
  if (entry.state === "new") return [];
  if (entityKey(entry.entity, entry.instance) !== entry.key) throw new Error("A tracked primary key cannot be changed; detach and explicitly insert a new identity");
  const dirty: string[] = [];
  for (const [key] of entries(entry.entity)) {
    const changed = !sameValue(encode(entry.entity, key, entry.instance[key]), entry.original.get(key)!);
    if (key === entry.entity.version && changed) throw new Error("The optimistic version is managed by the ORM");
    if (changed && !entry.entity.keys.includes(key)) dirty.push(key);
  }
  return dirty;
}
function fingerprint(entity: Entity<Model>, instance: Model): string {
  return JSON.stringify(entries(entity).map(([key]) => instance[key] === undefined ? [key, "undefined"] : [key, keyValue(encode(entity, key, instance[key]))]));
}
