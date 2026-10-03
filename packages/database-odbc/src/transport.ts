import { join } from "node:path";
import type { SqlOutputParameter, SqlOutputResult, SqlResult, SqlSession, SqlTransport, SqlValue } from "@bolt/database";
import { positionalParameters } from "./parameters.ts";
import { decodeValue, encodeValue } from "./wire.ts";

export interface OdbcTransportOptions {
  readonly dialect: "mssql" | "oracle";
  /** Never passed on the command line or included in errors. */
  readonly connectionString: string;
  readonly maxConnections?: number;
  readonly maxPendingReservations?: number;
  readonly reservationTimeoutMs?: number;
  readonly operationTimeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
  readonly commandTimeoutSeconds?: number;
  readonly maxRows?: number;
  readonly maxResponseBytes?: number;
  /** Trusted executable path. Defaults to bundled Windows PowerShell 5.1. */
  readonly powershellExecutable?: string;
  /** Trusted local worker path, intended for embedding and transport conformance testing. */
  readonly workerScript?: string;
}

export class OdbcError extends Error {
  readonly code: string;
  readonly sqlState?: string;
  readonly nativeCode?: number;
  constructor(code: string, sqlState?: string, nativeCode?: number) {
    super(`ODBC operation failed (${code}${sqlState ? `, SQLSTATE ${sqlState}` : ""})`);
    this.name = "OdbcError"; this.code = code; this.sqlState = sqlState; this.nativeCode = nativeCode;
  }
}

interface Options {
  dialect: "mssql" | "oracle";
  connectionString: string;
  executable: string;
  script: string;
  maxConnections: number;
  maxPending: number;
  reservationTimeout: number;
  operationTimeout: number;
  shutdownTimeout: number;
  commandTimeout: number;
  maxRows: number;
  maxResponseBytes: number;
}
interface Waiter { resolve: (value: SqlSession) => void; reject: (error: unknown) => void; timer: ReturnType<typeof setTimeout>; }

