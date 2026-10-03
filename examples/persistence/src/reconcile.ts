import type { SqlExecutor } from "@bolt/database";
import { Repository } from "@bolt/orm";
import type { StorageDisk } from "@bolt/storage";
import { assetEntity } from "./application.ts";

/** Run with asset writers stopped across ALL replicas. Defaults to inspection only. */
export async function reconcileAssets(database: SqlExecutor, disk: StorageDisk, options: {
  exclusiveMaintenance: true;
  dryRun?: boolean;
  maxObjects?: number;
  maxReferences?: number;
  maxAssets?: number;
}) {
  if (options.exclusiveMaintenance !== true) throw new Error("Reconciliation requires exclusive maintenance without active writers");
  const maxObjects = options.maxObjects ?? 10000;
  const maxReferences = options.maxReferences ?? 10000;
  const maxAssets = options.maxAssets ?? 10000;
  if (![maxObjects, maxReferences, maxAssets].every(value => Number.isSafeInteger(value) && value > 0)) throw new RangeError("Reconciliation limits must be positive integers");
  const references = new Set<string>();
  const repository = new Repository(database, assetEntity);
  let after: string | undefined;
  let scannedAssets = 0;
  // Keyset pagination limits SQL and memory work; inspect every page before deleting anything.
  for (;;) {
    let query = repository.query();
    if (after) query = query.where(asset => asset.id.gt(after!));
    const page = await query.orderBy(asset => asset.id).take(500).toList();
    for (const asset of page) {
      if (++scannedAssets > maxAssets) throw new Error("Reconciliation asset limit exceeded");
      if (asset.objectKey) references.add(asset.objectKey);
      if (references.size > maxReferences) throw new Error("Reconciliation reference limit exceeded");
    }
    if (page.length < 500) break;
    after = page.at(-1)!.id;
  }
  const present = new Set<string>();
  const orphans: string[] = [];
  let cursor: string | undefined;
  const cursors = new Set<string>();
  do {
    const page = await disk.list({ prefix: "assets/", limit: 500, cursor });
    for (const object of page.objects) {
      if (!object.key.startsWith("assets/")) throw new Error("Storage provider returned an object outside the asset prefix");
      present.add(object.key);
      if (present.size > maxObjects) throw new Error("Reconciliation object limit exceeded");
      if (!references.has(object.key)) orphans.push(object.key);
    }
    cursor = page.cursor;
    if (cursor) {
      if (cursors.has(cursor)) throw new Error("Storage provider repeated a listing cursor");
      cursors.add(cursor);
    }
  } while (cursor);
  const missing = [...references].filter(key => !present.has(key));
  const deleted: string[] = [];
  if (options.dryRun === false) {
    for (const key of orphans) { await disk.delete(key); deleted.push(key); }
  }
  return { orphans, missing, deleted };
}
