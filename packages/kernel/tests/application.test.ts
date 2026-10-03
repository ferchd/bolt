import { afterEach, describe, expect, test } from "bun:test";
import { Router } from "@bolt/router";

import { BoltApplication, Logger } from "../src/index.ts";
import type { ApplicationService } from "../src/index.ts";

describe("BoltApplication", () => {
  let application: BoltApplication | undefined;

  afterEach(async () => {
    await application?.stop();
  });

  test("creates a stopped application", () => {
    application = BoltApplication.create();

    expect(application.isRunning).toBe(false);
  });

  test("rejects unsafe HTTP server limits before startup", () => {
    expect(() =>
      BoltApplication.create({ server: { idleTimeout: 256 } }),
    ).toThrow("idleTimeout");
    expect(() =>
      BoltApplication.create({ server: { maxRequestBodySize: 0 } }),
    ).toThrow("maxRequestBodySize");
  });

  test("rejects invalid request id header names", () => {
    expect(() =>
      BoltApplication.create({ requests: { idHeader: "invalid header" } }),
    ).toThrow("idHeader");
  });

  test("starts an empty application", async () => {
    application = BoltApplication.create({ port: 0 });

    await application.start();

    expect(application.isRunning).toBe(true);
    expect(application.port).toBeGreaterThan(0);
  });

  test("does not start an application twice", async () => {
    application = BoltApplication.create({ port: 0 });

    const firstStart = await application.start();
    const secondStart = await application.start();

    expect(firstStart).toBe(application);
    expect(secondStart).toBe(application);
    expect(application.isRunning).toBe(true);
  });

  test("shares concurrent lifecycle transitions", async () => {
    application = BoltApplication.create({ port: 0 });
    const calls: string[] = [];
    application.use({
      async start() {
        calls.push("start");
        await Bun.sleep(5);
      },
      async stop() {
        calls.push("stop");
        await Bun.sleep(5);
      },
    });

    await Promise.all([application.start(), application.start()]);
    await Promise.all([application.stop(), application.stop()]);

    expect(calls).toEqual(["start", "stop"]);
    expect(application.state).toBe("stopped");
  });

  test("queues stop while the application is starting", async () => {
    application = BoltApplication.create({ port: 0 }).use({
      async start() {
        await Bun.sleep(5);
      },
    });

    const starting = application.start();
    const stopping = application.stop();

    await Promise.all([starting, stopping]);

    expect(application.state).toBe("stopped");
  });

  test("stops safely more than once", async () => {
    application = BoltApplication.create({ port: 0 });
    await application.start();

    await application.stop();
    await application.stop();

    expect(application.isRunning).toBe(false);
  });

  test("starts services in order and stops them in reverse", async () => {
    application = BoltApplication.create({ port: 0 });
    const calls: string[] = [];
    const first = createService("first", calls);
    const second = createService("second", calls);

    application.use(first).use(second);

    await application.start();
    await application.stop();

    expect(calls).toEqual([
      "start:first",
      "start:second",
      "stop:second",
      "stop:first",
    ]);
  });

  test("rolls back started services when startup fails", async () => {
    application = BoltApplication.create({ port: 0 });
    const calls: string[] = [];

    application.use(createService("first", calls)).use({
      start() {
        throw new Error("startup failed");
      },
    });

    await expect(application.start()).rejects.toThrow("startup failed");
    expect(calls).toEqual(["start:first", "stop:first"]);
    expect(application.state).toBe("stopped");
  });

  test("validates routes before starting services", async () => {
    const router = Router.create();
    let serviceStarts = 0;
    router.get("/duplicate", () => "first");
    router.get("/duplicate", () => "second");
    application = BoltApplication.create({
      router,
      shutdownSignals: false,
    }).use({
      start() {
        serviceStarts += 1;
      },
    });

    await expect(application.start()).rejects.toThrow(
      "Duplicate route: GET /duplicate",
    );

    expect(serviceStarts).toBe(0);
    expect(application.state).toBe("stopped");
  });

  test("prevents registering services while running", async () => {
    application = BoltApplication.create({ port: 0 });
    await application.start();

    expect(() => application?.use({})).toThrow(
      "Services can only be registered while Bolt is stopped",
    );
  });

  test("logs application lifecycle events", async () => {
    const output: string[] = [];
    const logger = Logger.create({
      format: "json",
      level: "info",
      writer: (line) => output.push(line),
    });
    application = BoltApplication.create({ logger, port: 0 });

    await application.start();
    await application.stop();

    expect(output.map((line) => JSON.parse(line))).toEqual([
      expect.objectContaining({
        level: "info",
        message: "Application started",
      }),
      expect.objectContaining({
        level: "info",
        message: "Application stopped",
      }),
    ]);
  });

  test("registers and removes graceful shutdown handlers", async () => {
    const listenersBefore = process.listenerCount("SIGTERM");
    application = BoltApplication.create({ port: 0 });

    await application.start();

    expect(process.listenerCount("SIGTERM")).toBe(listenersBefore + 1);

    await application.stop();

    expect(process.listenerCount("SIGTERM")).toBe(listenersBefore);
  });

  test("registers shutdown handlers while services are starting", async () => {
    const listenersBefore = process.listenerCount("SIGTERM");
    let releaseStart: () => void = () => undefined;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    application = BoltApplication.create({ port: 0 }).use({
      start: () => startGate,
    });

    const starting = application.start();
    await Bun.sleep(0);

    expect(application.state).toBe("starting");
    expect(process.listenerCount("SIGTERM")).toBe(listenersBefore + 1);

    releaseStart();
    await starting;
  });

  test("allows automatic signal handling to be disabled", async () => {
    const listenersBefore = process.listenerCount("SIGTERM");
    application = BoltApplication.create({
      port: 0,
      shutdownSignals: false,
    });

    await application.start();

    expect(process.listenerCount("SIGTERM")).toBe(listenersBefore);
  });

  test("removes shutdown handlers when startup logging fails", async () => {
    const listenersBefore = process.listenerCount("SIGTERM");
    const logger = Logger.create({
      level: "info",
      writer() {
        throw new Error("log sink failed");
      },
    });
    application = BoltApplication.create({ logger, port: 0 });

    await expect(application.start()).rejects.toThrow("log sink failed");

    expect(application.state).toBe("stopped");
    expect(process.listenerCount("SIGTERM")).toBe(listenersBefore);
  });
});

function createService(name: string, calls: string[]): ApplicationService {
  return {
    start() {
      calls.push(`start:${name}`);
    },
    stop() {
      calls.push(`stop:${name}`);
    },
  };
}
