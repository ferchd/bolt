import { afterEach, describe, expect, test } from "bun:test";
import { TestClient } from "@bolt/testing";

import { createTaskApplication } from "../src/application.ts";

describe("task API", () => {
  const clients: TestClient[] = [];

  afterEach(async () => {
    await Promise.all(clients.map((client) => client.close()));
    clients.length = 0;
  });

  test("starts with a migrated database and reports health", async () => {
    const client = createClient();
    const response = await client.get("/health");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      application: "Bolt Tasks Test",
      database: "up",
      status: "ok",
    });
  });

  test("creates, lists and filters tasks", async () => {
    const client = createClient();
    const created = await client.post("/api/tasks", {
      json: { title: "  Ship Bolt MVP  " },
    });

    expect(created.status).toBe(201);
    expect(created.headers.get("location")).toBe("/api/tasks/1");
    expect(await created.json()).toMatchObject({
      completed: false,
      id: 1,
      title: "Ship Bolt MVP",
    });

    const all = await client.get("/api/tasks");
    expect(await all.json()).toMatchObject({
      data: [{ completed: false, id: 1, title: "Ship Bolt MVP" }],
    });

    const filtered = await client.get("/api/tasks", {
      query: { completed: true },
    });
    expect(await filtered.json()).toEqual({ data: [] });
  });

  test("validates request bodies and route parameters", async () => {
    const client = createClient();
    const invalidBody = await client.post("/api/tasks", {
      json: { title: "" },
    });
    const invalidId = await client.get("/api/tasks/not-a-number");

    expect(invalidBody.status).toBe(422);
    expect(await invalidBody.json()).toMatchObject({
      error: {
        code: "VALIDATION_ERROR",
        details: { issues: [{ path: ["title"] }] },
      },
    });
    expect(invalidId.status).toBe(422);
    expect(await invalidId.json()).toMatchObject({
      error: { code: "VALIDATION_ERROR" },
    });
  });

  test("updates, reads and deletes a task", async () => {
    const client = createClient();
    await client.post("/api/tasks", { json: { title: "Initial" } });

    const updated = await client.patch("/api/tasks/1", {
      json: { completed: true, title: "Released" },
    });
    expect(await updated.json()).toMatchObject({
      completed: true,
      id: 1,
      title: "Released",
    });

    const shown = await client.get("/api/tasks/1");
    expect(await shown.json()).toMatchObject({ completed: true, id: 1 });

    const deleted = await client.delete("/api/tasks/1");
    expect(deleted.status).toBe(204);

    const missing = await client.get("/api/tasks/1");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({
      error: {
        code: "TASK_NOT_FOUND",
        message: "Task 1 was not found",
      },
    });
  });

  function createClient(): TestClient {
    const { application } = createTaskApplication({
      application: {
        development: false,
        hostname: "127.0.0.1",
        port: 0,
        shutdownSignals: false,
      },
      databaseFilename: ":memory:",
      name: "Bolt Tasks Test",
    });
    const client = TestClient.create(application);
    clients.push(client);
    return client;
  }
});
