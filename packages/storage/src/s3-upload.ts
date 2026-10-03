import { createHash, createHmac } from "node:crypto";
import type { S3Client } from "bun";
import { boundedStream, bodyStream, readBytes, StorageError, type StorageBody, type WriteOptions } from "./contracts.ts";

interface Credentials { accessKeyId?: string; secretAccessKey?: string; sessionToken?: string }
class S3HttpError extends StorageError {
  constructor(method: string, readonly status: number) { super(`S3 ${method} failed with HTTP ${status}`, "PROVIDER_ERROR"); }
}
const encode = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const hmac = (key: string | Uint8Array, value: string) => createHmac("sha256", key).update(value).digest();
const xmlEscape = (value: string) => value.replace(/[<>&"']/g, character => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[character]!);
function xmlValue(xml: string, element: string): string | undefined {
  const value = new RegExp(`<${element}>([^<]*)</${element}>`).exec(xml)?.[1];
  return value?.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, (_, entity: string) => {
    if (entity.startsWith("#")) {
      const point = entity[1]?.toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      if (!Number.isInteger(point) || point < 0 || point > 0x10ffff) throw new StorageError("Invalid S3 XML response", "PROVIDER_ERROR");
      return String.fromCodePoint(point);
    }
    return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" })[entity.toLowerCase()]!;
  });
}
async function responseText(response: Response): Promise<string> {
  return new TextDecoder().decode(await readBytes(boundedStream(response.body ?? bodyStream(""), { maxBytes: 1024 * 1024 })));
}

/** Original bounded SigV4 multipart transport, with cancellation and cleanup. */
export class CancellableS3Uploader {
  readonly #client: S3Client;
  readonly #credentials: Credentials;
  readonly #partSize: number;
  readonly #retry: number;
  constructor(client: S3Client, credentials: Credentials, partSize = 5 * 1024 * 1024, retry = 3) {
    this.#client = client;
    this.#credentials = credentials;
    this.#partSize = partSize;
    this.#retry = retry;
  }
  async #request(key: string, method: "POST" | "PUT" | "DELETE", query: Record<string, string>, payload: Uint8Array<ArrayBuffer>, signal: AbortSignal, contentType?: string): Promise<Response> {
    signal.throwIfAborted();
    const { accessKeyId, secretAccessKey, sessionToken } = this.#credentials;
    if (!accessKeyId || !secretAccessKey) throw new StorageError("Uploads require S3 HMAC credentials", "INVALID_OPTIONS");
    // Use Bun to resolve the configured endpoint, key encoding and credential region.
    const url = new URL(this.#client.presign(key, { expiresIn: 60 }));
    const credential = url.searchParams.get("X-Amz-Credential")?.split("/");
    const region = credential?.[2];
    if (!region) throw new StorageError("Unable to determine S3 signing region", "INVALID_OPTIONS");
    url.search = "";
    const entries = Object.entries(query).map(([name, value]) => [encode(name), encode(value)] as const).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    url.search = entries.map(([name, value]) => `${name}=${value}`).join("&");
    const date = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
    const day = date.slice(0, 8);
    const payloadHash = digest(payload);
    const values: Record<string, string> = { host: url.host, "x-amz-date": date, "x-amz-content-sha256": payloadHash };
    if (sessionToken) values["x-amz-security-token"] = sessionToken;
    if (contentType) values["content-type"] = contentType;
    const names = Object.keys(values).sort();
    const signedHeaders = names.join(";");
    const canonicalHeaders = names.map(name => `${name}:${values[name]!.trim().replace(/\s+/g, " ")}\n`).join("");
    const canonical = `${method}\n${url.pathname}\n${url.search.slice(1)}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
    const scope = `${day}/${region}/s3/aws4_request`;
    const signingKey = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, day), region), "s3"), "aws4_request");
    const signature = hmac(signingKey, `AWS4-HMAC-SHA256\n${date}\n${scope}\n${digest(canonical)}`).toString("hex");
    const headers = new Headers(values);
    headers.delete("host");
    headers.set("authorization", `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`);
    const response = await fetch(url, { method, headers, body: method === "DELETE" ? undefined : payload, signal, redirect: "error" });
    if (!response.ok) {
      await response.body?.cancel();
      throw new S3HttpError(method, response.status);
    }
    return response;
  }
  async #part(key: string, query: Record<string, string>, payload: Uint8Array<ArrayBuffer>, signal: AbortSignal): Promise<string> {
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await this.#request(key, "PUT", query, payload, signal);
        const etag = response.headers.get("etag");
        await response.body?.cancel();
        if (!etag) throw new StorageError("S3 did not return an uploaded part ETag", "PROVIDER_ERROR");
        return etag;
      } catch (error) {
        const retryable = error instanceof S3HttpError ? [429, 500, 502, 503, 504].includes(error.status) : error instanceof TypeError;
        if (signal.aborted || attempt >= this.#retry || !retryable) throw error;
        await new Promise<void>((resolve, reject) => {
          const abort = () => { clearTimeout(timer); reject(signal.reason); };
          const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, Math.min(1000, 50 * 2 ** attempt));
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
        });
      }
    }
  }
  async write(key: string, body: StorageBody, options: WriteOptions): Promise<void> {
    const signal = options.signal ?? new AbortController().signal;
    signal.throwIfAborted();
    const reader = boundedStream(bodyStream(body), options).getReader();
    let uploadId: string | undefined;
    let pending: Uint8Array | undefined;
    let offset = 0;
    let done = false;
    const parts: { number: number; etag: string }[] = [];
    try {
      while (!done) {
        const chunk = new Uint8Array(this.#partSize);
        let size = 0;
        while (size < chunk.byteLength) {
          signal.throwIfAborted();
          if (!pending || offset === pending.byteLength) {
            const result = await reader.read();
            if (result.done) { done = true; break; }
            pending = result.value;
            offset = 0;
            if (!pending.byteLength) continue;
          }
          const count = Math.min(chunk.byteLength - size, pending.byteLength - offset);
          chunk.set(pending.subarray(offset, offset + count), size);
          offset += count;
          size += count;
        }
        if (!size) break;
        if (done && !uploadId) {
          const response = await this.#request(key, "PUT", {}, chunk.subarray(0, size), signal, options.contentType);
          await response.body?.cancel();
          return;
        }
        if (!uploadId) {
          signal.throwIfAborted();
          // Creation is not idempotent: recover the owned UploadId even if the caller
          // cancels while the service is responding, then abort that exact session.
          // Bound both headers and body with a separate deadline; never retry creation.
          const response = await this.#request(key, "POST", { uploads: "" }, new Uint8Array(), AbortSignal.timeout(10_000), options.contentType);
          uploadId = xmlValue(await responseText(response), "UploadId");
          if (!uploadId) throw new StorageError("S3 did not return a multipart upload ID", "PROVIDER_ERROR");
          signal.throwIfAborted();
        }
        const number = parts.length + 1;
        if (number > 10_000) throw new StorageError("S3 multipart upload exceeds 10000 parts", "LIMIT_EXCEEDED");
        const etag = await this.#part(key, { uploadId, partNumber: String(number) }, chunk.subarray(0, size), signal);
        parts.push({ number, etag });
      }
      signal.throwIfAborted();
      if (!uploadId) {
        const response = await this.#request(key, "PUT", {}, new Uint8Array(), signal, options.contentType);
        await response.body?.cancel();
        return;
      }
      const xml = `<CompleteMultipartUpload>${parts.map(part => `<Part><PartNumber>${part.number}</PartNumber><ETag>${xmlEscape(part.etag)}</ETag></Part>`).join("")}</CompleteMultipartUpload>`;
      const response = await this.#request(key, "POST", { uploadId }, new TextEncoder().encode(xml), signal, "application/xml");
      const result = await responseText(response);
      // CompleteMultipartUpload may fail inside an HTTP 200 response.
      if (/<Error(?:\s|>)/.test(result) || !/<CompleteMultipartUploadResult(?:\s|>)/.test(result)) throw new StorageError("S3 multipart completion failed", "PROVIDER_ERROR");
      uploadId = undefined;
    } catch (error) {
      if (uploadId) {
        try {
          const response = await this.#request(key, "DELETE", { uploadId }, new Uint8Array(), AbortSignal.timeout(10_000));
          await response.body?.cancel();
        } catch (cleanupError) {
          // A session may already be absent after completion, concurrent lifecycle cleanup or a lost abort response.
          if (!(cleanupError instanceof S3HttpError && cleanupError.status === 404)) {
            throw new AggregateError([error, cleanupError], "S3 upload failed and multipart cleanup failed; provider lifecycle cleanup may be required");
          }
        }
      }
      throw error;
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}
