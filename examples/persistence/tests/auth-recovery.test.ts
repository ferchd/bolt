import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqlDatabase } from "@bolt/database";
import { hashPassword } from "@bolt/security";
import { LocalStorage } from "@bolt/storage";
import { TestClient } from "@bolt/testing";
import { createPersistenceApplication } from "../src/application.ts";

test("authenticated application enforces CSRF and permissions, survives restart and concurrent writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "bolt-auth-recovery-"));
  const filename = join(root, "application.sqlite");
  const passwordHash = await hashPassword("test-password", { memoryCost: 8192, timeCost: 1 });
  const user = { id: "operator", permissions: ["assets.read", "assets.write"], internalNote: "provider-only data" };
  const users = { findById: async (id: string) => id === user.id ? user : null, findByLogin: async (login: string) => login === "operator" ? { user, passwordHash } : null };
  const make = () => createPersistenceApplication({ database: SqlDatabase.create({ dialect: "sqlite", filename }), disk: new LocalStorage({ root: join(root, "objects") }), port: 0, auth: { users, csrfSecret: "test-only-csrf-secret-at-least-32-bytes", secure: false } });
  let setup = make();
  let client = TestClient.create(setup.application);
  try {
    const anonymous = await client.get("/assets");
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("cache-control")).toBe("no-store");
    const csrfResponse = await client.get("/auth/csrf");
    expect(csrfResponse.headers.get("cache-control")).toBe("no-store");
    const csrfToken = (await csrfResponse.json()).token as string;
    const csrfCookie = csrfResponse.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
    const noCsrf = await client.post("/auth/login", { json: { login: "operator", password: "test-password" } });
    expect(noCsrf.status).toBe(403);
    expect(noCsrf.headers.get("cache-control")).toBe("no-store");
    expect((await client.post("/auth/login", { headers: { cookie: csrfCookie, "x-csrf-token": "wrong" }, json: { login: "operator", password: "test-password" } })).status).toBe(403);
    const login = await client.post("/auth/login", { headers: { cookie: csrfCookie, "x-csrf-token": csrfToken }, json: { login: "operator", password: "test-password" } });
    expect(login.status).toBe(200);
    expect(await login.json()).toEqual({ id: user.id, permissions: user.permissions });
    expect(login.headers.get("cache-control")).toBe("no-store");
    const session = login.headers.getSetCookie().find(value => value.startsWith("bolt_session="))!.split(";")[0]!;
    const headers = { cookie: `${csrfCookie}; ${session}`, "x-csrf-token": csrfToken };
    const created = await client.post("/assets", { headers, json: { title: "durable" } });
    expect(created.status).toBe(201);
    const asset = await created.json();
    const writes = await Promise.all(["first writer", "second writer"].map(body => client.put(`/assets/${asset.id}/content`, { headers: { ...headers, "if-match": '"1"' }, body })));
    expect(writes.filter(response => response.status === 200)).toHaveLength(1);
    expect(writes.every(response => [200, 409, 412].includes(response.status))).toBe(true);
    const successfulIndex = writes.findIndex(response => response.status === 200);
    const content = ["first writer", "second writer"][successfulIndex]!;
    user.permissions = ["assets.read"];
    expect((await client.post("/assets", { headers, json: { title: "forbidden" } })).status).toBe(403);
    user.permissions = ["assets.read", "assets.write"];
    for (let batch = 0; batch < 8; batch++) {
      const responses = await Promise.all(Array.from({ length: 8 }, (_, i) => client.post("/assets", { headers, json: { title: `load-${batch}-${i}` } })));
      expect(responses.every(response => response.status === 201)).toBe(true);
      await Promise.all(responses.map(response => response.arrayBuffer()));
    }
    expect((await setup.database.execute("SELECT COUNT(*) AS total FROM bolt_assets")).rows[0]?.["total"]).toBe(65);
    await client.close();
    setup = make();
    client = TestClient.create(setup.application);
    const restored = await client.get(`/assets/${asset.id}/content`, { headers });
    expect(restored.status).toBe(200);
    expect(restored.headers.get("cache-control")).toBe("no-store");
    expect(await restored.text()).toBe(content);
    expect((await client.post("/auth/logout", { headers })).status).toBe(204);
    expect((await client.get("/assets", { headers })).status).toBe(401);
  } finally {
    await client.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
