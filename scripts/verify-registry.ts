import { mkdtempSync, readdirSync, readFileSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { smokeApplication } from "./consumer-smoke.ts";

const token = Bun.env["BOLT_GITLAB_TOKEN"];
if (!token) throw new Error("Set BOLT_GITLAB_TOKEN with read access to the canonical GitLab registry");
const root = resolve(import.meta.dir, "..");
const temporary = mkdtempSync(join(tmpdir(), "bolt-registry-consumer-"));
const dependencies = Object.fromEntries(readdirSync(join(root, "packages"), { withFileTypes: true })
  .filter(entry => entry.isDirectory())
  .map(entry => JSON.parse(readFileSync(join(root, "packages", entry.name, "package.json"), "utf8")) as { name: string; version: string })
  .map(manifest => [manifest.name, manifest.version]));
try {
  mkdirSync(join(temporary, "src"));
  writeFileSync(join(temporary, "package.json"), JSON.stringify({ name: "bolt-registry-consumer", private: true, type: "module", dependencies, devDependencies: { "@types/bun": "1.4.2", typescript: "7.0.2" } }));
  writeFileSync(join(temporary, ".npmrc"), "@bolt:registry=https://gitlab.com/api/v4/projects/87197832/packages/npm/\n//gitlab.com/api/v4/projects/87197832/packages/npm/:_authToken=${BOLT_GITLAB_TOKEN}\n");
  writeFileSync(join(temporary, "tsconfig.json"), JSON.stringify({ compilerOptions: { allowImportingTsExtensions: true, lib: ["ESNext", "DOM"], module: "Preserve", moduleResolution: "bundler", noEmit: true, strict: true, target: "ESNext", types: ["bun"] }, include: ["src/**/*.ts"] }));
  writeFileSync(join(temporary, "src/index.ts"), smokeApplication());
  if (Bun.argv.includes("--services")) writeFileSync(join(temporary, "src/services.ts"), readFileSync(join(root, "scripts/registry-services-smoke.ts.template")));
  await run([process.execPath, "install", "--ignore-scripts"]);
  await run([process.execPath, join(temporary, "node_modules/typescript/bin/tsc"), "--project", "tsconfig.json"]);
  await run([process.execPath, "run", "src/index.ts"]);
  if (Bun.argv.includes("--services")) await run([process.execPath, "run", "src/services.ts"]);
  console.log(`Verified ${Object.keys(dependencies).length} published packages installed by name and version from GitLab.`);
} finally { rmSync(temporary, { recursive: true, force: true }); }

async function run(command: string[]): Promise<void> {
  const child = Bun.spawn(command, { cwd: temporary, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(`Registry consumer command failed (${code}): ${stdout}${stderr}`.replaceAll(token!, "[REDACTED]"));
}
