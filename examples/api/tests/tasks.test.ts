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
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-request-id")).toBeTruthy();
    expect(await response.json()).toMatchObject({
      application: "Bolt Tasks Test",
      database: "up",
      status: "ok",
    });
  });

  test("answers CORS preflight before invoking a route", async () => {
    const client = createClient();
    await client.get("/health");
    const origin = client.application.url.origin;
    const response = await client.options("/api/tasks", {
      headers: {
        "access-control-request-method": "POST",
        origin,
      },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      origin,
    );
    expect(response.headers.get("access-control-allow-methods")).toContain(
      "POST",
    );
  });

  test("issues CSRF tokens and stores signed sessions", async () => {
    const client = createClient();
    const csrfResponse = await client.get("/api/security/csrf");
    const { token } = await csrfResponse.json() as { token: string };
    const csrfCookie = cookiePair(csrfResponse);
    const login = await client.post("/api/security/session", {
      headers: {
        cookie: csrfCookie,
        "x-csrf-token": token,
      },
      json: { password: "test-password", username: "bolt" },
    });

    expect(login.status).toBe(200);
    expect(await login.json()).toEqual({ user: "bolt" });

    const session = await client.get("/api/security/session", {
      headers: { cookie: cookiePair(login) },
    });
    expect(await session.json()).toEqual({ user: "bolt" });
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
      demoPassword: "test-password",
      name: "Bolt Tasks Test",
      securitySecret: "test-secret-that-is-at-least-32-bytes-long",
    });
    const client = TestClient.create(application);
    clients.push(client);
    return client;
  }
});

function cookiePair(response: Response): string {
  const value = response.headers.get("set-cookie");

  if (!value) {
    throw new Error("Expected response to set a cookie");
  }

  return value.split(";", 1)[0]!;
}
