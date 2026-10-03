import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withPublishConfiguration } from "../release-config.ts";

test("Bun publishes with explicit scoped environment credentials and cleans its config", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bolt-publish-probe-"));
  const token = "bolt-publish-fixture-token";
  let authenticated = false;
  let configPath = "";
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    authenticated = request.method === "PUT" && request.headers.get("authorization") === `Bearer ${token}`;
    await request.arrayBuffer();
    return Response.json({ ok: authenticated }, { status: authenticated ? 201 : 401 });
  } });
  try {
    const packageDirectory = join(directory, "packages/probe");
    mkdirSync(packageDirectory, { recursive: true });
    writeFileSync(join(directory, "package.json"), JSON.stringify({ private: true, workspaces: ["packages/*"] }));
    writeFileSync(join(directory, "bunfig.toml"), `[install.scopes]\n"@bolt" = ${JSON.stringify(server.url.toString())}\n`);
    writeFileSync(join(packageDirectory, "package.json"), JSON.stringify({ name: "@bolt/publish-probe", version: "0.0.0", files: ["index.ts"], publishConfig: { registry: server.url.toString() } }));
    writeFileSync(join(packageDirectory, "index.ts"), "export const probe = true;\n");
    await withPublishConfiguration(server.url.toString(), async config => {
      configPath = config;
      expect(readFileSync(config, "utf8")).not.toContain(token);
      const child = Bun.spawn([process.execPath, "publish", "--ignore-scripts", `--config=${config}`, "--registry", server.url.toString()], { cwd: packageDirectory, env: { ...process.env, CI_JOB_TOKEN: token }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      const [code, output, errors] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      if (code !== 0) throw new Error(`Bun fixture publication failed (${code}): ${(output + errors).replaceAll(token, "[REDACTED]")}`);
      expect(authenticated).toBe(true);
    });
    expect(existsSync(configPath)).toBe(false);
  } finally { server.stop(true); rmSync(directory, { recursive: true, force: true }); }
}, 30_000);
