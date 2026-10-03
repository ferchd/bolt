import { afterEach, expect, test } from "bun:test";
import { createHash, createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import { S3Storage } from "../src/index.ts";

const keyId = "bolt-test-access";
const secret = "bolt-test-secret";
const servers: ReturnType<typeof Bun.serve>[] = [];
const httpServers: Server[] = [];
afterEach(() => { for (const server of servers.splice(0)) server.stop(true); for (const server of httpServers.splice(0)) { server.closeAllConnections(); server.close(); } });
const hash = (input: string) => createHash("sha256").update(input).digest("hex");
const hmac = (key: string | Uint8Array, input: string) => createHmac("sha256", key).update(input).digest();
const encode = (input: string) => encodeURIComponent(input).replace(/[!'()*]/g, value => `%${value.charCodeAt(0).toString(16).toUpperCase()}`);

/** Independent AWS SigV4 verifier; fixture rejects unsigned or incorrectly signed requests. */
function validSignature(request: Request): boolean {
  const url = new URL(request.url);
  const authorization = request.headers.get("authorization");
  const presigned = url.searchParams.has("X-Amz-Signature");
  const credential = presigned ? url.searchParams.get("X-Amz-Credential") : /Credential=([^, ]+)/.exec(authorization ?? "")?.[1];
  const signature = presigned ? url.searchParams.get("X-Amz-Signature") : /Signature=([^, ]+)/.exec(authorization ?? "")?.[1];
  const signed = presigned ? url.searchParams.get("X-Amz-SignedHeaders") : /SignedHeaders=([^, ]+)/.exec(authorization ?? "")?.[1];
  const date = presigned ? url.searchParams.get("X-Amz-Date") : request.headers.get("x-amz-date");
  if (!credential || !signature || !signed || !date) return false;
  const [id, day, region, service, suffix] = credential.split("/");
  if (id !== keyId || !day || !region || service !== "s3" || suffix !== "aws4_request") return false;
  const params = [...url.searchParams].filter(([name]) => name !== "X-Amz-Signature").map(([name, value]) => [encode(name), encode(value)]);
  params.sort((a, b) => a[0]! < b[0]! ? -1 : a[0]! > b[0]! ? 1 : a[1]! < b[1]! ? -1 : a[1]! > b[1]! ? 1 : 0);
  const query = params.map(([name, value]) => `${name}=${value}`).join("&");
  const headers = signed.split(";").map(name => `${name}:${(name === "host" ? url.host : request.headers.get(name) ?? "").trim().replace(/\s+/g, " ")}\n`).join("");
  const payload = presigned ? "UNSIGNED-PAYLOAD" : request.headers.get("x-amz-content-sha256") ?? hash("");
  const canonical = `${request.method}\n${url.pathname}\n${query}\n${headers}\n${signed}\n${payload}`;
  const scope = `${day}/${region}/s3/aws4_request`;
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${secret}`, day), region), "s3"), "aws4_request");
  return hmac(signingKey, `AWS4-HMAC-SHA256\n${date}\n${scope}\n${hash(canonical)}`).toString("hex") === signature;
}
function fixture(options: { failCompletion?: boolean; failAbort?: boolean; sessionToken?: string; failPartOnce?: boolean; retry?: number } = {}) {
  const objects = new Map<string, Uint8Array>();
  const uploads = new Map<string, Map<number, Uint8Array>>();
  let failedPart = false;
  const requests: { method: string; key: string; valid: boolean }[] = [];
  const server = Bun.serve({ port: 0, async fetch(request) {
    const url = new URL(request.url);
    const key = decodeURIComponent(url.pathname.replace(/^\/bucket\//, ""));
    let valid = validSignature(request);
    const payloadHash = request.headers.get("x-amz-content-sha256");
    if (payloadHash && /^[a-f0-9]{64}$/.test(payloadHash) && ["POST", "PUT"].includes(request.method)) {
      valid = valid && createHash("sha256").update(new Uint8Array(await request.clone().arrayBuffer())).digest("hex") === payloadHash;
    }
    requests.push({ method: request.method, key, valid });
    if (!valid) return new Response("InvalidSignature", { status: 403 });
    if (key === "denied") return new Response("Forbidden", { status: 403 });
    if (key === "bucket-error") return new Response("<Error><Code>NoSuchBucket</Code></Error>", { status: 404 });
    if (request.method === "POST" && url.searchParams.has("uploads")) {
      uploads.set("fixture-upload", new Map());
      return new Response(`<InitiateMultipartUploadResult><Bucket>bucket</Bucket><Key>${key}</Key><UploadId>fixture-upload</UploadId></InitiateMultipartUploadResult>`, { headers: { "content-type": "application/xml" } });
    }
    if (url.searchParams.has("uploadId")) {
      const id = url.searchParams.get("uploadId")!;
      const parts = uploads.get(id)!;
      if (request.method === "PUT") {
        if (options.failPartOnce && !failedPart) { failedPart = true; return new Response(null, { status: 503 }); }
        parts.set(Number(url.searchParams.get("partNumber")), new Uint8Array(await request.arrayBuffer()));
        return new Response(null, { headers: { etag: '"part-etag"' } });
      }
      if (request.method === "DELETE") {
        if (options.failAbort) return new Response(null, { status: 503 });
        uploads.delete(id); return new Response(null, { status: 204 });
      }
      if (request.method === "POST") {
        if (options.failCompletion) return new Response("<Error><Code>InvalidPart</Code></Error>", { headers: { "content-type": "application/xml" } });
        const values = [...parts].sort((a, b) => a[0] - b[0]).map(entry => entry[1]);
        const body = new Uint8Array(values.reduce((size, value) => size + value.byteLength, 0));
        let offset = 0;
        for (const value of values) { body.set(value, offset); offset += value.byteLength; }
        objects.set(key, body); uploads.delete(id);
        return new Response(`<CompleteMultipartUploadResult><Bucket>bucket</Bucket><Key>${key}</Key><ETag>multipart-etag</ETag></CompleteMultipartUploadResult>`, { headers: { "content-type": "application/xml" } });
      }
    }
    if (url.searchParams.get("list-type") === "2") {
      const prefix = url.searchParams.get("prefix") ?? "";
      const after = url.searchParams.get("continuation-token") ?? "";
      const limit = Number(url.searchParams.get("max-keys") ?? "1000");
      const keys = [...objects.keys()].filter(key => key.startsWith(prefix) && key > after).sort();
      const page = keys.slice(0, limit);
      return new Response(`<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>bucket</Name><IsTruncated>${keys.length > limit}</IsTruncated>${keys.length > limit ? `<NextContinuationToken>${page.at(-1)}</NextContinuationToken>` : ""}${page.map(key => `<Contents><Key>${key}</Key><Size>${objects.get(key)!.byteLength}</Size><ETag>fixture</ETag><LastModified>2026-01-01T00:00:00Z</LastModified></Contents>`).join("")}</ListBucketResult>`, { headers: { "content-type": "application/xml" } });
    }
    if (request.method === "PUT") { objects.set(key, new Uint8Array(await request.arrayBuffer())); return new Response(null, { headers: { etag: '"fixture"' } }); }
    if (request.method === "DELETE") { objects.delete(key); return new Response(null, { status: 204 }); }
    const object = objects.get(key);
    if (!object) return new Response(request.method === "HEAD" ? null : "<Error><Code>NoSuchKey</Code></Error>", { status: 404 });
    const headers = { "content-length": String(object.byteLength), "content-type": "text/plain", "last-modified": "Thu, 01 Jan 2026 00:00:00 GMT", etag: '"fixture"' };
    return new Response(request.method === "HEAD" ? null : new Uint8Array(object), { headers });
  } });
  servers.push(server);
  const disk = new S3Storage({ bucket: "bucket", endpoint: server.url.toString(), region: "us-east-1", accessKeyId: keyId, secretAccessKey: secret, sessionToken: options.sessionToken, retry: options.retry ?? 0 });
  return { disk, requests, objects, uploads };
}

test("S3 uploads, native head and delete, and signed fetch reads use valid AWS signatures", async () => {
  const { disk, requests } = fixture();
  await disk.write("docs/a.txt", "hello", { contentType: "text/plain" });
  expect((await disk.stat("docs/a.txt"))?.size).toBe(5);
  expect(new TextDecoder().decode(await disk.read("docs/a.txt"))).toBe("hello");
  await disk.copy("docs/a.txt", "docs/b.txt");
  expect(new TextDecoder().decode(await disk.read("docs/b.txt"))).toBe("hello");
  await disk.delete("docs/a.txt");
  await disk.delete("docs/a.txt");
  expect(await disk.exists("docs/a.txt")).toBe(false);
  expect(requests.length).toBeGreaterThan(5);
  expect(requests.every(request => request.valid)).toBe(true);
});
test("S3 paginates native ListObjectsV2 and maps metadata", async () => {
  const { disk, objects, requests } = fixture();
  for (const key of ["docs/a", "docs/b", "docs/c", "other"]) objects.set(key, new Uint8Array([1]));
  const first = await disk.list({ prefix: "docs/", limit: 2 });
  expect(first.objects.map(item => item.key)).toEqual(["docs/a", "docs/b"]);
  expect(first.cursor).toBe("docs/b");
  const second = await disk.list({ prefix: "docs/", limit: 2, cursor: first.cursor });
  expect(second.objects.map(item => item.key)).toEqual(["docs/c"]);
  expect(second.cursor).toBeUndefined();
  expect(requests.every(request => request.valid)).toBe(true);
});
test("missing S3 objects differ from forbidden requests", async () => {
  const { disk } = fixture();
  expect(await disk.stat("missing")).toBeUndefined();
  await expect(disk.read("missing")).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(disk.stat("denied")).rejects.toThrow();
  await expect(disk.read("denied")).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
  await expect(disk.read("bucket-error")).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
  await expect(disk.stat("bucket-error")).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
});
test("S3 presigned PUT allows a cancellable native fetch and bounds downloads", async () => {
  const { disk } = fixture();
  const url = await disk.presign("direct", { method: "PUT", expiresIn: 60 });
  expect(new URL(url).searchParams.get("X-Amz-Expires")).toBe("60");
  expect(url).not.toContain(secret);
  expect((await fetch(url, { method: "PUT", body: "abcdef" })).ok).toBe(true);
  await expect(disk.read("direct", { maxBytes: 5 })).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
  const controller = new AbortController(); controller.abort(new Error("cancel"));
  await expect(disk.read("direct", { signal: controller.signal })).rejects.toThrow("cancel");
  await disk.write("cancelable", "x", { signal: new AbortController().signal });
  expect(new TextDecoder().decode(await disk.read("cancelable"))).toBe("x");
  await expect(disk.presign("direct", { expiresIn: 604801 })).rejects.toMatchObject({ code: "INVALID_OPTIONS" });
});
test("S3 uploader enforces input limits before publishing", async () => {
  const { disk, objects } = fixture();
  await expect(disk.write("too-large", new Uint8Array(10), { maxBytes: 5 })).rejects.toThrow();
  expect(objects.has("too-large")).toBe(false);
});
test("original multipart uploader publishes complete large streams with valid signatures", async () => {
  const { disk, requests, objects, uploads } = fixture();
  const bytes = new Uint8Array(12 * 1024 * 1024).fill(42);
  await disk.write("large", new Blob([bytes]));
  expect(objects.get("large")).toEqual(bytes);
  expect(uploads.size).toBe(0);
  expect(requests.filter(request => request.method === "POST").length).toBe(2);
  expect(requests.filter(request => request.method === "PUT").length).toBeGreaterThan(1);
  expect(requests.every(request => request.valid)).toBe(true);
});
test("failed large streams abort multipart uploads without replacing existing content", async () => {
  const { disk, objects, uploads } = fixture();
  objects.set("large", new Uint8Array([7]));
  await expect(disk.write("large", new Blob([new Uint8Array(12 * 1024 * 1024)]), { maxBytes: 10 * 1024 * 1024 })).rejects.toThrow();
  expect(objects.get("large")).toEqual(new Uint8Array([7]));
  expect(uploads.size).toBe(0);
});
test("original cancelable multipart signs actual requests, includes session tokens, supports empty objects and copy", async () => {
  const { disk, objects, requests, uploads } = fixture({ sessionToken: "session-fixture" });
  const signal = new AbortController().signal;
  const bytes = new Uint8Array(12 * 1024 * 1024).fill(42);
  await disk.write("docs/unicode-ñ space?#.txt", new Blob([bytes]), { signal, contentType: "application/octet-stream" });
  expect(objects.get("docs/unicode-ñ space?#.txt")).toEqual(bytes);
  await disk.copy("docs/unicode-ñ space?#.txt", "copied", { signal });
  expect(objects.get("copied")).toEqual(bytes);
  await disk.write("empty", "", { signal });
  expect(objects.get("empty")?.byteLength).toBe(0);
  expect(uploads.size).toBe(0);
  expect(requests.every(request => request.valid)).toBe(true);
});
test("cancelable upload stops pending input and aborts its multipart session", async () => {
  const { disk, objects, uploads } = fixture();
  const abort = new AbortController();
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(5 * 1024 * 1024)); },
    cancel() { cancelled = true; },
  });
  const write = disk.write("cancel-input", body, { signal: abort.signal });
  for (let retry = 0; retry < 100 && uploads.size === 0; retry++) await new Promise(resolve => setTimeout(resolve, 5));
  expect(uploads.size).toBe(1);
  abort.abort(new Error("cancel input"));
  await expect(write).rejects.toThrow("cancel input");
  expect(cancelled).toBe(true);
  expect(uploads.size).toBe(0);
  expect(objects.has("cancel-input")).toBe(false);
});
test("cancelable multipart rejects HTTP 200 error documents and exposes cleanup failures", async () => {
  const failed = fixture({ failCompletion: true });
  await expect(failed.disk.write("failed", new Uint8Array(6 * 1024 * 1024), { signal: new AbortController().signal })).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
  expect(failed.uploads.size).toBe(0);
  expect(failed.objects.has("failed")).toBe(false);
  const abandoned = fixture({ failCompletion: true, failAbort: true });
  await expect(abandoned.disk.write("failed", new Uint8Array(6 * 1024 * 1024), { signal: new AbortController().signal })).rejects.toBeInstanceOf(AggregateError);
  expect(abandoned.uploads.size).toBe(1);
});
test("transient part failures retry idempotently without duplicating published content", async () => {
  const { disk, objects, requests } = fixture({ failPartOnce: true, retry: 1 });
  const bytes = new Uint8Array(6 * 1024 * 1024).fill(17);
  await disk.write("retry", bytes);
  expect(objects.get("retry")).toEqual(bytes);
  expect(requests.filter(request => request.method === "PUT")).toHaveLength(3);
  expect(requests.every(request => request.valid)).toBe(true);
});
test("AbortSignal interrupts an active HTTP upload transport and sends a separate multipart cleanup request", async () => {
  const abort = new AbortController();
  let transportClosed = false;
  let cleanup = false;
  let signalClosed!: () => void;
  const closed = new Promise<void>(resolve => { signalClosed = resolve; });
  const server = createServer((request, response) => {
    const url = new URL(request.url!, "http://localhost");
    if (request.method === "POST") {
      request.resume();
      response.setHeader("content-type", "application/xml");
      response.end("<InitiateMultipartUploadResult><UploadId>fixture-upload</UploadId></InitiateMultipartUploadResult>");
    } else if (request.method === "PUT") {
      // Stop reading so a 5 MiB part cannot finish before abort; observe socket teardown.
      request.pause();
      request.once("aborted", () => { transportClosed = true; signalClosed(); });
      setTimeout(() => abort.abort(new Error("cancel active transport")), 20);
    } else if (request.method === "DELETE" && url.searchParams.has("uploadId")) {
      cleanup = true; response.writeHead(204); response.end();
    }
  });
  httpServers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test port");
  const disk = new S3Storage({ bucket: "bucket", endpoint: `http://127.0.0.1:${address.port}`, accessKeyId: keyId, secretAccessKey: secret });
  await expect(disk.write("transport", new Blob([new Uint8Array(12 * 1024 * 1024)]), { signal: abort.signal })).rejects.toThrow("cancel active transport");
  await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error("Upload socket did not close")), 2000))]);
  expect(transportClosed).toBe(true);
  expect(cleanup).toBe(true);
});
