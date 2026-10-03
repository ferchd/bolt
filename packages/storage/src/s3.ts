import { S3Client } from "bun";
import {
  boundedStream, listLimit, readBytes, StorageError, validateKey, validateTransfer,
  type ListOptions, type ObjectInfo, type ObjectPage, type PresignOptions, type StorageBody,
  type StorageDisk, type TransferOptions, type WriteOptions,
} from "./contracts.ts";
import { CancellableS3Uploader } from "./s3-upload.ts";

export interface S3StorageOptions {
  bucket: string;
  region?: string;
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  virtualHostedStyle?: boolean;
  /** Original multipart uploader keeps one part in flight and buffers 5–64 MiB per part. */
  partSize?: number;
  queueSize?: number;
  retry?: number;
}
function notFound(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  return code === "NoSuchKey" || code === "NotFound";
}
/** S3, R2, MinIO, Spaces, B2, and GCS with interoperable HMAC credentials. */
export class S3Storage implements StorageDisk {
  readonly capabilities = Object.freeze({ presign: true, atomicWrite: true, multipart: true, abortWrite: true });
  readonly #client: S3Client;
  readonly #cancellableUpload: CancellableS3Uploader;
  constructor(options: S3StorageOptions) {
    if (!options.bucket) throw new StorageError("An S3 bucket is required", "INVALID_OPTIONS");
    if (options.endpoint) {
      const endpoint = new URL(options.endpoint);
      if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
        throw new StorageError("S3 endpoint must be an HTTP(S) URL without credentials or query", "INVALID_OPTIONS");
      }
    }
    for (const value of [options.queueSize, options.retry]) if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) throw new StorageError("Invalid S3 upload settings", "INVALID_OPTIONS");
    if (options.queueSize !== undefined && options.queueSize !== 1) throw new StorageError("S3 uploads support queueSize 1", "UNSUPPORTED");
    if (options.retry !== undefined && options.retry > 10) throw new StorageError("S3 upload retry cannot exceed 10", "INVALID_OPTIONS");
    if (options.partSize !== undefined && (!Number.isSafeInteger(options.partSize) || options.partSize < 5 * 1024 * 1024 || options.partSize > 64 * 1024 * 1024)) throw new StorageError("partSize must be between 5 and 64 MiB", "INVALID_OPTIONS");
    this.#client = new S3Client(options);
    this.#cancellableUpload = new CancellableS3Uploader(this.#client, {
      accessKeyId: options.accessKeyId ?? process.env["S3_ACCESS_KEY_ID"] ?? process.env["AWS_ACCESS_KEY_ID"],
      secretAccessKey: options.secretAccessKey ?? process.env["S3_SECRET_ACCESS_KEY"] ?? process.env["AWS_SECRET_ACCESS_KEY"],
      sessionToken: options.sessionToken ?? process.env["S3_SESSION_TOKEN"] ?? process.env["AWS_SESSION_TOKEN"],
    }, options.partSize, options.retry);
  }
  async stat(key: string): Promise<ObjectInfo | undefined> {
    validateKey(key);
    try {
      const info = await this.#client.file(key).stat();
      return { key, size: info.size, lastModified: info.lastModified, etag: info.etag, contentType: info.type };
    } catch (error) {
      if (!notFound(error)) throw error;
      // HEAD cannot distinguish NoSuchKey from NoSuchBucket. Confirm with signed GET;
      // unlike ListObjectsV2 this does not require another kind of bucket permission.
      const response = await fetch(await this.presign(key), { redirect: "error" });
      if (!response.ok) {
        try { await this.#readError(response); } catch (failure) {
          if (failure instanceof StorageError && failure.code === "NOT_FOUND") return undefined;
          throw failure;
        }
      }
      const length = response.headers.get("content-length");
      await response.body?.cancel();
      if (length === null || !Number.isSafeInteger(Number(length)) || Number(length) < 0) throw new StorageError("S3 did not return an object length", "PROVIDER_ERROR");
      const modified = response.headers.get("last-modified");
      return { key, size: Number(length), contentType: response.headers.get("content-type") ?? undefined, etag: response.headers.get("etag") ?? undefined, lastModified: modified ? new Date(modified) : undefined };
    }
  }
  async #readError(response: Response, signal?: AbortSignal): Promise<never> {
    if (response.status === 404) {
      const content = new TextDecoder().decode(await readBytes(boundedStream(response.body ?? new ReadableStream({ start(controller) { controller.close(); } }), { maxBytes: 1024 * 1024, signal })));
      const code = /<Code>([^<]+)<\/Code>/.exec(content)?.[1];
      if (code === "NoSuchKey" || code === "NotFound") throw new StorageError("Object does not exist", "NOT_FOUND");
    } else await response.body?.cancel();
    throw new StorageError(`S3 read failed with HTTP ${response.status}`, "PROVIDER_ERROR");
  }
  async exists(key: string): Promise<boolean> { return (await this.stat(key)) !== undefined; }
  async read(key: string, options: TransferOptions = {}): Promise<Uint8Array> {
    return readBytes(await this.readStream(key, { ...options, maxBytes: options.maxBytes ?? 64 * 1024 * 1024 }));
  }
  async readStream(key: string, options: TransferOptions = {}): Promise<ReadableStream<Uint8Array>> {
    validateTransfer(options);
    const url = await this.presign(key);
    const response = await fetch(url, { signal: options.signal, redirect: "error" });
    if (!response.ok) return this.#readError(response, options.signal);
    const length = response.headers.get("content-length");
    if (options.maxBytes !== undefined && length !== null && Number(length) > options.maxBytes) {
      await response.body?.cancel();
      throw new StorageError("Transfer exceeds maxBytes", "LIMIT_EXCEEDED");
    }
    return boundedStream(response.body ?? new ReadableStream({ start(controller) { controller.close(); } }), options);
  }
  async write(key: string, body: StorageBody, options: WriteOptions = {}): Promise<void> {
    validateKey(key);
    validateTransfer(options);
    if (options.contentType && /[\r\n]/.test(options.contentType)) throw new StorageError("Invalid content type", "INVALID_OPTIONS");
    return this.#cancellableUpload.write(key, body, options);
  }
  async delete(key: string): Promise<void> {
    validateKey(key);
    try { await this.#client.delete(key); } catch (error) { if (!notFound(error)) throw error; }
  }
  async list(options: ListOptions = {}): Promise<ObjectPage> {
    const prefix = options.prefix ?? "";
    if (prefix) validateKey(prefix.endsWith("/") ? prefix.slice(0, -1) : prefix);
    const page = await this.#client.list({ prefix, continuationToken: options.cursor, maxKeys: listLimit(options.limit) });
    const objects = (page.contents ?? []).map(item => ({
      key: item.key, size: item.size ?? 0,
      lastModified: item.lastModified ? new Date(item.lastModified) : undefined,
      etag: item.eTag,
    }));
    if (page.isTruncated && !page.nextContinuationToken) throw new StorageError("S3 returned an incomplete page without a cursor", "PROVIDER_ERROR");
    return { objects, cursor: page.isTruncated ? page.nextContinuationToken : undefined };
  }
  /** Streaming transfer, not a server-side copy; metadata is not preserved. */
  async copy(source: string, destination: string, options: TransferOptions = {}): Promise<void> {
    validateKey(destination);
    const stream = await this.readStream(source, options);
    try { await this.write(destination, stream, options); } catch (error) { await stream.cancel(error).catch(() => {}); throw error; }
  }
  async presign(key: string, options: PresignOptions = {}): Promise<string> {
    validateKey(key);
    const expiresIn = options.expiresIn ?? 900;
    if (!Number.isInteger(expiresIn) || expiresIn < 1 || expiresIn > 604800) throw new StorageError("Presign expiration must be between 1 and 604800 seconds", "INVALID_OPTIONS");
    return this.#client.presign(key, { method: options.method ?? "GET", expiresIn, type: options.contentType });
  }
}
