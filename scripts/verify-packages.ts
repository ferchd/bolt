import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

interface PackageManifest {
  readonly name: string;
}

const root = resolve(import.meta.dir, "..");
const temporaryRoot = mkdtempSync(join(tmpdir(), "bolt-packages-"));
const artifacts = join(temporaryRoot, "artifacts");
const consumer = join(temporaryRoot, "consumer");

try {
  mkdirSync(artifacts);
  mkdirSync(join(consumer, "src"), { recursive: true });

  const packages = readdirSync(join(root, "packages"), {
    withFileTypes: true,
  })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, "packages", entry.name))
    .filter((directory) => Bun.file(join(directory, "package.json")).size > 0)
    .map((directory) => ({
      directory,
      manifest: JSON.parse(
        readFileSync(join(directory, "package.json"), "utf8"),
      ) as PackageManifest,
    }))
    .sort((left, right) => left.manifest.name.localeCompare(right.manifest.name));

  const dependencies: Record<string, string> = {};

  for (const entry of packages) {
    const filename = `${entry.manifest.name.replace("@", "").replace("/", "-")}.tgz`;
    const archive = join(artifacts, filename);

    await run(
      [
        process.execPath,
        "pm",
        "pack",
        "--ignore-scripts",
        "--filename",
        archive,
      ],
      entry.directory,
    );

    dependencies[entry.manifest.name] = fileDependency(archive);
  }

  writeJson(join(consumer, "package.json"), {
    name: "bolt-external-consumer",
    private: true,
    type: "module",
    dependencies,
    devDependencies: {
      "@types/bun": "1.4.2",
      typescript: "7.0.2",
    },
    overrides: dependencies,
  });
  writeJson(join(consumer, "tsconfig.json"), {
    compilerOptions: {
      allowImportingTsExtensions: true,
      lib: ["ESNext", "DOM"],
      module: "Preserve",
      moduleResolution: "bundler",
      noEmit: true,
      strict: true,
      target: "ESNext",
      types: ["bun"],
    },
    include: ["src/**/*.ts"],
  });
  writeFileSync(join(consumer, "src", "index.ts"), smokeApplication());

  await run([process.execPath, "install", "--ignore-scripts"], consumer);
  await run(
    [
      process.execPath,
      join(consumer, "node_modules", "typescript", "bin", "tsc"),
      "--project",
      "tsconfig.json",
    ],
    consumer,
  );
  await run([process.execPath, "run", "src/index.ts"], consumer);

  console.log(`Verified ${packages.length} package tarballs with an external consumer.`);
} finally {
  rmSync(temporaryRoot, { force: true, recursive: true });
}

async function run(command: readonly string[], cwd: string): Promise<void> {
  const process = Bun.spawn([...command], {
    cwd,
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stderr, stdout] = await Promise.all([
    process.exited,
    new Response(process.stderr).text(),
    new Response(process.stdout).text(),
  ]);

  if (exitCode !== 0) {
    throw new Error(
      `Command failed (${command.join(" ")})\n${stdout}${stderr}`.trim(),
    );
  }
}

function fileDependency(path: string): string {
  return `file:${path.replaceAll("\\", "/")}`;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function smokeApplication(): string {
  return `import { runCli } from "@bolt/cli";
import { Environment } from "@bolt/config";
import { createToken, provideValue } from "@bolt/container";
import { Database } from "@bolt/database";
import { HttpError } from "@bolt/http";
import { BoltApplication } from "@bolt/kernel";
import { Logger } from "@bolt/logger";
import { Router } from "@bolt/router";
import { secureHeaders } from "@bolt/security";
import { TestClient } from "@bolt/testing";
import v from "@bolt/validation";

const message = createToken<string>("message");
const router = Router.create();

router
  .get("/", (context) => ({ message: context.resolve(message) }))
  .use(secureHeaders());

const application = BoltApplication.create({
  bindings: [provideValue(message, "ready")],
  development: false,
  hostname: "127.0.0.1",
  port: 0,
  router,
  shutdownSignals: false,
});
const client = TestClient.create(application);
const response = await client.get("/");

if (response.status !== 200 || (await response.json()).message !== "ready") {
  throw new Error("Packaged application smoke test failed");
}

const database = Database.create({ filename: ":memory:" });
database.start({ migrate: false });
database.stop();

if (Environment.create({ PORT: "3000" }).integer("PORT") !== 3000) {
  throw new Error("Packaged config smoke test failed");
}

if (v.uuid().safeParse(crypto.randomUUID()).success !== true) {
  throw new Error("Packaged validation smoke test failed");
}

Logger.create({ level: "silent" }).info("ignored");
void new HttpError(400, "smoke");

const cliOutput: string[] = [];
if (await runCli({
  argv: ["help"],
  io: { error: (value) => cliOutput.push(value), log: (value) => cliOutput.push(value) },
}) !== 0 || cliOutput.length !== 1) {
  throw new Error("Packaged CLI smoke test failed");
}

await client.close();
`;
}
