import { expect, test } from "bun:test";
import { S3Storage } from "../src/index.ts";

const configured = Boolean(process.env["BOLT_S3_ENDPOINT"] && process.env["BOLT_S3_BUCKET"]);
test.skipIf(!configured)("real S3-compatible provider: streaming multipart, pagination, copy, missing objects, signed PUT and cleanup", async () => {
  const disk = new S3Storage({
    endpoint: process.env["BOLT_S3_ENDPOINT"], bucket: process.env["BOLT_S3_BUCKET"]!,
    accessKeyId: process.env["BOLT_S3_ACCESS_KEY_ID"], secretAccessKey: process.env["BOLT_S3_SECRET_ACCESS_KEY"],
    region: process.env["BOLT_S3_REGION"] ?? "us-east-1", retry: 0, partSize: 5 * 1024 * 1024,
  });
  const prefix = `bolt-integration/${crypto.randomUUID()}/`;
  const keys = ["small", "copy", "large", "failed", "signed"].map(key => prefix + key);
  try {
    await disk.write(keys[0]!, "hello", { contentType: "text/plain" });
    expect((await disk.stat(keys[0]!))?.size).toBe(5);
    await disk.copy(keys[0]!, keys[1]!);
    expect(await new Response(await disk.readStream(keys[1]!)).text()).toBe("hello");
    const large = new Uint8Array(12 * 1024 * 1024).fill(37);
    await disk.write(keys[2]!, new Blob([large]));
    expect(await disk.read(keys[2]!)).toEqual(large);
    const first = await disk.list({ prefix, limit: 2 });
    expect(first.objects).toHaveLength(2);
    expect(first.cursor).toBeDefined();
    const next = await disk.list({ prefix, limit: 2, cursor: first.cursor });
    expect(next.objects).toHaveLength(1);
    await expect(disk.write(keys[3]!, new Blob([large]), { maxBytes: 10 * 1024 * 1024 })).rejects.toThrow();
    expect(await disk.exists(keys[3]!)).toBe(false);
    const url = await disk.presign(keys[4]!, { method: "PUT", expiresIn: 60 });
    expect((await fetch(url, { method: "PUT", body: "direct" })).ok).toBe(true);
    expect(new TextDecoder().decode(await disk.read(keys[4]!))).toBe("direct");
    await disk.delete(keys[0]!);
    await disk.delete(keys[0]!);
    expect(await disk.stat(keys[0]!)).toBeUndefined();
  } finally { await Promise.all(keys.map(key => disk.delete(key))); }
}, 30_000);

test.skipIf(!configured)("real provider: nonexistent bucket errors are not treated as missing objects", async () => {
  const disk = new S3Storage({
    endpoint: process.env["BOLT_S3_ENDPOINT"], bucket: `bolt-nonexistent-${crypto.randomUUID()}`,
    accessKeyId: process.env["BOLT_S3_ACCESS_KEY_ID"], secretAccessKey: process.env["BOLT_S3_SECRET_ACCESS_KEY"],
    region: process.env["BOLT_S3_REGION"] ?? "us-east-1",
  });
  await expect(disk.read("missing")).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
  await expect(disk.stat("missing")).rejects.toThrow();
  await expect(disk.delete("missing")).rejects.toThrow();
  await expect(disk.write("missing", "data")).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
});

test.skipIf(!configured)("real provider: original cancelable multipart, upload limits, cancellation cleanup, empty objects and Unicode keys", async () => {
  const disk = new S3Storage({
    endpoint: process.env["BOLT_S3_ENDPOINT"], bucket: process.env["BOLT_S3_BUCKET"]!,
    accessKeyId: process.env["BOLT_S3_ACCESS_KEY_ID"], secretAccessKey: process.env["BOLT_S3_SECRET_ACCESS_KEY"],
    region: process.env["BOLT_S3_REGION"] ?? "us-east-1", partSize: 5 * 1024 * 1024,
  });
  const prefix = `bolt-cancelable/${crypto.randomUUID()}/`;
  const keys = ["large-ñ space?#", "copy", "empty", "limited", "cancelled"].map(key => prefix + key);
  const signal = new AbortController().signal;
  try {
    const bytes = new Uint8Array(12 * 1024 * 1024).fill(37);
    await disk.write(keys[0]!, new Blob([bytes]), { signal, contentType: "application/octet-stream" });
    expect(await disk.read(keys[0]!)).toEqual(bytes);
    await disk.copy(keys[0]!, keys[1]!, { signal });
    expect(await disk.read(keys[1]!)).toEqual(bytes);
    await disk.write(keys[2]!, "", { signal });
    expect((await disk.stat(keys[2]!))?.size).toBe(0);
    await expect(disk.write(keys[3]!, new Blob([bytes]), { signal, maxBytes: 10 * 1024 * 1024 })).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
    expect(await disk.exists(keys[3]!)).toBe(false);
    const abort = new AbortController();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(5 * 1024 * 1024)); },
      cancel() { cancelled = true; },
    });
    const writing = disk.write(keys[4]!, body, { signal: abort.signal });
    // Give the real service time to create/upload a part while input remains pending.
    await new Promise(resolve => setTimeout(resolve, 200));
    abort.abort(new Error("real integration cancel"));
    await expect(writing).rejects.toThrow("real integration cancel");
    expect(cancelled).toBe(true);
    expect(await disk.exists(keys[4]!)).toBe(false);
  } finally { await Promise.all(keys.map(key => disk.delete(key))); }
}, 30_000);
