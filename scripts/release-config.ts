import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Bun workspaces resolve registry settings at their root; pass an explicit scoped config. */
export async function withPublishConfiguration<T>(registry: string, callback: (path: string) => Promise<T>): Promise<T> {
  const directory = mkdtempSync(join(tmpdir(), "bolt-publish-config-"));
  const path = join(directory, "bunfig.toml");
  try {
    // Only an environment reference is written, never the credential itself.
    writeFileSync(path, `[install.scopes]\n"@bolt" = { url = ${JSON.stringify(registry)}, token = "$CI_JOB_TOKEN" }\n`, { flag: "wx", mode: 0o600 });
    return await callback(path);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
