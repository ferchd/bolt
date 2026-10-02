import { afterEach, describe, expect, test } from "bun:test";

import { BoltApplication } from "../src/index.ts";

describe("BoltApplication", () => {
  let application: BoltApplication | undefined;

  afterEach(async () => {
    await application?.stop();
  });

  test("creates a stopped application", () => {
    application = BoltApplication.create();

    expect(application.isRunning).toBe(false);
  });

  test("starts an empty application", async () => {
    application = BoltApplication.create();

    await application.start();

    expect(application.isRunning).toBe(true);
  });

  test("does not start an application twice", async () => {
    application = BoltApplication.create();

    const firstStart = await application.start();
    const secondStart = await application.start();

    expect(firstStart).toBe(application);
    expect(secondStart).toBe(application);
    expect(application.isRunning).toBe(true);
  });

  test("stops safely more than once", async () => {
    application = BoltApplication.create();
    await application.start();

    await application.stop();
    await application.stop();

    expect(application.isRunning).toBe(false);
  });
});
