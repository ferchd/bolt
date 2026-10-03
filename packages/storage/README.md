# @bolt/storage

Original storage contracts and adapters using only Bun and operating-system APIs. No runtime dependencies. Register application-owned disks and choose providers independently of application structure.

```ts
import { LocalStorage, S3Storage, StorageManager } from "@bolt/storage";

const storage = new StorageManager("uploads")
  .register("uploads", () => new LocalStorage({ root: "./var/uploads" }))
  .register("objects", () => new S3Storage({
    bucket: "documents",
    endpoint: process.env["S3_ENDPOINT"],
    accessKeyId: process.env["S3_ACCESS_KEY_ID"],
    secretAccessKey: process.env["S3_SECRET_ACCESS_KEY"],
  }));

await storage.disk().write("reports/2026.pdf", requestBodyStream, {
  maxBytes: 20 * 1024 * 1024,
  signal: request.signal,
});
const response = new Response(await storage.disk().readStream("reports/2026.pdf"));
const page = await storage.disk().list({ prefix: "reports/", limit: 50 });
const next = page.cursor ? await storage.disk().list({ prefix: "reports/", cursor: page.cursor }) : undefined;
const uploadUrl = await storage.disk("objects").presign("reports/2026.pdf", { method: "PUT", expiresIn: 300 });
```

## Guarantees

- `stat` returns `undefined` for an absent object; `exists` returns `false`. Read operations reject with `StorageError` code `NOT_FOUND`. Permission, transport and provider errors propagate; they are never converted to absence. Delete is idempotent.
- Keys are portable relative paths. Absolute paths, traversal segments, backslashes, control characters, Windows device names and alternate data streams are rejected. Listing prefixes can end with `/`.
- `read` buffers at most 64 MiB by default; supply `maxBytes` explicitly to override. `readStream` applies backpressure without buffering the entire object. `maxBytes` checks every received chunk, including streams whose length is unknown.
- Local writes use private same-directory temporary files, sync and rename. Failed, aborted or oversized writes preserve existing content and remove temporary files. Publish operations for the same key serialize per adapter instance, including on Windows. A successful rename provides filesystem atomicity, not a multi-file transaction or a guarantee against power loss before directory metadata is persisted.
- Local reads and writes support real `AbortSignal` cancellation, including cancellation while waiting for input. S3 reads use native presigning plus `fetch`, so abort cancels their transport. S3 writes and copies use Bolt's original SigV4 transport with `fetch`; cancellation interrupts the current HTTP request and input stream, and aborts the multipart session with a separate request. `abortWrite` is supported by both adapters.
- S3 uploads use a single PUT for content smaller than one part, and original multipart uploads for larger content. Parts are streamed with backpressure and buffered individually; `partSize` is 5–64 MiB (default 5 MiB), with one part in flight. `queueSize` supports only 1 and rejects other values. `retry` is 0–10 (default 3) and retries only idempotent part PUTs on transport failures or HTTP 429/500/502/503/504 with bounded backoff. Initiation and completion are not blindly retried.
- Input failures and cancellation send `AbortMultipartUpload` independently of the cancelled signal, with a 10-second cleanup deadline. Cleanup failures are surfaced as `AggregateError` containing the original failure and cleanup failure. A successful PUT or multipart completion publishes complete content. Cancellation or loss of a response during initiation/completion can leave the outcome unknown: the provider may have accepted the request before the connection was closed. Bolt cannot undo a commit that the server already accepted or abort an upload whose ID was never received. Configure bucket lifecycle cleanup for abandoned multipart uploads. Bolt never deletes an existing object merely to recover from upload failure.
- Copy is a streaming transfer and does not preserve metadata. Local content types are not persisted; S3 supports content type on upload and reports provider metadata. Presigning is unsupported on local disks and raises `UNSUPPORTED`.
- Listing limits are 1–1000. Local cursors bind to their prefix and use lexicographic key order; listings are not snapshots and may observe concurrent updates. Local traversal has a configurable work bound (`maxListingEntries`, default 100,000). S3 cursors are provider continuation tokens and must be reused with the same prefix.

The local root is application-owned and must not be writable by untrusted OS users. Existing symbolic links are rejected during resolution; listings skip links and internal temporary files. These checks do not eliminate adversarial filesystem replacement races or hard links created by another OS process. Keep storage outside a publicly served static directory and isolate OS permissions.

## Providers and extension

`S3Storage` uses [`Bun.S3Client`](https://bun.com/docs/runtime/s3) for endpoint resolution, presigning, metadata, listing and deletion, and original [SigV4 multipart requests](https://docs.aws.amazon.com/AmazonS3/latest/API/API_CreateMultipartUpload.html) for uploads. It targets S3-compatible services, including AWS S3, MinIO, R2, Spaces and B2. Google Cloud Storage interoperability uses its S3 endpoint and HMAC credentials. Native GCS OAuth, automatic IAM role credential refresh, S3 Express session handling and Azure Blob REST authentication are not implemented. Explicit credentials or S3/AWS environment credentials are required for uploads. Implement `StorageDisk` with explicit `capabilities` and register it with `StorageManager` to add another provider; unsupported operations must fail explicitly.

Credentials are held in private fields and Bun's client and are never logged by Bolt. Session tokens are included in signed requests when configured. Presigned URLs themselves grant temporary access; callers should treat them as sensitive. S3 `endpoint` accepts HTTP for local test services; production configurations should use HTTPS.

## Validation

`bun test packages/storage/tests` exercises real local I/O and a controlled HTTP S3 fixture. The fixture independently verifies AWS SigV4 signatures and payload digests for actual requests and presigned URLs, checks ListObjectsV2 pagination, performs multipart completion, and verifies cleanup after failed multipart input. It tests HTTP 200 completion error documents, cleanup failure propagation, and an active upload against a throttled HTTP server whose socket teardown is observed after cancellation.

The integration tests run against a pre-existing test bucket when `BOLT_S3_ENDPOINT` and `BOLT_S3_BUCKET` are set. Supply `BOLT_S3_ACCESS_KEY_ID`, `BOLT_S3_SECRET_ACCESS_KEY` and optionally `BOLT_S3_REGION`; otherwise S3/AWS environment credentials are used. They write unique `bolt-integration/<uuid>/` and `bolt-cancelable/<uuid>/` keys, test 12 MiB multipart uploads, signed PUTs, Unicode keys, limits and cancellation, and delete their own keys. Without configuration they are explicitly skipped. No bucket is created or deleted by the tests.

Bolt's full storage suite has been validated against official Floci 1.5.8 at a pinned image digest (see `infra/s3-test/`). Floci has S3 authentication enforcement disabled in this local configuration. The independent fixture covers signature validity and payload hashing; this does not validate live AWS IAM policies or certify AWS service behavior. MinIO's official community binary download returned HTTP 410 and official image pulls failed in the validation environment; MinIO and live AWS/R2/GCS are not claimed as tested.
