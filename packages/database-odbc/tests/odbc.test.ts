import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { OdbcError, OdbcTransport } from "../src/index.ts";
import { positionalParameters } from "../src/parameters.ts";
import { decodeValue, encodeValue } from "../src/wire.ts";

const windows = process.platform === "win32";
const fixture = (options: Partial<ConstructorParameters<typeof OdbcTransport>[0]> = {}) => new OdbcTransport({ dialect: "mssql", connectionString: "secret", workerScript: join(import.meta.dir, "fixture.ps1"), ...options });
async function rejected(promise: Promise<unknown>): Promise<Error> {
  try { await promise; } catch (error) { if (error instanceof Error) return error; throw error; }
  throw new Error("Expected promise rejection");
}

describe("ODBC parameter compiler", () => {
  test("respects strings, comments, quoted identifiers and repeated/out-of-order markers", () => {
    const sql = "SELECT '@p1', [@p1], \"@p2\", `@p1`, @@p1, column@p1, @p2, @p1, @p2 /* @p1 /* :p2 */ */ -- @p1\n";
    const result = positionalParameters(sql, ["first", "second"]);
    expect(result.sql).toBe("SELECT '@p1', [@p1], \"@p2\", `@p1`, @@p1, column@p1, ?, ?, ? /* @p1 /* :p2 */ */ -- @p1\n");
    expect(result.parameters).toEqual(["second", "first", "second"]);
    expect(positionalParameters("SELECT q'[it's :p1]', Q'{:p1}', q'!:p1!', :p1 FROM dual", ["bound"]).parameters).toEqual(["bound"]);
    expect(positionalParameters("SELECT ?", [null]).parameters).toEqual([null]);
  });
  test("rejects missing, unused or mixed parameters and unterminated tokens", () => {
    expect(() => positionalParameters("SELECT @p2", [1])).toThrow("Missing");
    expect(() => positionalParameters("SELECT @p1", [1, 2])).toThrow("Unused");
    expect(() => positionalParameters("SELECT @p1, ?", [1])).toThrow("mix");
    expect(() => positionalParameters("SELECT ':p1", [1])).toThrow("Unterminated");
    expect(() => positionalParameters("/*", [])).toThrow("Unterminated");
  });
  test("codecs keep precision, bytes and null", () => {
    const values = [null, true, 9_223_372_036_854_775_807n, new Uint8Array([0, 255]), "España", 0.25] as const;
    for (const value of values) expect(decodeValue(encodeValue(value))).toEqual(value);
    expect(decodeValue({ type: "decimal", value: "99999999999999999999999999999999999999" })).toBe("99999999999999999999999999999999999999");
    expect(encodeValue(new Date("2026-01-01T01:02:03.123Z"))).toEqual({ type: "date", value: "2026-01-01T01:02:03.123Z" });
    expect(() => encodeValue(2n ** 63n)).toThrow("range");
    expect(() => encodeValue(Number.MAX_SAFE_INTEGER + 1)).toThrow("bigint");
    expect(() => encodeValue(NaN)).toThrow("finite");
    expect(() => decodeValue({ type: "binary", value: "corrupt" })).toThrow("binary");
  });
});