/** First-party .NET ODBC bridge. Each reservation owns one physical connection. */
export class OdbcTransport implements SqlTransport {
  readonly dialect: "mssql" | "oracle";
  readonly #options: Options;
  readonly #workers = new Set<Worker>();
  readonly #busy = new Set<Worker>();
  readonly #opening = new Set<Worker>();
  readonly #idle: Worker[] = [];
  readonly #waiters: Waiter[] = [];
  #state: "stopped" | "starting" | "running" | "closing" = "stopped";
  #connecting?: Promise<void>;
  #closing?: Promise<void>;
  #drained?: () => void;
  constructor(options: OdbcTransportOptions) {
    if (options.dialect !== "mssql" && options.dialect !== "oracle") throw new TypeError("ODBC transport supports mssql or oracle");
    if (!options.connectionString.trim()) throw new TypeError("ODBC connection string is required");
    if (process.platform !== "win32" && !options.powershellExecutable) throw new Error("ODBC transport requires Windows PowerShell or an explicitly configured pwsh with System.Data.Odbc");
    this.dialect = options.dialect;
    this.#options = {
      dialect: options.dialect, connectionString: options.connectionString,
      executable: options.powershellExecutable ?? join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      script: options.workerScript ?? join(import.meta.dir, "worker.ps1"),
      maxConnections: positive(options.maxConnections ?? 4, "maxConnections"),
      maxPending: positive(options.maxPendingReservations ?? 1_000, "maxPendingReservations"),
      reservationTimeout: positive(options.reservationTimeoutMs ?? 30_000, "reservationTimeoutMs"),
      operationTimeout: positive(options.operationTimeoutMs ?? 60_000, "operationTimeoutMs"),
      shutdownTimeout: positive(options.shutdownTimeoutMs ?? 10_000, "shutdownTimeoutMs"),
      commandTimeout: positive(options.commandTimeoutSeconds ?? 30, "commandTimeoutSeconds"),
      maxRows: positive(options.maxRows ?? 50_000, "maxRows"),
      maxResponseBytes: positive(options.maxResponseBytes ?? 32 * 1024 * 1024, "maxResponseBytes"),
    };
  }
  async connect(): Promise<void> {
    if (this.#state === "closing") throw new OdbcError("closing");
    if (this.#state === "running") return;
    if (this.#connecting) return this.#connecting;
    this.#state = "starting";
    this.#connecting = (async () => {
      try {
        const worker = this.newWorker();
        await worker.open();
        this.#idle.push(worker); this.#state = "running";
      } catch (error) {
        for (const worker of this.#workers) worker.kill();
        this.#workers.clear(); this.#idle.length = 0; this.#state = "stopped";
        throw error;
      }
    })().finally(() => { this.#connecting = undefined; });
    return this.#connecting;
  }
  async reserve(): Promise<SqlSession> {
    if (this.#state !== "running") throw new OdbcError("not_connected");
    if (this.#waiters.length >= this.#options.maxPending) throw new OdbcError("pool_queue_full");
    return new Promise<SqlSession>((resolve, reject) => {
      const waiter: Waiter = {
        resolve, reject,
        timer: setTimeout(() => {
          const index = this.#waiters.indexOf(waiter);
          if (index !== -1) { this.#waiters.splice(index, 1); reject(new OdbcError("reservation_timeout")); }
        }, this.#options.reservationTimeout),
      };
      this.#waiters.push(waiter); this.pump();
    });
  }
  async close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closing = (async () => {
      const starting = this.#state === "starting";
      this.#state = "closing";
      if (starting) for (const worker of this.#workers) worker.kill();
      if (this.#connecting) { try { await this.#connecting; } catch { /* Failed connections are already disposed. */ } }
      this.#state = "closing";
      for (const waiter of this.#waiters.splice(0)) { clearTimeout(waiter.timer); waiter.reject(new OdbcError("closing")); }
      if (this.#busy.size) await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { this.#drained = undefined; resolve(); }, this.#options.shutdownTimeout);
        this.#drained = () => { clearTimeout(timer); this.#drained = undefined; resolve(); };
      });
      // Reset/release already rolls back. Close rolls back any remaining abandoned leases.
      await Promise.allSettled([...this.#workers].map((worker) => worker.shutdown()));
      this.#workers.clear(); this.#idle.length = 0; this.#busy.clear(); this.#state = "stopped";
    })().finally(() => { this.#closing = undefined; });
    return this.#closing;
  }
  async [Symbol.asyncDispose](): Promise<void> { await this.close(); }
  private newWorker(): Worker {
    const worker = new Worker(this.#options, () => {
      this.#workers.delete(worker);
      const index = this.#idle.indexOf(worker);
      if (index !== -1) { this.#idle.splice(index, 1); this.pump(); }
    });
    this.#workers.add(worker); return worker;
  }
  private pump(): void {
    if (this.#state !== "running") return;
    while (this.#idle.length && this.#waiters.length) {
      const worker = this.#idle.shift()!;
      if (!worker.alive) continue;
      const waiter = this.#waiters.shift()!; clearTimeout(waiter.timer);
      this.#busy.add(worker);
      waiter.resolve(this.session(worker));
    }
    while (this.#waiters.length > this.#opening.size && this.#workers.size < this.#options.maxConnections) {
      let worker: Worker;
      try { worker = this.newWorker(); } catch (error) {
        const waiter = this.#waiters.shift()!; clearTimeout(waiter.timer); waiter.reject(error); continue;
      }
      this.#opening.add(worker);
      void worker.open().then(() => {
        this.#opening.delete(worker);
        if (this.#state === "running" && worker.alive) { this.#idle.push(worker); this.pump(); }
        else worker.kill();
      }, (error: unknown) => {
        this.#opening.delete(worker);
        // Reject before killing, so a permanent DSN failure cannot endlessly respawn workers.
        const waiter = this.#waiters.shift(); if (waiter) { clearTimeout(waiter.timer); waiter.reject(error); }
        worker.kill(); this.pump();
      });
    }
  }
  private session(worker: Worker): SqlSession {
    let active = true;
    let tail = Promise.resolve();
    let releasing: Promise<void> | undefined;
    const execute = <Row extends Record<string, unknown>>(sql: string, parameters: readonly SqlValue[] = [], output?: readonly SqlOutputParameter[]): Promise<SqlOutputResult<Row>> => {
        if (!active) return Promise.reject(new OdbcError("session_released"));
        const pending = tail.then(async () => {
          const bindings: object[] = parameters.map(encodeValue);
          for (const [index, specification] of (output ?? []).entries()) {
            if (!["string", "decimal", "number", "bigint", "binary", "date"].includes(specification.type)) throw new TypeError("Unsupported SQL output parameter type");
            const size = specification.size ?? 4000;
            if (!Number.isSafeInteger(size) || size < 1 || size > 1_048_576) throw new RangeError("Output parameter size must be 1..1048576");
            bindings.push({ type: "output", outputType: specification.type, size, index });
          }
          const bound = positionalParameters(sql, bindings);
          if (output?.length) {
            for (const binding of bindings.slice(parameters.length)) if (bound.parameters.filter(value => value === binding).length !== 1) throw new TypeError("Each output parameter must occur exactly once");
          }
          const result = await worker.call("execute", { sql: bound.sql, parameters: bound.parameters, outputCount: output?.length ?? 0 });
          if (!Array.isArray(result["rows"]) || typeof result["affectedRows"] !== "number" || !Number.isSafeInteger(result["affectedRows"]) || result["affectedRows"] < 0) { worker.kill(); throw new OdbcError("invalid_protocol"); }
          const rows = result["rows"].map((row: unknown) => {
            if (!row || typeof row !== "object" || Array.isArray(row)) { worker.kill(); throw new OdbcError("invalid_protocol"); }
            const decoded: Record<string, unknown> = {};
            try { for (const [name, value] of Object.entries(row)) Object.defineProperty(decoded, name, { value: decodeValue(value), writable: true, enumerable: true, configurable: true }); }
            catch { worker.kill(); throw new OdbcError("invalid_protocol"); }
            return decoded as Row;
          });
          let returned: readonly unknown[] = [];
          if (output?.length) {
            if (!Array.isArray(result["output"]) || result["output"].length !== output.length) { worker.kill(); throw new OdbcError("invalid_protocol"); }
            try { returned = result["output"].map(decodeValue); } catch { worker.kill(); throw new OdbcError("invalid_protocol"); }
          }
          return { rows, affectedRows: result["affectedRows"], output: returned } satisfies SqlOutputResult<Row>;
        });
        tail = pending.then(() => {}, () => {}); return pending;
    };
    return {
      execute: async <Row extends Record<string, unknown>>(sql: string, parameters: readonly SqlValue[] = []): Promise<SqlResult<Row>> => {
        const result = await execute<Row>(sql, parameters);
        return { rows: result.rows, affectedRows: result.affectedRows };
      },
      executeWithOutput: execute,
      invalidate: async () => { active = false; worker.kill(); await tail; },
      release: () => {
        if (releasing) return releasing;
        active = false;
        releasing = (async () => {
          await tail;
          try { if (worker.alive) await worker.call("reset"); } catch { worker.kill(); }
          this.#busy.delete(worker);
          if (this.#state === "running" && worker.alive) this.#idle.push(worker);
          if (!this.#busy.size) this.#drained?.();
          this.pump();
        })();
        return releasing;
      },
    };
  }
}

interface Pending { readonly id: number; readonly resolve: (value: Record<string, unknown>) => void; readonly reject: (error: unknown) => void; readonly timer: ReturnType<typeof setTimeout>; }
class Worker {
  readonly #options: Options;
  readonly #process: Bun.Subprocess<"pipe", "pipe", "ignore">;
  readonly #onFailure: () => void;
  #pending?: Pending;
  #sequence = 0;
  #alive = true;
  constructor(options: Options, onFailure: () => void) {
    this.#options = options; this.#onFailure = onFailure;
    try {
      this.#process = Bun.spawn([options.executable, "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", options.script], { stdin: "pipe", stdout: "pipe", stderr: "ignore", windowsHide: true });
    } catch { throw new OdbcError("worker_start_failed"); }
    void this.read();
    void this.#process.exited.then(() => this.fail(new OdbcError("worker_exited")));
  }
  get alive(): boolean { return this.#alive; }
  async open(): Promise<void> {
    await this.call("open", { connectionString: this.#options.connectionString, dialect: this.#options.dialect, commandTimeout: this.#options.commandTimeout, maxRows: this.#options.maxRows, maxResponseBytes: this.#options.maxResponseBytes });
  }
  call(operation: string, payload: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    if (!this.#alive) return Promise.reject(new OdbcError("worker_unavailable"));
    if (this.#pending) return Promise.reject(new OdbcError("concurrent_worker_operation"));
    return new Promise((resolve, reject) => {
      const id = ++this.#sequence;
      const timer = setTimeout(() => this.fail(new OdbcError("operation_timeout")), this.#options.operationTimeout);
      this.#pending = { id, resolve, reject, timer };
      try {
        this.#process.stdin.write(`${JSON.stringify({ id, operation, ...payload })}\n`);
        void Promise.resolve(this.#process.stdin.flush()).catch(() => this.fail(new OdbcError("worker_write_failed")));
      } catch { this.fail(new OdbcError("worker_write_failed")); }
    });
  }
  async shutdown(): Promise<void> {
    if (!this.#alive) return;
    // A timed-out close never waits for an unbounded operation; killing closes its ODBC connection.
    if (this.#pending) { this.kill(); return; }
    try {
      await Promise.race([this.call("close"), new Promise<void>((resolve) => {
        const timer = setTimeout(() => { this.kill(); resolve(); }, this.#options.shutdownTimeout);
        void this.#process.exited.finally(() => clearTimeout(timer));
      })]);
    } finally { this.kill(); }
    await this.#process.exited;
  }
  kill(): void { this.fail(new OdbcError("worker_closed")); }
  private fail(error: Error): void {
    if (!this.#alive) return;
    this.#alive = false;
    const pending = this.#pending; this.#pending = undefined;
    if (pending) { clearTimeout(pending.timer); pending.reject(error); }
    this.#process.kill(); this.#onFailure();
  }
  private async read(): Promise<void> {
    const reader = this.#process.stdout.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let buffer = "";
    let size = 0;
    try {
      while (this.#alive) {
        const chunk = await reader.read(); if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > this.#options.maxResponseBytes) throw new OdbcError("response_too_large");
        buffer += decoder.decode(chunk.value, { stream: true });
        let end: number;
        while ((end = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
          size = Buffer.byteLength(buffer);
          if (!line) continue;
          const message: unknown = JSON.parse(line);
          if (!message || typeof message !== "object" || Array.isArray(message)) throw new OdbcError("invalid_protocol");
          const frame = message as Record<string, unknown>;
          const pending = this.#pending;
          if (!pending || frame["id"] !== pending.id || typeof frame["ok"] !== "boolean") throw new OdbcError("invalid_protocol");
          clearTimeout(pending.timer); this.#pending = undefined;
          if (frame["ok"]) pending.resolve(frame);
          else {
            const code = typeof frame["code"] === "string" && /^[a-z_]{1,40}$/.test(frame["code"]) ? frame["code"] : "provider_error";
            const state = typeof frame["sqlState"] === "string" && /^[A-Z0-9]{5}$/.test(frame["sqlState"]) ? frame["sqlState"] : undefined;
            const nativeCode = typeof frame["nativeCode"] === "number" && Number.isSafeInteger(frame["nativeCode"]) ? frame["nativeCode"] : undefined;
            pending.reject(new OdbcError(code, state, nativeCode));
            if (frame["fatal"] === true) this.fail(new OdbcError("connection_broken"));
          }
        }
      }
      if (this.#alive) this.fail(new OdbcError("worker_exited"));
    } catch (error) { this.fail(error instanceof OdbcError ? error : new OdbcError("invalid_protocol")); }
    finally { reader.releaseLock(); }
  }
}

function positive(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) throw new RangeError(`${name} must be a positive integer <= 2147483647`);
  return value;
}
