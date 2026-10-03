# Local S3 integration service

This isolated service runs the official Floci 1.5.8 image at its validated digest. It stores data in memory, exposes only a loopback port, needs no Docker socket, and uses fictional credentials. It is a test emulator, not production storage. It does not validate AWS authentication by itself; Bolt's independent HTTP fixture verifies SigV4 signatures and payload digests.

```sh
docker compose -p bolt-s3-test -f infra/s3-test/compose.yaml up -d
curl --fail --request PUT http://127.0.0.1:19083/bolt-storage-integration
BOLT_S3_ENDPOINT=http://127.0.0.1:19083 \
BOLT_S3_BUCKET=bolt-storage-integration \
BOLT_S3_ACCESS_KEY_ID=bolt-test-access \
BOLT_S3_SECRET_ACCESS_KEY=bolt-test-secret \
bun test packages/storage/tests
```

On PowerShell, set those four environment variables with `$env:NAME='value'` before running `bun test`. Use `curl.exe` for the bucket creation request. `BOLT_S3_TEST_PORT` changes the host port in Compose. Integration tests create unique object prefixes and remove their own objects.

After testing, verify there are no abandoned uploads:

```sh
curl --fail 'http://127.0.0.1:19083/bolt-storage-integration?uploads'
docker compose -p bolt-s3-test -f infra/s3-test/compose.yaml down
```

Use a unique Compose project name and bucket name when running multiple sessions. Stop only that project. No external bucket or existing Docker volume is touched. The image is a test dependency and is not included in Bolt packages or application runtime dependencies.
