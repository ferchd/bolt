import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SqlDatabase, type SqlValue } from "@bolt/database";
import { LocalStorage } from "@bolt/storage";
import { TestClient } from "@bolt/testing";
import { createPersistenceApplication } from "../src/application.ts";
import { createSqlTransport } from "../../../packages/database/src/sql-transports.ts";

test("preserves a referenced blob when session cleanup fails after confirmed SQL COMMIT", async () => {
  const root = await mkdtemp(join(tmpdir(), "bolt-assets-postcommit-"));
  const native = createSqlTransport({ dialect: "sqlite", filename: ":memory:" });
  let failRelease = false;
  let armed = true;
  const database = SqlDatabase.create({ dialect: "sqlite", transport: {
    dialect: "sqlite", connect: () => native.connect(), close: () => native.close(),
    async reserve() {
      const session = await native.reserve();
      return {
        async execute<Row extends Record<string, unknown>>(sql: string, values?: readonly SqlValue[]) {
          const result = await session.execute<Row>(sql, values);
          if (armed && /^UPDATE\s/.test(sql) && sql.includes("bolt_assets")) { failRelease = true; armed = false; }
          return result;
        },
        async release() { await session.release(); if (failRelease) { failRelease = false; throw new Error("release after committed update"); } },
      };
    },
  } });
  const disk = new LocalStorage({ root });
  const setup = createPersistenceApplication({ database, disk, port: 0 });
  const client = TestClient.create(setup.application);
  try {
    const asset = await (await client.post("/assets", { json: { title: "committed" } })).json();
    const upload = await client.put(`/assets/${asset.id}/content`, { headers: { "if-match": '"1"' }, body: "keep confirmed content" });
    expect(upload.status).toBe(500);
    await upload.text();
    const content = await client.get(`/assets/${asset.id}/content`);
    expect(content.status).toBe(200);
    expect(content.headers.get("etag")).toBe('"2"');
    expect(await content.text()).toBe("keep confirmed content");
    expect((await disk.list({ prefix: "assets/" })).objects).toHaveLength(1);
  } finally { await client.close(); await rm(root, { recursive: true, force: true }); }
});

test("persists through the original ORM, filters in SQL, and streams versioned assets", async () => {
  const root = await mkdtemp(join(tmpdir(), "bolt-assets-"));
  const database = SqlDatabase.create({ dialect: "sqlite", filename: ":memory:" });
  const setup = createPersistenceApplication({ database, disk: new LocalStorage({ root }), port: 0 });
  const client = TestClient.create(setup.application);
  try {
    const created = await client.post("/assets", { json: { title: "Report" } });
    expect(created.status).toBe(201);
    const asset = await created.json();
    await client.post("/assets", { json: { title: "Other" } });
    const listing = await client.get("/assets?title=Report");
    expect(await listing.json()).toEqual([asset]);
    const upload = await client.put(`/assets/${asset.id}/content`, {
      headers: { "if-match": '"1"' }, body: "original storage content",
    });
    expect(upload.status).toBe(200);
    expect(upload.headers.get("etag")).toBe('"2"');
    const download = await client.get(`/assets/${asset.id}/content`);
    expect(await download.text()).toBe("original storage content");
    const stale = await client.put(`/assets/${asset.id}/content`, { headers: { "if-match": '"1"' }, body: "stale" });
    expect(stale.status).toBe(412);
    expect(await (await client.get(`/assets/${asset.id}/content`)).text()).toBe("original storage content");
    const invalid = await client.post("/assets", { json: { title: "" } });
    expect(invalid.status).toBe(422);
  } finally {
    await client.close();
    await rm(root, { recursive: true, force: true });
  }
});
