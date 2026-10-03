import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalStorage, StorageManager } from "../src/index.ts";

const roots: string[] = [];
async function local(options = {}) {
  const root = await mkdtemp(join(tmpdir(), "bolt-storage-"));
  roots.push(root);
  return { root, disk: new LocalStorage({ root, ...options }) };
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe("local storage", () => {
  test("writes blobs and streams, reads bytes, copies and deletes idempotently", async () => {
    const { disk } = await local();
    await disk.write("docs/a.txt", new Blob(["hello"]));
    expect(new TextDecoder().decode(await disk.read("docs/a.txt"))).toBe("hello");
    expect((await disk.stat("docs/a.txt"))?.size).toBe(5);
    await disk.copy("docs/a.txt", "docs/b.txt");
    expect(await new Response(await disk.readStream("docs/b.txt")).text()).toBe("hello");
    await disk.delete("docs/a.txt");
    await disk.delete("docs/a.txt");
    expect(await disk.exists("docs/a.txt")).toBe(false);
    expect(await disk.stat("missing.txt")).toBeUndefined();
    await expect(disk.read("missing.txt")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(disk.presign("docs/b.txt")).rejects.toMatchObject({ code: "UNSUPPORTED" });
  });
  test("portable keys reject traversal, absolute paths, alternate streams and device names", async () => {
    const { disk } = await local();
    for (const key of ["../outside", "/absolute", "a/../b", "a//b", "C:/escape", "a\\b", "a:secret", "a/nul.txt", "a. ", "a/CON", ".bolt-write-x"]) {
      await expect(disk.write(key, "bad")).rejects.toMatchObject({ code: "INVALID_KEY" });
    }
  });
  test("refuses symbolic directory and file escapes, and listing skips links", async () => {
    const { root, disk } = await local();
    const outside = await mkdtemp(join(tmpdir(), "bolt-storage-outside-"));
    roots.push(outside);
    await writeFile(join(outside, "secret.txt"), "secret");
    await symlink(outside, join(root, "escape"), process.platform === "win32" ? "junction" : "dir");
    await expect(disk.read("escape/secret.txt")).rejects.toMatchObject({ code: "INVALID_KEY" });
    await expect(disk.write("escape/new.txt", "bad")).rejects.toMatchObject({ code: "INVALID_KEY" });
    expect((await disk.list()).objects).toHaveLength(0);
  });
  test("write limits preserve existing content and clean partial files", async () => {
    const { root, disk } = await local();
    await disk.write("data.txt", "previous");
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(10)); },
      cancel() { cancelled = true; },
    });
    await expect(disk.write("data.txt", body, { maxBytes: 5 })).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
    expect(cancelled).toBe(true);
    expect(new TextDecoder().decode(await disk.read("data.txt"))).toBe("previous");
    expect(await readdir(root)).toEqual(["data.txt"]);
  });
  test("a locked input stream cannot leak a temporary file or replace existing content", async () => {
    const { root, disk } = await local();
    await disk.write("data.txt", "previous");
    const body = new ReadableStream<Uint8Array>();
    const reader = body.getReader();
    try { await expect(disk.write("data.txt", body)).rejects.toThrow(); }
    finally { await reader.cancel(); reader.releaseLock(); }
    expect(await readdir(root)).toEqual(["data.txt"]);
    expect(new TextDecoder().decode(await disk.read("data.txt"))).toBe("previous");
  });

  test("abort interrupts a pending input stream and cleans unpublished files", async () => {
    const { root, disk } = await local();
    const abort = new AbortController();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
    const write = disk.write("pending.txt", body, { signal: abort.signal });
    await new Promise(resolve => setTimeout(resolve, 20));
    abort.abort(new Error("cancel transfer"));
    await expect(write).rejects.toThrow("cancel transfer");
    expect(cancelled).toBe(true);
    expect(await readdir(root)).toEqual([]);
  });
  test("read limits reject oversized files and aborted streams release file handles", async () => {
    const { disk } = await local();
    await disk.write("data", "abcdef");
    await expect(disk.read("data", { maxBytes: 5 })).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
    const abort = new AbortController();
    const stream = await disk.readStream("data", { signal: abort.signal });
    abort.abort(new Error("stop read"));
    await expect(new Response(stream).arrayBuffer()).rejects.toThrow("stop read");
    await disk.delete("data");
    expect(await disk.exists("data")).toBe(false);
  });
  test("paginated listings use ordered keys and bind cursors to their prefix", async () => {
    const { disk } = await local();
    for (const key of ["a/z", "a/x", "a.txt", "b.txt", "a/a"]) await disk.write(key, key);
    const first = await disk.list({ limit: 2 });
    expect(first.objects.map(info => info.key)).toEqual(["a.txt", "a/a"]);
    const second = await disk.list({ limit: 2, cursor: first.cursor });
    expect(second.objects.map(info => info.key)).toEqual(["a/x", "a/z"]);
    const third = await disk.list({ limit: 2, cursor: second.cursor });
    expect(third.objects.map(info => info.key)).toEqual(["b.txt"]);
    expect(third.cursor).toBeUndefined();
    expect((await disk.list({ prefix: "a/" })).objects.map(info => info.key)).toEqual(["a/a", "a/x", "a/z"]);
    await expect(disk.list({ prefix: "a/", cursor: first.cursor })).rejects.toMatchObject({ code: "INVALID_OPTIONS" });
    await expect(disk.list({ limit: 0 })).rejects.toMatchObject({ code: "INVALID_OPTIONS" });
  });
  test("bounds local listing traversal work", async () => {
    const { disk } = await local({ maxListingEntries: 1 });
    await disk.write("a", ""); await disk.write("b", "");
    await expect(disk.list()).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
  });
  test("concurrent replacements publish whole objects without temporary leftovers", async () => {
    const { root, disk } = await local();
    const bodies = Array.from({ length: 8 }, (_, index) => String(index).repeat(50_000));
    await Promise.all(bodies.map(body => disk.write("concurrent", body)));
    expect(bodies).toContain(new TextDecoder().decode(await disk.read("concurrent")));
    expect(await readdir(root)).toEqual(["concurrent"]);
  });
  test("invalid transfer options fail before storage operations", async () => {
    const { disk } = await local();
    for (const maxBytes of [-1, Infinity, 1.5]) await expect(disk.write("data", "a", { maxBytes })).rejects.toMatchObject({ code: "INVALID_OPTIONS" });
    expect(await disk.exists("data")).toBe(false);
  });
});

test("named disk factories initialize once; missing and duplicate names fail", async () => {
  const { disk } = await local();
  let created = 0;
  const manager = new StorageManager("uploads").register("uploads", () => { created++; return disk; });
  expect(manager.disk()).toBe(disk);
  expect(manager.disk("uploads")).toBe(disk);
  expect(created).toBe(1);
  expect(manager.names()).toEqual(["uploads"]);
  expect(() => manager.register("uploads", disk)).toThrow();
  expect(() => manager.disk("unknown")).toThrow();
  expect(() => new StorageManager().disk()).toThrow();
});
