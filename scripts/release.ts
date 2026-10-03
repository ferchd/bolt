import { readdirSync, readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const registry = "https://gitlab.com/api/v4/projects/87197832/packages/npm/";
interface Manifest {
  name: string;
  version: string;
  private?: boolean;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  publishConfig?: { registry?: string };
}
const packages = readdirSync(join(root, "packages"), { withFileTypes: true })
  .filter(entry => entry.isDirectory())
  .map(entry => {
    const directory = join(root, "packages", entry.name);
    return { directory, manifest: JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as Manifest };
  });

const version = packages[0]?.manifest.version;
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const releaseVersion = version ? semver.exec(version) : null;
if (!releaseVersion || version === "0.0.0") {
  throw new Error("A concrete SemVer release is required");
}
const byName = new Map(packages.map(entry => [entry.manifest.name, entry]));
if (byName.size !== packages.length) throw new Error("Duplicate package names in release");
for (const { manifest } of packages) {
  if (manifest.private || manifest.version !== version || manifest.publishConfig?.registry !== registry) {
    throw new Error(`Invalid release metadata for ${manifest.name}`);
  }
  for (const [name, range] of Object.entries(runtimeDependencies(manifest))) {
    if (!name.startsWith("@bolt/") || !byName.has(name) || range !== "workspace:*") {
      throw new Error(`Unexpected runtime dependency in ${manifest.name}: ${name}`);
    }
  }
}

// Topological publication prevents consumers from observing references to absent dependencies.
const ordered: typeof packages = [];
const visiting = new Set<string>();
const visited = new Set<string>();
function visit(name: string): void {
  if (visited.has(name)) return;
  if (visiting.has(name)) throw new Error("Cyclic package dependency graph");
  visiting.add(name);
  const entry = byName.get(name)!;
  for (const dependency of Object.keys(runtimeDependencies(entry.manifest))) visit(dependency);
  visiting.delete(name);
  visited.add(name);
  ordered.push(entry);
}
for (const name of byName.keys()) visit(name);

if (!Bun.argv.includes("--publish")) {
  console.log(`Release ${version}: ${ordered.length} packages; runtime dependencies are all first-party Bolt packages.`);
  console.log(`Registry: ${registry}`);
} else {
  if (Bun.env["CI_PROJECT_PATH"] !== "ferchd/bolt" || Bun.env["CI_PROJECT_ID"] !== "87197832" ||
      Bun.env["CI_COMMIT_TAG"] !== `v${version}` || Bun.env["CI_COMMIT_REF_PROTECTED"] !== "true" ||
      !Bun.env["CI_JOB_TOKEN"]) {
    throw new Error("Publishing requires a protected matching release tag in the canonical GitLab project");
  }
  for (const { directory, manifest } of ordered) {
    const config = join(directory, ".npmrc");
    if (existsSync(config)) throw new Error(`Refusing to replace package registry configuration: ${manifest.name}`);
    // The file contains a variable reference, never the credential itself.
    writeFileSync(config, `@bolt:registry=${registry}\n//gitlab.com/api/v4/projects/87197832/packages/npm/:_authToken=\${CI_JOB_TOKEN}\n`, { flag: "wx" });
    try {
      const child = Bun.spawn([process.execPath, "publish", "--ignore-scripts", "--registry", registry, ...(releaseVersion[4] ? ["--tag", "next"] : [])], {
        cwd: directory,
        stdin: "ignore",
        stdout: "inherit",
        stderr: "inherit",
      });
      if (await child.exited !== 0) throw new Error(`Publishing failed for ${manifest.name}`);
    } finally {
      unlinkSync(config);
    }
  }
}

function runtimeDependencies(manifest: Manifest): Record<string, string> {
  const result: Record<string, string> = {};
  for (const dependencies of [manifest.dependencies, manifest.optionalDependencies, manifest.peerDependencies]) {
    for (const [name, range] of Object.entries(dependencies ?? {})) {
      if (result[name] && result[name] !== range) throw new Error(`Conflicting runtime dependency in ${manifest.name}: ${name}`);
      result[name] = range;
    }
  }
  return result;
}
