import { resolve } from "node:path";

import {
  databaseMigrationStatus,
  listRoutes,
  migrateDatabase,
} from "./application-module.ts";
import { runProcess as defaultRunProcess } from "./process.ts";
import {
  scaffoldApplication,
  scaffoldController,
  scaffoldMigration,
} from "./scaffold.ts";
import type { CliOptions } from "./types.ts";

const HELP = `Bolt command line

Usage: bolt <command> [options] [-- arguments]

Commands:
  dev                         Run src/main.ts with Bun watch mode
  start                       Run src/main.ts
  test                        Run tests with Bun's test runner
  routes                      List routes exported by src/application.ts
  migrate                     Apply pending application migrations
  migrate:status              Print application migration status
  make:controller <name>      Create a controller without overwriting files
  make:migration <name>       Create a timestamped migration
  new <directory>             Create a minimal Bolt application
  help                        Show this help

Options:
  --cwd <directory>           Application working directory
  --entry <file>              Main entry point for dev and start
  --app <file>                Application module for routes and migrations
  --no-install                Do not install dependencies after bolt new
  -h, --help                  Show command help

Arguments after -- are forwarded unchanged to Bun.`;

interface ParsedArguments {
  readonly application: string;
  readonly command?: string;
  readonly cwd: string;
  readonly entry: string;
  readonly forwarded: readonly string[];
  readonly help: boolean;
  readonly install: boolean;
  readonly positionals: readonly string[];
}

export async function runCli(options: CliOptions = {}): Promise<number> {
  const io = options.io ?? console;
  const initialDirectory = options.cwd ?? process.cwd();

  try {
    const parsed = parseArguments(options.argv ?? Bun.argv.slice(2), initialDirectory);

    if (!parsed.command || parsed.command === "help" || parsed.help) {
      io.log(HELP);
      return 0;
    }

    const runProcess = options.runProcess ?? defaultRunProcess;
    const importer = options.importModule ?? ((specifier) => import(specifier));

    switch (parsed.command) {
      case "dev":
        return await runProcess(
          ["bun", "--watch", "run", parsed.entry, ...parsed.forwarded],
          { cwd: parsed.cwd },
        );
      case "start":
        return await runProcess(
          ["bun", "run", parsed.entry, ...parsed.forwarded],
          { cwd: parsed.cwd },
        );
      case "test":
        return await runProcess(
          ["bun", "test", ...parsed.positionals, ...parsed.forwarded],
          { cwd: parsed.cwd },
        );
      case "routes": {
        const routes = await listRoutes(parsed.application, importer);
        io.log(routes.length === 0 ? "No routes registered." : routes.join("\n"));
        return 0;
      }
      case "migrate": {
        const migrations = await migrateDatabase(parsed.application, importer);
        io.log(
          migrations.length === 0
            ? "No pending migrations."
            : migrations.map((id) => `APPLIED ${id}`).join("\n"),
        );
        return 0;
      }
      case "migrate:status": {
        const status = await databaseMigrationStatus(parsed.application, importer);
        io.log(status.length === 0 ? "No migrations registered." : status.join("\n"));
        return 0;
      }
      case "make:controller": {
        const name = requirePositional(parsed, "controller name");
        const path = scaffoldController(parsed.cwd, name);
        io.log(`Created ${path}`);
        return 0;
      }
      case "make:migration": {
        const name = requirePositional(parsed, "migration name");
        const path = scaffoldMigration(
          parsed.cwd,
          name,
          (options.now ?? (() => new Date()))(),
        );
        io.log(`Created ${path}`);
        return 0;
      }
      case "new": {
        const target = requirePositional(parsed, "target directory");
        const root = scaffoldApplication(parsed.cwd, target);

        if (parsed.install) {
          const exitCode = await runProcess(["bun", "install"], { cwd: root });

          if (exitCode !== 0) {
            return exitCode;
          }
        }

        io.log(`Created Bolt application at ${root}`);
        return 0;
      }
      default:
        io.error(`Unknown command: ${parsed.command}\n\n${HELP}`);
        return 2;
    }
  } catch (error) {
    io.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

function parseArguments(
  arguments_: readonly string[],
  initialDirectory: string,
): ParsedArguments {
  let application = "src/application.ts";
  let cwd = initialDirectory;
  let entry = "src/main.ts";
  let help = false;
  let install = true;
  let forwarding = false;
  const positionals: string[] = [];
  const forwarded: string[] = [];

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];

    if (argument === undefined) {
      continue;
    }

    if (forwarding) {
      forwarded.push(argument);
      continue;
    }

    if (argument === "--") {
      forwarding = true;
      continue;
    }

    if (argument === "-h" || argument === "--help") {
      help = true;
      continue;
    }

    if (argument === "--no-install") {
      install = false;
      continue;
    }

    if (argument === "--cwd" || argument === "--entry" || argument === "--app") {
      const value = arguments_[index + 1];

      if (!value || value === "--") {
        throw new TypeError(`${argument} requires a value`);
      }

      index += 1;

      if (argument === "--cwd") {
        cwd = resolve(initialDirectory, value);
      } else if (argument === "--entry") {
        entry = value;
      } else {
        application = value;
      }

      continue;
    }

    positionals.push(argument);
  }

  const [command, ...commandPositionals] = positionals;

  return {
    application: resolve(cwd, application),
    ...(command ? { command } : {}),
    cwd,
    entry,
    forwarded,
    help,
    install,
    positionals: commandPositionals,
  };
}

function requirePositional(parsed: ParsedArguments, label: string): string {
  const value = parsed.positionals[0];

  if (!value) {
    throw new TypeError(`${parsed.command ?? "Command"} requires a ${label}`);
  }

  if (parsed.positionals.length > 1) {
    throw new TypeError(`${parsed.command ?? "Command"} accepts only one ${label}`);
  }

  return value;
}
