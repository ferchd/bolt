import {
  existsSync,
  mkdirSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, relative, resolve, sep } from "node:path";

interface FilePlan {
  readonly path: string;
  readonly source: string;
}

export function scaffoldApplication(baseDirectory: string, target: string): string {
  const root = resolve(baseDirectory, target);

  if (existsSync(root) && readdirSync(root).length > 0) {
    throw new Error(`Target directory is not empty: ${root}`);
  }

  const packageName = toPackageName(basename(root));
  const files: readonly FilePlan[] = [
    {
      path: resolve(root, "package.json"),
      source: `${JSON.stringify(applicationPackage(packageName), null, 2)}\n`,
    },
    {
      path: resolve(root, "tsconfig.json"),
      source: `${JSON.stringify(applicationTsconfig(), null, 2)}\n`,
    },
    { path: resolve(root, ".gitignore"), source: applicationGitignore },
    { path: resolve(root, "src/application.ts"), source: applicationSource },
    { path: resolve(root, "src/main.ts"), source: mainSource },
  ];

  writePlan(root, files);
  return root;
}

export function scaffoldController(
  baseDirectory: string,
  name: string,
): string {
  const segments = parseName(name);
  const className = `${toPascalCase(segments.at(-1) ?? "")}Controller`;
  const folders = segments.slice(0, -1).map(toKebabCase);
  const filename = `${toKebabCase(segments.at(-1) ?? "")}-controller.ts`;
  const path = resolve(
    baseDirectory,
    "src",
    "controllers",
    ...folders,
    filename,
  );

  writePlan(baseDirectory, [
    {
      path,
      source: `import type { HttpContext } from "@bolt/http";\n\nexport default class ${className} {\n  public handle(context: HttpContext): unknown {\n    return { path: context.url.pathname };\n  }\n}\n`,
    },
  ]);

  return path;
}

export function scaffoldMigration(
  baseDirectory: string,
  name: string,
  now: Date,
): string {
  const segments = parseName(name);
  const slug = segments.map(toSnakeCase).join("_");
  const id = `${formatTimestamp(now)}_${slug}`;
  const path = resolve(baseDirectory, "database", "migrations", `${id}.ts`);

  writePlan(baseDirectory, [
    {
      path,
      source: `import type { Migration } from "@bolt/database";\n\nexport default {\n  id: "${id}",\n  up(database) {\n    void database;\n  },\n} satisfies Migration;\n`,
    },
  ]);

  return path;
}

function writePlan(root: string, files: readonly FilePlan[]): void {
  for (const file of files) {
    assertWithin(root, file.path);

    if (existsSync(file.path)) {
      throw new Error(`Refusing to overwrite existing file: ${file.path}`);
    }
  }

  for (const file of files) {
    mkdirSync(dirname(file.path), { recursive: true });
    writeFileSync(file.path, file.source, { encoding: "utf8", flag: "wx" });
  }
}

function assertWithin(root: string, path: string): void {
  const pathFromRoot = relative(resolve(root), resolve(path));

  if (
    pathFromRoot === "" ||
    pathFromRoot === ".." ||
    pathFromRoot.startsWith(`..${sep}`)
  ) {
    throw new Error(`Generated path escapes its target directory: ${path}`);
  }
}

function parseName(name: string): string[] {
  const segments = name.split(/[\\/]/).filter(Boolean);

  if (
    segments.length === 0 ||
    segments.some(
      (segment) =>
        segment === "." ||
        segment === ".." ||
        !/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(segment),
    )
  ) {
    throw new TypeError(
      "Names must contain safe path segments starting with a letter",
    );
  }

  return segments;
}

function toPascalCase(value: string): string {
  return value
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase()}${part.slice(1)}`)
    .join("");
}

function toKebabCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/_/g, "-")
    .toLowerCase();
}

function toSnakeCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/-/g, "_")
    .toLowerCase();
}

function toPackageName(value: string): string {
  const name = toKebabCase(value).replace(/[^a-z0-9-]/g, "-");
  return name || "bolt-app";
}

function formatTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:T]/g, "").slice(0, 14);
}

function applicationPackage(name: string): object {
  return {
    name,
    private: true,
    type: "module",
    scripts: {
      dev: "bolt dev",
      start: "bolt start",
      test: "bolt test",
      routes: "bolt routes",
      migrate: "bolt migrate",
      "migrate:status": "bolt migrate:status",
    },
    dependencies: {
      "@bolt/cli": "latest",
      "@bolt/database": "latest",
      "@bolt/http": "latest",
      "@bolt/kernel": "latest",
      "@bolt/router": "latest",
    },
    devDependencies: {
      "@types/bun": "latest",
      typescript: "latest",
    },
  };
}

function applicationTsconfig(): object {
  return {
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
    include: ["src/**/*.ts", "tests/**/*.ts"],
  };
}

const applicationGitignore = `node_modules\n.env\nstorage/*.sqlite*\n`;

const applicationSource = `import { Database } from "@bolt/database";\nimport { BoltApplication } from "@bolt/kernel";\nimport { Router } from "@bolt/router";\n\nexport const database = Database.create();\nexport const router = Router.create();\n\nrouter.get("/", () => ({ hello: "world" }));\n\nexport const application = BoltApplication.create({ router }).use(database);\n`;

const mainSource = `import { application } from "./application.ts";\n\nawait application.start();\n`;
