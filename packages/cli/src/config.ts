import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export interface BoltProjectConfig {
  readonly paths?: Partial<ProjectPaths>;
  /** UTF-8 files with {{className}}, {{entityName}}, {{id}}, {{name}} placeholders. */
  readonly templates?: Partial<Record<"controller" | "entity" | "migration", string>>;
}

export interface ProjectPaths {
  readonly entry: string;
  readonly application: string;
  readonly controllers: string;
  readonly entities: string;
  readonly migrations: string;
  readonly tests: string;
}

export const defaultPaths: ProjectPaths = Object.freeze({
  entry: "src/main.ts",
  application: "src/application.ts",
  controllers: "src/controllers",
  entities: "src/entities",
  migrations: "database/migrations",
  tests: "tests",
});

export async function loadProjectConfig(
  cwd: string,
  configPath?: string,
): Promise<BoltProjectConfig> {
  const path = resolve(cwd, configPath ?? "bolt.config.ts");
  if (!existsSync(path)) {
    if (configPath) throw new Error(`Project configuration not found: ${path}`);
    return {};
  }
  // Project configuration is executable, developer-owned code, like application.ts.
  const module = await import(pathToFileURL(path).href);
  const config: unknown = module.default;
  if (!config || typeof config !== "object") throw new TypeError("bolt.config.ts must export a default configuration object");
  const candidate = config as BoltProjectConfig;
  for (const section of [candidate.paths, candidate.templates]) {
    if (section !== undefined && (typeof section !== "object" || section === null || Array.isArray(section))) throw new TypeError("Configuration paths and templates must be objects");
    for (const value of Object.values(section ?? {})) {
      if (typeof value !== "string" || !value.trim()) throw new TypeError("Configuration paths and templates must be non-empty strings");
    }
  }
  return candidate;
}
