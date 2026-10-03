# @bolt/cli

Bolt's own Bun CLI creates a small application, then follows the developer's structure.
The default skeleton contains a router and application, without a database or demo route.
Packages use the exact version of the installed CLI from the private GitLab registry; generated `.npmrc`
references `BOLT_GITLAB_TOKEN` without embedding a credential. Bun's automatic runtime
installation is disabled. Set the token before `bun install` when the release is available.

```sh
bolt new my-app --no-install
bolt new sql-app --database postgresql --no-install
bolt new preview --dry-run
```

`--database` supports SQLite, PostgreSQL, MySQL and MariaDB. SQLite uses `app.sqlite`;
the other providers require `DATABASE_URL`. SQL Server and Oracle require an explicit
transport and therefore are not configured by this convenience option. The SQL skeleton
exports `database` and an empty `migrator` catalog; it does not run migrations at startup.
`PORT` controls the listener (default `3000`; `0` chooses an available port).

Projects without persistence can add Bolt's own packages explicitly:

```sh
bun add --exact @bolt/database@0.1.2 @bolt/orm@0.1.2
bolt make:entity Accounts/User
bolt make:migration createUsers
```

Generators do not edit dependencies or register their outputs automatically.

## Developer-defined structure

A developer-owned `bolt.config.ts` exports a configuration object. It is executable
project code, loaded by the CLI like the application module. It is optional; `--config`
selects a different existing configuration file. This configuration used when invoking
`new` also determines the generated skeleton's structure and saved configuration.

```ts
import type { BoltProjectConfig } from "@bolt/cli";

export default {
  paths: {
    entry: "bootstrap.ts",
    application: "app/runtime.ts",
    controllers: "app/accounts/http",
    entities: "app/accounts/domain",
    migrations: "schema/migrations",
    tests: "spec",
  },
  templates: {
    controller: "templates/controller.ts.tpl",
    entity: "templates/entity.ts.tpl",
    migration: "templates/migration.ts.tpl",
  },
} satisfies BoltProjectConfig;
```

`dev`, `start`, `routes`, migrations and `test` respect these paths. `--entry` and
`--app` override runtime/module paths. An explicit test positional replaces the
configured test directory. Default paths are `src/main.ts`, `src/application.ts`,
`src/controllers`, `src/entities`, `database/migrations`, and `tests`.

```sh
bolt make:controller Accounts/User --path features/users/http/controller.ts
bolt make:entity User --path features/users/domain/user.ts --dry-run
bolt make:migration createUsers --template templates/custom-migration.ts.tpl
bolt new custom-app --template templates/skeleton --no-install
```

`--path` is a complete output filename, relative to the project root. Generator
`--template` selects one UTF-8 source file; `new --template` copies an entire UTF-8
skeleton directory, preserving its structure. A custom skeleton owns all its files
and persistence setup, so `--template` and `--database` cannot be combined for `new`.
Skeleton templates expose `{{name}}` (package name). Controller templates expose
`{{name}}` and `{{className}}`; entity templates expose `{{name}}` and `{{entityName}}`;
migration templates expose `{{name}}` and `{{id}}`. Unknown placeholders fail before writing.

`--dry-run` previews a validated file plan without writing or installing dependencies.
Output paths must stay inside the project root, including a `new` target. Existing files,
output path collisions, symbolic links/junctions in output paths, and template symlinks
are refused. A write failure rolls back only files created by that operation; empty
created directories may remain. Cleanup failures are reported explicitly. These checks
assume a trusted project filesystem and do not provide a sandbox against concurrent
hostile filesystem modifications.

## Explicit migrations

`make:migration` generates a `sqlMigration` with an empty SQL statement list and a
stable timestamped ID. Edit its SQL before registering it. The checksum derives from
SQL content; never change an applied migration. No directory scanning happens implicitly.

```ts
// schema/migrations/20261003120000_create_users.ts
import { sqlMigration } from "@bolt/database";

export default sqlMigration("20261003120000_create_users", [
  "CREATE TABLE users (id VARCHAR(36) PRIMARY KEY NOT NULL)",
]);

// app/runtime.ts (SQLite example)
import { SqlDatabase, SqlMigrator } from "@bolt/database";
import createUsers from "../schema/migrations/20261003120000_create_users.ts";

export const database = SqlDatabase.create({ dialect: "sqlite", filename: "app.sqlite" });
export const migrator = new SqlMigrator(database, [createUsers]);
```

MySQL, MariaDB and Oracle DDL requires the explicit third argument
`{ transactional: false }`; Oracle migrations require permission to execute
`SYS.DBMS_LOCK`, or a configured alternative cross-process lock.
Register and test SQL appropriate for the selected dialect.

```sh
bolt migrate
bolt migrate:status
```

The CLI accepts direct exports or a default object with capabilities. Modern SQL
applications export a `database` connection and separate `migrator`. Legacy Bolt SQLite
applications exporting a database with `migrate()` and `migrationStatus()` continue to
work. Async migration execution and status are awaited before closing connections;
connections already owned by the running application remain open.

Named connections use `connections.get(name)` and `migrators[name]`:

```ts
import { SqlConnections, SqlMigrator } from "@bolt/database";

export const connections = new SqlConnections()
  .add("main", { dialect: "postgresql", url: process.env["DATABASE_URL"]! });
export const migrators = { main: new SqlMigrator(connections.get("main"), []) };
```

```sh
bolt migrate --connection main
bolt migrate:status --connection main
```

Only the selected connection is started or stopped. Entity skeletons use `defineEntity`
from `@bolt/orm`, explicit columns and an assigned string primary key; initialize new
records with `crypto.randomUUID()` before inserting them. Adapt the interface, table,
columns and migration to your domain.
