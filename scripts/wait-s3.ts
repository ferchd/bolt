/** Provision a disposable Floci bucket; never run this against a production S3 endpoint. */
const endpoint = Bun.env["BOLT_S3_ENDPOINT"];
const bucket = Bun.env["BOLT_S3_BUCKET"];
if (Bun.env["BOLT_S3_TEST_EMULATOR"] !== "floci" || !endpoint || !bucket || !/^[a-z0-9-]+$/.test(bucket)) {
  throw new Error("Floci test provisioning requires BOLT_S3_TEST_EMULATOR=floci, endpoint and bucket");
}
const url = new URL(endpoint);
if (url.protocol !== "http:" || !["floci", "localhost", "127.0.0.1"].includes(url.hostname)) throw new Error("Refusing to provision an external S3 endpoint");
url.pathname = `/${bucket}`;
const deadline = Date.now() + 90000;
let ready = false;
while (Date.now() < deadline) {
  try {
    const response = await fetch(url, { method: "PUT", signal: AbortSignal.timeout(2000) });
    const body = await response.text();
    if (response.ok || (response.status === 409 && body.includes("BucketAlreadyOwnedByYou"))) { ready = true; break; }
  } catch { /* Emulator is still starting. */ }
  await Bun.sleep(500);
}
if (!ready) throw new Error("Floci test service did not become ready");
console.log("Floci S3 test bucket is ready");
