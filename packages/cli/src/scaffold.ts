import {
  existsSync, lstatSync, mkdirSync, readFileSync, readdirSync,
  realpathSync, unlinkSync, writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { defaultPaths, type BoltProjectConfig } from "./config.ts";

const boltVersion = installedCliVersion();

interface FilePlan { readonly path: string; readonly source: string }
export interface ScaffoldOptions {
  readonly config?: BoltProjectConfig;
  readonly path?: string;
  readonly template?: string;
  readonly dryRun?: boolean;
  readonly database?: string;
  readonly onPlan?: (path: string) => void;
}

export function scaffoldApplication(baseDirectory: string, target: string, options: ScaffoldOptions = {}): string {
  const root = resolve(baseDirectory, target);
  if (root !== resolve(baseDirectory)) assertWithin(baseDirectory, root);
  assertNoSymlinks(root);
  if (existsSync(root) && (!lstatSync(root).isDirectory() || readdirSync(root).length > 0)) {
    throw new Error(`Target directory is not empty: ${root}`);
  }
  if (options.database && !["sqlite", "postgresql", "mysql", "mariadb"].includes(options.database)) {
    throw new TypeError("--database supports sqlite, postgresql, mysql and mariadb; SQL Server and Oracle require a configured transport");
  }
  if (options.template && options.database) throw new TypeError("Custom skeleton templates own their persistence setup; use --template without --database");
  const paths = { ...defaultPaths, ...options.config?.paths };
  const files: FilePlan[] = options.template
    ? templateFiles(resolve(baseDirectory, options.template), root, { name: toPackageName(basename(root)) })
    : [
      { path: resolve(root, "package.json"), source: `${JSON.stringify(applicationPackage(toPackageName(basename(root)), options.database), null, 2)}\n` },
      { path: resolve(root, "tsconfig.json"), source: `${JSON.stringify(applicationTsconfig(), null, 2)}\n` },
      { path: resolve(root, ".gitignore"), source: "node_modules\n.env\n.env.*\n*.sqlite\n*.sqlite-shm\n*.sqlite-wal\nstorage/\n" },
      { path: resolve(root, ".npmrc"), source: "@bolt:registry=https://gitlab.com/api/v4/projects/87197832/packages/npm/\n//gitlab.com/api/v4/projects/87197832/packages/npm/:_authToken=${BOLT_GITLAB_TOKEN}\n" },
      { path: resolve(root, "bunfig.toml"), source: '[install]\nauto = "disable"\n' },
      { path: resolve(root, "bolt.config.ts"), source: `import type { BoltProjectConfig } from "@bolt/cli";\n\nexport default ${JSON.stringify({ paths }, null, 2)} satisfies BoltProjectConfig;\n` },
      { path: resolve(root, paths.application), source: applicationSource(options.database) },
      { path: resolve(root, paths.entry), source: `import { application } from ${JSON.stringify(relativeImport(resolve(root, paths.entry), resolve(root, paths.application)))};\n\nawait application.start();\n` },
    ];
  writePlan(root, files, options);
  return root;
}

export function scaffoldController(baseDirectory: string, name: string, options: ScaffoldOptions = {}): string {
  const segments = parseName(name);
  const leaf = segments.at(-1) ?? "";
  const className = `${toPascalCase(leaf)}Controller`;
  const path = generatorPath(baseDirectory, options, "controllers", segments, `${toKebabCase(leaf)}-controller.ts`);
  writePlan(baseDirectory, [{ path, source: sourceTemplate(baseDirectory, options, "controller", { name, className }, `import type { HttpContext } from "@bolt/http";\n\nexport default class ${className} {\n  public handle(context: HttpContext): unknown {\n    return { path: context.url.pathname };\n  }\n}\n`) }], options);
  return path;
}

export function scaffoldEntity(baseDirectory: string, name: string, options: ScaffoldOptions = {}): string {
  const segments = parseName(name);
  const leaf = segments.at(-1) ?? "";
  const entityName = toPascalCase(leaf);
  const path = generatorPath(baseDirectory, options, "entities", segments, `${toKebabCase(leaf)}.ts`);
  const source = `import { defineEntity } from "@bolt/orm";\n\nexport interface ${entityName} {\n  id: string;\n}\n\nexport const ${entityName}Entity = defineEntity<${entityName}>({\n  table: "${toSnakeCase(leaf)}",\n  columns: { id: { primaryKey: true } },\n});\n\n// Assign IDs before insertion: { id: crypto.randomUUID() }.\n`;
  writePlan(baseDirectory, [{ path, source: sourceTemplate(baseDirectory, options, "entity", { name, entityName }, source) }], options);
  return path;
}

export function scaffoldMigration(baseDirectory: string, name: string, now: Date, options: ScaffoldOptions = {}): string {
  const segments = parseName(name);
  const id = `${now.toISOString().replace(/[-:T]/g, "").slice(0, 14)}_${segments.map(toSnakeCase).join("_")}`;
  const path = resolve(baseDirectory, options.path ?? `${options.config?.paths?.migrations ?? defaultPaths.migrations}/${id}.ts`);
  const source = `import { sqlMigration } from "@bolt/database";\n\n// Add SQL statements before importing this migration into your exported SqlMigrator.\n// MySQL/MariaDB/Oracle DDL requires { transactional: false } as the third argument.\nexport default sqlMigration("${id}", [\n  // "CREATE TABLE ...",\n]);\n`;
  writePlan(baseDirectory, [{ path, source: sourceTemplate(baseDirectory, options, "migration", { name, id }, source) }], options);
  return path;
}

function generatorPath(root: string, options: ScaffoldOptions, kind: "controllers" | "entities", segments: string[], filename: string): string {
  return resolve(root, options.path ?? [options.config?.paths?.[kind] ?? defaultPaths[kind], ...segments.slice(0, -1).map(toKebabCase), filename].join("/"));
}
function sourceTemplate(root: string, options: ScaffoldOptions, kind: "controller" | "entity" | "migration", variables: Record<string, string>, fallback: string): string {
  const template = options.template ?? options.config?.templates?.[kind];
  if (!template) return fallback;
  const path = resolve(root, template);
  assertNoSymlinks(path);
  return interpolate(readFileSync(path, "utf8"), variables);
}
function interpolate(source: string, variables: Record<string, string>): string {
  return source.replace(/\{\{([a-zA-Z]+)\}\}/g, (_, key: string) => {
    if (!Object.hasOwn(variables, key)) throw new TypeError(`Unknown template placeholder: ${key}`);
    return variables[key]!;
  });
}
function templateFiles(templateRoot: string, root: string, variables: Record<string, string>): FilePlan[] {
  assertNoSymlinks(templateRoot);
  if (!existsSync(templateRoot) || !lstatSync(templateRoot).isDirectory()) throw new Error(`Skeleton template must be a directory: ${templateRoot}`);
  const files: FilePlan[] = [];
  const visit = (folder: string): void => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = resolve(folder, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Template symbolic links are not supported: ${path}`);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push({ path: resolve(root, relative(templateRoot, path)), source: interpolate(readFileSync(path, "utf8"), variables) });
      else throw new Error(`Unsupported template entry: ${path}`);
    }
  };
  visit(templateRoot);
  if (!files.length) throw new Error("Skeleton template has no files");
  return files;
}

function writePlan(root: string, files: readonly FilePlan[], options: ScaffoldOptions): void {
  const seen = new Set<string>();
  for (const file of files) {
    assertWithin(root, file.path);
    assertNoSymlinks(file.path);
    const identity = process.platform === "win32" ? file.path.toLowerCase() : file.path;
    if (seen.has(identity)) throw new Error(`Generated paths collide: ${file.path}`);
    seen.add(identity);
    if (existsSync(file.path)) throw new Error(`Refusing to overwrite existing file: ${file.path}`);
    // Validate each existing parent before writing any of the plan.
    let parent = dirname(file.path);
    while (!existsSync(parent)) parent = dirname(parent);
    if (!lstatSync(parent).isDirectory()) throw new Error(`Generated parent is not a directory: ${parent}`);
  }
  for (const file of files) options.onPlan?.(file.path);
  if (options.dryRun) return;
  const written: string[] = [];
  try {
    for (const file of files) {
      assertNoSymlinks(file.path);
      mkdirSync(dirname(file.path), { recursive: true });
      assertNoSymlinks(file.path);
      writeFileSync(file.path, file.source, { encoding: "utf8", flag: "wx" });
      written.push(file.path);
    }
  } catch (error) {
    // Roll back only files created by this operation, preserving existing developer work.
    const cleanup: unknown[] = [];
    for (const path of written.reverse()) {
      try { assertNoSymlinks(path); unlinkSync(path); } catch (failure) { cleanup.push(failure); }
    }
    if (cleanup.length) throw new AggregateError([error, ...cleanup], "Scaffold failed; some generated files require manual cleanup");
    throw new Error("Scaffold failed; generated files were removed (empty directories may remain)", { cause: error });
  }
}
function assertWithin(root: string, path: string): void {
  const relativePath = relative(resolve(root), resolve(path));
  if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) throw new Error(`Generated path escapes its target directory: ${path}`);
}
function assertNoSymlinks(path: string): void {
  let current = resolve(path);
  for (;;) {
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) throw new Error(`Refusing symbolic link in generated path: ${current}`);
      if (existsSync(current) && relative(current, realpathSync(current)) !== "") throw new Error(`Refusing redirected generated path: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}
function parseName(name: string): string[] {
  const segments = name.split(/[\\/]/).filter(Boolean);
  if (!segments.length || segments.some(segment => !/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(segment))) throw new TypeError("Names must contain safe path segments starting with a letter");
  return segments;
}
function toPascalCase(value: string): string {
  return value.split(/[-_]/).filter(Boolean)
    .map(part => `${part[0]?.toUpperCase()}${part.slice(1)}`).join("");
}
function toKebabCase(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1-$2").replace(/_/g, "-").toLowerCase();
}
function toSnakeCase(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/-/g, "_").toLowerCase();
}
function toPackageName(value: string): string {
  return toKebabCase(value).replace(/[^a-z0-9-]/g, "-") || "bolt-app";
}
function relativeImport(from: string, to: string): string {
  const path = relative(dirname(from), to).replaceAll("\\", "/");
  return path.startsWith(".") ? path : `./${path}`;
}
function applicationPackage(name: string, database?: string): object {
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
      "@bolt/cli": boltVersion,
      "@bolt/http": boltVersion,
      "@bolt/kernel": boltVersion,
      "@bolt/router": boltVersion,
      ...(database ? { "@bolt/database": boltVersion, "@bolt/orm": boltVersion } : {}),
    },
    devDependencies: { "@types/bun": "1.4.2", typescript: "7.0.2" },
  };
}

