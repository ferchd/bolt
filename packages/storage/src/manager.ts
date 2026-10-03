import { StorageError, type StorageDisk } from "./contracts.ts";

/** Application-owned registry. Providers may be constructed lazily and only once. */
export class StorageManager {
  readonly #disks = new Map<string, StorageDisk | (() => StorageDisk)>();
  constructor(readonly defaultDisk?: string) {}
  register(name: string, disk: StorageDisk | (() => StorageDisk)): this {
    if (!name || this.#disks.has(name)) throw new StorageError("Disk name must be non-empty and unique", "INVALID_OPTIONS");
    this.#disks.set(name, disk);
    return this;
  }
  disk(name = this.defaultDisk): StorageDisk {
    if (!name) throw new StorageError("No default disk is configured", "INVALID_OPTIONS");
    const entry = this.#disks.get(name);
    if (!entry) throw new StorageError(`Storage disk is not registered: ${name}`, "INVALID_OPTIONS");
    if (typeof entry !== "function") return entry;
    const instance = entry();
    this.#disks.set(name, instance);
    return instance;
  }
  names(): string[] { return [...this.#disks.keys()]; }
}
