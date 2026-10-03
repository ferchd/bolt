import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqlDatabase } from "@bolt/database";
import { Repository } from "@bolt/orm";
import { LocalStorage } from "@bolt/storage";
import { assetEntity, createPersistenceApplication } from "../src/application.ts";
import { reconcileAssets } from "../src/reconcile.ts";

test("offline reconciliation reports missing content, bounds inspection, and deletes only unreferenced asset objects", async () => {
  const root = await mkdtemp(join(tmpdir(), "bolt-reconcile-"));
  const database = SqlDatabase.create({ dialect: "sqlite", filename: ":memory:" });
  const disk = new LocalStorage({ root });
  const setup = createPersistenceApplication({ database, disk, port: 0 });
  try {
    await database.start();
    await setup.migrator.migrate();
    const repository = new Repository(database, assetEntity);
    await repository.insert({ id: "one", title: "present", objectKey: "assets/present", version: 1 });
    await repository.insert({ id: "two", title: "missing", objectKey: "assets/missing", version: 1 });
    await disk.write("assets/present", "keep");
    await disk.write("assets/orphan", "crashed upload");
    await disk.write("other/unrelated", "keep unrelated object");
    const inspected = await reconcileAssets(database, disk, { exclusiveMaintenance: true });
    expect(inspected).toEqual({ orphans: ["assets/orphan"], missing: ["assets/missing"], deleted: [] });
    await expect(reconcileAssets(database, disk, { exclusiveMaintenance: true, dryRun: false, maxObjects: 1 })).rejects.toThrow("limit exceeded");
    expect(await disk.exists("assets/orphan")).toBe(true);
    const cleaned = await reconcileAssets(database, disk, { exclusiveMaintenance: true, dryRun: false });
    expect(cleaned.deleted).toEqual(["assets/orphan"]);
    expect(await disk.exists("assets/present")).toBe(true);
    expect(await disk.exists("other/unrelated")).toBe(true);
    expect(await disk.exists("assets/orphan")).toBe(false);
  } finally { await database.close(); await rm(root, { recursive: true, force: true }); }
});