function installedCliVersion(): string {
  const manifest: unknown = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const version = typeof manifest === "object" && manifest !== null
    ? (manifest as Record<string, unknown>)["version"]
    : undefined;
  const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
  if (typeof version !== "string" || !semver.test(version)) {
    throw new TypeError("Installed @bolt/cli package must declare a valid SemVer version");
  }
  return version;
}
function applicationTsconfig(): object {
  return {
    compilerOptions: {
      allowImportingTsExtensions: true,
      lib: ["ESNext", "DOM"],
      module: "Preserve",
      moduleResolution: "bundler",
      noEmit: true,
      skipLibCheck: true,
      strict: true,
      target: "ESNext",
      types: ["bun"],
    },
    include: ["**/*.ts"],
    exclude: ["node_modules"],
  };
}
function applicationSource(database?: string): string {
  const persistence = database ? `import { SqlDatabase, SqlMigrator } from "@bolt/database";\n` : "";
  const configuration = database === "sqlite" ? '{ dialect: "sqlite", filename: "app.sqlite" }' : `{ dialect: "${database}", url: requiredDatabaseUrl() }`;
  return `${persistence}import { BoltApplication } from "@bolt/kernel";\nimport { Router } from "@bolt/router";\n\nexport const router = Router.create();\n${database ? `export const database = SqlDatabase.create(${configuration});\n// Import generated migrations here explicitly, in an array.\nexport const migrator = new SqlMigrator(database, []);\n` : ""}\nexport const application = BoltApplication.create({ router, port: Number(process.env["PORT"] ?? 3000) })${database ? ".use(database)" : ""};\n${database && database !== "sqlite" ? '\nfunction requiredDatabaseUrl(): string {\n  const url = process.env["DATABASE_URL"];\n  if (!url) throw new Error("DATABASE_URL is required");\n  return url;\n}\n' : ""}`;
}
