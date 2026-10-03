import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, unlink } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  boundedStream, bodyStream, listLimit, readBytes, StorageError, unsupported, validateKey, validateTransfer,
  type ListOptions, type ObjectInfo, type ObjectPage, type PresignOptions, type StorageBody,
  type StorageDisk, type TransferOptions, type WriteOptions,
} from "./contracts.ts";

function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === "ENOENT"; }
export interface LocalStorageOptions { root: string; /** Limits traversal work for each list request. */ maxListingEntries?: number }

/** Own the root exclusively; do not allow untrusted OS users to mutate it. */
export class LocalStorage implements StorageDisk {
  readonly capabilities = Object.freeze({ presign: false, atomicWrite: true, multipart: false, abortWrite: true });
  readonly #root: Promise<string>;
  readonly #maxListingEntries: number;
  readonly #publishing = new Map<string, Promise<void>>();
  constructor(options: LocalStorageOptions) {
    if (!options.root) throw new StorageError("A storage root is required", "INVALID_OPTIONS");
    this.#maxListingEntries = options.maxListingEntries ?? 100_000;
    if (!Number.isSafeInteger(this.#maxListingEntries) || this.#maxListingEntries < 1) throw new StorageError("maxListingEntries must be positive", "INVALID_OPTIONS");
    // Lazy initialization errors remain observable by every operation.
    this.#root = Promise.resolve().then(async () => { await mkdir(resolve(options.root), { recursive: true }); return realpath(resolve(options.root)); });
    void this.#root.catch(() => {});
  }
  async #path(key: string, createParents = false): Promise<string> {
    validateKey(key);
    const root = await this.#root;
    const parts = key.split("/");
    let current = root;
    for (let index = 0; index < parts.length; index++) {
      current = resolve(current, parts[index]!);
      const rel = relative(root, current);
      if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new StorageError("Path escapes storage root", "INVALID_KEY");
      try {
        const info = await lstat(current);
        if (info.isSymbolicLink() || (index < parts.length - 1 ? !info.isDirectory() : !info.isFile())) {
          throw new StorageError("Storage paths cannot include symbolic links or special files", "INVALID_KEY");
        }
        const actual = relative(root, await realpath(current));
        if (actual === ".." || actual.startsWith(`..${sep}`) || isAbsolute(actual)) throw new StorageError("Path escapes storage root", "INVALID_KEY");
      } catch (error) {
        if (!missing(error)) throw error;
        if (createParents && index < parts.length - 1) {
          await mkdir(current).catch(error => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
          const info = await lstat(current);
          if (!info.isDirectory() || info.isSymbolicLink()) throw new StorageError("Unsafe storage parent", "INVALID_KEY");
        }
      }
    }
    return current;
  }
  async stat(key: string): Promise<ObjectInfo | undefined> {
    const path = await this.#path(key);
    try { const info = await lstat(path); return { key, size: info.size, lastModified: info.mtime }; }
    catch (error) { if (missing(error)) return undefined; throw error; }
  }
  async exists(key: string): Promise<boolean> { return (await this.stat(key)) !== undefined; }
  async read(key: string, options: TransferOptions = {}): Promise<Uint8Array> {
    return readBytes(await this.readStream(key, { ...options, maxBytes: options.maxBytes ?? 64 * 1024 * 1024 }));
  }
  async readStream(key: string, options: TransferOptions = {}): Promise<ReadableStream<Uint8Array>> {
    validateTransfer(options);
    const path = await this.#path(key);
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(error => {
      if (missing(error)) throw new StorageError("Object does not exist", "NOT_FOUND");
      throw error;
    });
    let closed = false;
    const close = async () => { if (!closed) { closed = true; await handle.close(); } };
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new StorageError("Object is not a regular file", "INVALID_KEY");
      if (options.maxBytes !== undefined && info.size > options.maxBytes) throw new StorageError("Transfer exceeds maxBytes", "LIMIT_EXCEEDED");
      return boundedStream(new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const buffer = new Uint8Array(64 * 1024);
            const { bytesRead } = await handle.read(buffer);
            if (!bytesRead) { await close(); controller.close(); } else controller.enqueue(buffer.subarray(0, bytesRead));
          } catch (error) { await close(); controller.error(error); }
        },
        async cancel() { await close(); },
      }), options);
    } catch (error) { await close(); throw error; }
  }
  async write(key: string, body: StorageBody, options: WriteOptions = {}): Promise<void> {
    validateTransfer(options);
    const path = await this.#path(key, true);
    const temporary = resolve(path, "..", `.bolt-write-${crypto.randomUUID()}`);
    const handle = await open(temporary, "wx", 0o600);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let published = false;
    try {
      reader = boundedStream(bodyStream(body), options).getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        let offset = 0;
        while (offset < value.byteLength) {
          options.signal?.throwIfAborted();
          const { bytesWritten } = await handle.write(value, offset, value.byteLength - offset);
          if (!bytesWritten) throw new StorageError("Write made no progress", "PROVIDER_ERROR");
          offset += bytesWritten;
        }
      }
      await handle.sync();
      await handle.close();
      options.signal?.throwIfAborted();
      const previous = this.#publishing.get(key) ?? Promise.resolve();
      let release!: () => void;
      const pending = new Promise<void>(resolve => { release = resolve; });
      this.#publishing.set(key, pending);
      await previous;
      try {
        options.signal?.throwIfAborted();
        await this.#path(key);
        await rename(temporary, path);
      } finally {
        release();
        if (this.#publishing.get(key) === pending) this.#publishing.delete(key);
      }
      published = true;
    } finally {
      await reader?.cancel().catch(() => {});
      reader?.releaseLock();
      await handle.close().catch(() => {});
      if (!published) await unlink(temporary).catch(error => { if (!missing(error)) throw error; });
    }
  }
  async delete(key: string): Promise<void> {
    const path = await this.#path(key);
    await unlink(path).catch(error => { if (!missing(error)) throw error; });
  }
  async copy(source: string, destination: string, options: TransferOptions = {}): Promise<void> {
    validateKey(destination);
    const stream = await this.readStream(source, options);
    try { await this.write(destination, stream, options); } catch (error) { await stream.cancel(error).catch(() => {}); throw error; }
  }
  async list(options: ListOptions = {}): Promise<ObjectPage> {
    const limit = listLimit(options.limit);
    const prefix = options.prefix ?? "";
    if (prefix) validateKey(prefix.endsWith("/") ? prefix.slice(0, -1) : prefix);
    let after = "";
    if (options.cursor) {
      try {
        const data: unknown = JSON.parse(Buffer.from(options.cursor, "base64url").toString("utf8"));
        if (typeof data !== "object" || data === null || !("prefix" in data) || data.prefix !== prefix || !("after" in data) || typeof data.after !== "string") throw new Error();
        after = validateKey(data.after);
      } catch { throw new StorageError("Invalid listing cursor", "INVALID_OPTIONS"); }
    }
    const root = await this.#root;
    let scanned = 0;
    const maximum = this.#maxListingEntries;
    async function* visit(directory: string, parent: string): AsyncGenerator<string> {
      const entries = await readdir(directory, { withFileTypes: true });
      entries.sort((left, right) => {
        const a = left.name + (left.isDirectory() ? "/" : "");
        const b = right.name + (right.isDirectory() ? "/" : "");
        return a < b ? -1 : a > b ? 1 : 0;
      });
      for (const entry of entries) {
        if (++scanned > maximum) throw new StorageError("Listing traversal exceeds maxListingEntries", "LIMIT_EXCEEDED");
        if (entry.name.startsWith(".bolt-write-") || entry.isSymbolicLink()) continue;
        const key = parent + entry.name;
        validateKey(key);
        if (entry.isDirectory()) yield* visit(resolve(directory, entry.name), `${key}/`);
        else if (entry.isFile() && key.startsWith(prefix) && key > after) yield key;
      }
    }
    const objects: ObjectInfo[] = [];
    for await (const key of visit(root, "")) {
      if (objects.length === limit) return { objects, cursor: Buffer.from(JSON.stringify({ prefix, after: objects.at(-1)!.key })).toString("base64url") };
      const info = await this.stat(key);
      if (info) objects.push(info);
    }
    return { objects };
  }
  async presign(_key: string, _options?: PresignOptions): Promise<string> { return unsupported("presigned URLs"); }
}
