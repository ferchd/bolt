export type StorageBody = string | Uint8Array | ArrayBuffer | Blob | ReadableStream<Uint8Array>;
export interface TransferOptions { signal?: AbortSignal; maxBytes?: number }
export interface WriteOptions extends TransferOptions { contentType?: string }
export interface ObjectInfo { key: string; size: number; lastModified?: Date; etag?: string; contentType?: string }
export interface ListOptions { prefix?: string; cursor?: string; limit?: number }
export interface ObjectPage { objects: ObjectInfo[]; cursor?: string }
export interface PresignOptions { method?: "GET" | "PUT"; expiresIn?: number; contentType?: string }
export interface StorageCapabilities {
  presign: boolean;
  /** Writes publish only after their full content has been accepted. */
  atomicWrite: boolean;
  multipart: boolean;
  /** Cancellation interrupts the upload, including transport. */
  abortWrite: boolean;
}
/** Implement this contract to register another original storage provider. */
export interface StorageDisk {
  readonly capabilities: Readonly<StorageCapabilities>;
  read(key: string, options?: TransferOptions): Promise<Uint8Array>;
  readStream(key: string, options?: TransferOptions): Promise<ReadableStream<Uint8Array>>;
  write(key: string, body: StorageBody, options?: WriteOptions): Promise<void>;
  stat(key: string): Promise<ObjectInfo | undefined>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  list(options?: ListOptions): Promise<ObjectPage>;
  copy(source: string, destination: string, options?: TransferOptions): Promise<void>;
  presign(key: string, options?: PresignOptions): Promise<string>;
}
export class StorageError extends Error {
  constructor(message: string, readonly code: "INVALID_KEY" | "NOT_FOUND" | "UNSUPPORTED" | "LIMIT_EXCEEDED" | "INVALID_OPTIONS" | "PROVIDER_ERROR") {
    super(message);
    this.name = "StorageError";
  }
}
export function unsupported(operation: string): never { throw new StorageError(`Storage provider does not support ${operation}`, "UNSUPPORTED"); }
export function validateKey(key: string): string {
  if (!key || key.length > 1024 || /[\\:\x00-\x1f\x7f]/.test(key) || key.split("/").some(segment =>
    !segment || segment === "." || segment === ".." || /[. ]$/.test(segment) || /^\.bolt-write-/.test(segment) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment))) {
    throw new StorageError("Object keys must be safe relative paths", "INVALID_KEY");
  }
  return key;
}
export function validateTransfer(options: TransferOptions): void {
  if (options.maxBytes !== undefined && (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0)) {
    throw new StorageError("maxBytes must be a non-negative safe integer", "INVALID_OPTIONS");
  }
  options.signal?.throwIfAborted();
}
export function listLimit(limit = 100): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new StorageError("List limit must be between 1 and 1000", "INVALID_OPTIONS");
  return limit;
}
export function bodyStream(body: StorageBody): ReadableStream<Uint8Array> {
  if (body instanceof ReadableStream) return body;
  if (body instanceof Blob) return body.stream();
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body instanceof Uint8Array ? body : new Uint8Array(body);
  return new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } });
}
/** Pull only as fast as the consumer; cancel upstream on limits, abort, or failure. */
export function boundedStream(source: ReadableStream<Uint8Array>, options: TransferOptions = {}): ReadableStream<Uint8Array> {
  validateTransfer(options);
  const reader = source.getReader();
  let size = 0;
  let completed = false;
  let abort: (() => void) | undefined;
  const cleanup = () => { if (abort) options.signal?.removeEventListener("abort", abort); };
  return new ReadableStream<Uint8Array>({
    start(controller) {
      abort = () => {
        if (completed) return;
        completed = true;
        cleanup();
        const reason = options.signal?.reason ?? new DOMException("Transfer aborted", "AbortError");
        controller.error(reason);
        void reader.cancel(reason).catch(() => {});
      };
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) abort();
    },
    async pull(controller) {
      if (completed) return;
      try {
        const next = await reader.read();
        if (completed) return;
        if (next.done) { completed = true; cleanup(); controller.close(); return; }
        size += next.value.byteLength;
        if (options.maxBytes !== undefined && size > options.maxBytes) throw new StorageError("Transfer exceeds maxBytes", "LIMIT_EXCEEDED");
        controller.enqueue(next.value);
      } catch (error) {
        if (!completed) { completed = true; cleanup(); controller.error(error); }
        await reader.cancel(error).catch(() => {});
      }
    },
    async cancel(reason) { completed = true; cleanup(); await reader.cancel(reason); },
  });
}
export async function readBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