describe.skipIf(!windows)("original subprocess protocol", () => {
  test("output descriptors stay separate from values and preserve returned precision", async () => {
    const transport = fixture({ maxConnections: 1 });
    await transport.connect();
    const session = await transport.reserve();
    try {
      const result = await session.executeWithOutput!("BEGIN :p2 := :p1; END;", ["input"], [{ type: "decimal", size: 128 }]);
      expect(result.output).toEqual(["12345678901234567890123456789012345678"]);
      expect(result.rows[0]!["sql"]).toBe("BEGIN ? := ?; END;");
      expect((await rejected(session.executeWithOutput!("BEGIN :p1 := :p1; END;", [], [{ type: "string" }]))).message).toContain("exactly once");
      expect((await rejected(session.executeWithOutput!("BEGIN :p1 := NULL; END;", [], [{ type: "string", size: 0 }]))).message).toContain("size");
    } finally { await session.release(); await transport.close(); }
  }, 15_000);
  test("bound values are sent out of command-line, workers pin and reset sessions", async () => {
    const transport = fixture({ maxConnections: 2 });
    await transport.connect();
    try {
      const first = await transport.reserve();
      const second = await transport.reserve();
      const input = ["a'; DROP TABLE users; --", 9_223_372_036_854_775_807n, new Uint8Array([0, 255]), null, true] as const;
      const result = await first.execute("SELECT @p1, @p2, @p3, @p4, @p5", input);
      const row = result.rows[0]!;
      expect(row["sql"]).toBe("SELECT ?, ?, ?, ?, ?");
      for (let index = 0; index < input.length; index++) expect(row[`p${index}`]).toEqual(input[index]);
      expect(row["exactDecimal"]).toBe("12345678901234567890123456789012345678");
      expect((await second.execute("SELECT")).rows[0]!["pid"]).not.toBe(row["pid"]);
      await first.execute("BEGIN");
      expect((await first.execute("SELECT")).rows[0]!["transaction"]).toBe(true);
      await first.release();
      const third = await transport.reserve();
      expect((await third.execute("SELECT")).rows[0]!["transaction"]).toBe(false);
      await third.release(); await second.release();
      expect((await rejected(first.execute("SELECT"))).message).toContain("session_released");
    } finally { await transport.close(); }
  }, 20_000);
  test("bounds queue, times out reservations and rejects closing waiters", async () => {
    const transport = fixture({ maxConnections: 1, maxPendingReservations: 1, reservationTimeoutMs: 50, shutdownTimeoutMs: 100 });
    await transport.connect();
    const held = await transport.reserve();
    const waiting = transport.reserve();
    expect((await rejected(transport.reserve())).message).toContain("pool_queue_full");
    expect((await rejected(waiting)).message).toContain("reservation_timeout");
    const closingWaiter = transport.reserve();
    const closed = transport.close(); expect((await rejected(closingWaiter)).message).toContain("closing");
    await held.release(); await closed;
    expect((await rejected(transport.reserve())).message).toContain("not_connected");
  }, 15_000);
  test("crashed worker is replaced and errors expose codes without provider messages", async () => {
    const transport = fixture({ maxConnections: 1 });
    await transport.connect();
    try {
      const first = await transport.reserve();
      const pid = (await first.execute("SELECT")).rows[0]!["pid"];
      try { await first.execute("provider_error"); throw new Error("Expected rejection"); } catch (error) {
        expect(error).toBeInstanceOf(OdbcError);
        expect((error as OdbcError).sqlState).toBe("42000");
        expect(String(error)).not.toContain("password");
      }
      expect((await rejected(first.execute("crash"))).message).toContain("worker_exited");
      await first.release();
      const next = await transport.reserve();
      expect((await next.execute("SELECT")).rows[0]!["pid"]).not.toBe(pid);
      expect((await rejected(next.execute("badframe"))).message).toContain("invalid_protocol");
      await next.release();
    } finally { await transport.close(); }
  }, 20_000);
  test("operations and abandonment have finite timeouts", async () => {
    const transport = fixture({ operationTimeoutMs: 1500, shutdownTimeoutMs: 50, maxConnections: 1 });
    await transport.connect();
    const session = await transport.reserve();
    expect((await rejected(session.execute("hang"))).message).toContain("operation_timeout");
    await session.release(); await transport.close();
  }, 10_000);
  test("real System.Data.Odbc returns a redacted native missing DSN error", async () => {
    const transport = new OdbcTransport({ dialect: "oracle", connectionString: "DSN=Bolt_NoSuchDsn_20261003;UID=private_user;PWD=private_password", operationTimeoutMs: 15_000 });
    try {
      expect((await rejected(transport.connect())).message).toContain("SQLSTATE IM002");
      expect((await rejected(transport.reserve())).message).toContain("not_connected");
    } finally { await transport.close(); }
  }, 20_000);
});
