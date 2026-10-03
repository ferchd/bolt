import { afterEach, describe, expect, test } from "bun:test";
import { BoltApplication } from "@bolt/kernel";
import { Router } from "@bolt/router";

import { TestClient } from "../src/index.ts";

describe("TestClient", () => {
  const clients: TestClient[] = [];
  const applications: BoltApplication[] = [];

  afterEach(async () => {
    await Promise.all(clients.map((client) => client.close()));
    await Promise.all(applications.map((application) => application.stop()));
    clients.length = 0;
    applications.length = 0;
  });

  test("creates and starts an application on an ephemeral port", async () => {
    const router = Router.create();
    router.get("/users", (context) => ({
      authorization: context.header("authorization"),
      roles: context.query.getAll("role"),
      search: context.query.get("search"),
    }));
    const client = TestClient.create({ router });
    clients.push(client);

    const response = await client.get("/users?search=bolt", {
      headers: { authorization: "Bearer test-token" },
      query: { ignored: undefined, role: ["admin", "author"] },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      authorization: "Bearer test-token",
      roles: ["admin", "author"],
      search: "bolt",
    });
    expect(client.application.isRunning).toBe(true);
    expect(client.application.port).toBeGreaterThan(0);

    await client.close();

    expect(client.application.isRunning).toBe(false);
  });

  test("sends JSON requests and preserves explicit content types", async () => {
    const router = Router.create();
    router.post("/json", async (context) => ({
      body: await context.json(),
      contentType: context.header("content-type"),
    }));
    const client = TestClient.create({ router });
    clients.push(client);

    const response = await client.post("/json", {
      json: { framework: "Bolt" },
    });

    expect(await response.json()).toEqual({
      body: { framework: "Bolt" },
      contentType: "application/json",
    });
  });

  test("provides request and common HTTP method shortcuts", async () => {
    const router = Router.create();
    router.post("/method", (context) => context.request.method);
    router.put("/method", (context) => context.request.method);
    router.patch("/method", (context) => context.request.method);
    router.delete("/method", (context) => context.request.method);
    router.head("/method", (context) => context.request.method);
    router.options("/method", (context) => context.request.method);
    const client = TestClient.create({ router });
    clients.push(client);

    const responses = await Promise.all([
      client.request("/method", { method: "POST" }),
      client.put("/method"),
      client.patch("/method"),
      client.delete("/method"),
      client.head("/method"),
      client.options("/method"),
    ]);

    expect(responses.map((response) => response.status)).toEqual([
      200, 200, 200, 200, 200, 200,
    ]);
    expect(
      await Promise.all(responses.map((response) => response.text())),
    ).toEqual(["POST", "PUT", "PATCH", "DELETE", "", "OPTIONS"]);
  });

  test("stops an external application only when it started it", async () => {
    const router = Router.create();
    router.get("/", () => "ok");
    const application = BoltApplication.create({
      hostname: "127.0.0.1",
      port: 0,
      router,
    });
    applications.push(application);
    const client = TestClient.create(application);
    clients.push(client);

    await client.get("/");
    await client.close();

    expect(application.isRunning).toBe(false);

    await application.start();
    const attachedClient = TestClient.create(application);
    clients.push(attachedClient);

    await attachedClient.get("/");
    await attachedClient.close();

    expect(application.isRunning).toBe(true);
  });

  test("rejects ambiguous and non-serializable request bodies", async () => {
    const client = TestClient.create();
    clients.push(client);

    await expect(
      client.post("/", { body: "raw", json: { valid: true } }),
    ).rejects.toThrow("both body and json");
    await expect(client.post("/", { json: undefined })).rejects.toThrow(
      "must be serializable",
    );
  });
});
