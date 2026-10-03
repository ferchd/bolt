# Bolt

Framework modular para Bun y TypeScript con persistencia SQL, ORM propio de
sintaxis LINQ, autenticación, almacenamiento local/S3 y scaffolding configurable. Los paquetes
de runtime usan solamente APIs de Bun, del sistema y otros paquetes Bolt;
TypeScript y sus definiciones siguen siendo herramientas de desarrollo.

Bolt adopta configuración progresiva: funciona con defaults útiles y permite
reemplazarlos cuando la aplicación realmente lo necesita.

| Capacidad | Implementación | Validación en este checkout |
| --- | --- | --- |
| SQLite | Bun nativo | CRUD, ORM, transacciones, migraciones y HTTP reales |
| PostgreSQL 16.9 | Bun SQL nativo | Integración contra servidor real |
| MySQL 8.4.5 / MariaDB 11.4.5 | Bun SQL nativo | Integración contra servidores reales |
| SQL Server 2022 CU20 | ODBC propio | Integración real: parámetros, migraciones, transacciones y ORM |
| Oracle Free 26ai 23.26.3 | ODBC propio e Instant Client 23.26.3 | Integración real: Unicode, valores exactos, migraciones, transacciones y ORM |
| Disco local | Adaptador propio | I/O, streaming, cancelación y publicación atómica reales |
| S3 compatible | Transporte propio SigV4; Bun S3 para operaciones auxiliares | Floci 1.5.8 real: multipart, firmas, cancelación y limpieza |
| Autenticación y permisos | Sesiones SQL, Argon2id y políticas explícitas | HTTP, CSRF, rotación, revocación y ledger en los seis motores SQL |

Los requisitos y límites del transporte ODBC se explican en
[su guía](packages/database-odbc/README.md). Que un dialecto compile no implica
que todos los esquemas y versiones del servidor estén certificados.
La [matriz de validación](docs/validation.md) distingue las pruebas reales de
las garantías que debe comprobar cada despliegue.

## Requisitos

- Bun 1.4.0

## Estructura

```text
packages/
├── auth/         Autenticación por contraseña, sesiones SQL y políticas
├── cli/          Flujo de desarrollo, inspección y scaffolding
├── config/       Acceso tipado a las variables de entorno
├── container/    Inyección de dependencias y ciclo de vida de recursos
├── database/     SQLite, PostgreSQL, MySQL, MariaDB y migraciones SQL
├── database-odbc/ Transporte propio ODBC para SQL Server y Oracle
├── http/         Contexto, respuestas y errores HTTP
├── kernel/       Aplicación, ciclo de vida e integración HTTP con Bun
├── logger/       Logs legibles o estructurados con contexto
├── orm/          Consultas LINQ tipadas, entidades y unidad de trabajo
├── router/       Definición y compilación de rutas
├── security/     Cabeceras, CORS, límites, cookies, CSRF y passwords
├── storage/      Discos locales y S3 compatibles
├── testing/      Cliente HTTP para pruebas de aplicaciones Bolt
└── validation/   Esquemas pequeños para validar entradas

examples/
├── api/          API CRUD vertical con SQLite y pruebas HTTP
├── empty/        Aplicación Bolt mínima, sin rutas
├── persistence/  SQL, ORM, archivos versionados y pruebas HTTP
└── routing/      Registro y resolución de una ruta
```

Los paquetes nuevos se crearán dentro de `packages/` solamente cuando exista
una responsabilidad concreta que justifique separarlos. El ciclo de vida vive
en `@bolt/kernel` y las rutas en `@bolt/router`.

## Desarrollo

Instala las dependencias exactas registradas en `bun.lock`:

```bash
bun install --frozen-lockfile
```

Arranca la aplicación HTTP de ejemplo:

```bash
bun run dev
```

Esto inicia la API de tareas en `http://localhost:3000`. Al ejecutarla desde el
workspace raíz, la base de datos se crea automáticamente en
`examples/api/storage/tasks.sqlite`; `DATABASE_PATH`,
`DATABASE_MIGRATE_ON_START`, `APP_NAME`, `APP_KEY`, `DEMO_PASSWORD`,
`COOKIE_SECURE`, `TRUST_PROXY`, `PORT` y `LOG_LEVEL` permiten cambiar los
defaults sin un archivo de configuración del framework. Las credenciales y la
clave incluidas por el ejemplo son exclusivamente para desarrollo.

Comprueba los tipos y ejecuta las pruebas de todos los workspaces:

```bash
bun run check
```

Comprueba además que los paquetes puedan consumirse fuera del monorepo:

```bash
bun run verify:packages
```

Este comando empaqueta todos los paquetes, los instala en un consumidor externo,
comprueba sus tipos y ejecuta HTTP, migraciones, ORM y almacenamiento local.
No publica paquetes.

Después de publicar, `bun run verify:registry` instala los 15 paquetes por nombre
y versión desde GitLab, comprueba sus tipos y ejecuta el consumidor externo sin
overrides. Requiere `BOLT_GITLAB_TOKEN` obtenido fuera del repositorio.

`bun run verify:recovery` crea contenedores de prueba aislados para PostgreSQL,
MySQL y MariaDB, interrumpe una transacción al detener cada servidor y comprueba
rollback durable, recuperación del pool y nuevas escrituras. Requiere Docker;
remueve únicamente los contenedores creados por la ejecución.

Las dependencias internas entre paquetes usarán el protocolo `workspace:*`, de
modo que Bun las enlace localmente durante el desarrollo y las convierta a una
versión concreta al publicar.

## Ejemplo vertical

La aplicación completa se ensambla con primitivas explícitas y pequeñas:

```ts
import { Database } from "@bolt/database";
import { BoltApplication } from "@bolt/kernel";
import { Router } from "@bolt/router";

const router = Router.create();
const database = Database.create({
  migrations: [
    {
      id: "001_create_tasks",
      up(db) {
        db.run("CREATE TABLE tasks (id INTEGER PRIMARY KEY, title TEXT NOT NULL)");
      },
    },
  ],
});

router.get("/tasks", () => database.query("SELECT * FROM tasks").all());

const application = BoltApplication.create({ router }).use(database);
await application.start();
```

El ejemplo real en `examples/api` añade CRUD, grupos y nombres de ruta,
validación de body/query/params, proveedores, seguridad, migraciones y pruebas
HTTP. Se ejecuta con `bun run example:api`.

## CLI

`@bolt/cli` concentra las tareas habituales sin ocultar que Bun es el runtime:

```bash
bolt dev
bolt start
bolt test
bolt routes
bolt migrate
bolt migrate:status
bolt make:controller admin/user
bolt make:entity User
bolt make:migration create_users
bolt new my-app
```

El skeleton predeterminado no incluye persistencia ni rutas de demostración.
`bolt.config.ts` define las rutas de entry, aplicación, entidades, controladores,
migraciones y pruebas; también admite plantillas propias. Los generadores
ofrecen `--path`, `--template` y `--dry-run`, y rechazan sobrescrituras y escapes.
`new --database postgresql` añade persistencia opcional. Los comandos esperan
las migraciones asíncronas antes de liberar conexiones. Consulta la
[guía del CLI](packages/cli/README.md) para configuración y conexiones nombradas.

## Configuración

Bun carga los archivos `.env` automáticamente. Bolt aprovecha ese comportamiento
y añade conversiones tipadas sin introducir otro parser:

```ts
import env from "@bolt/config";

const name = env.string("APP_NAME", "Bolt");
const port = env.integer("PORT", 3000);
const debug = env.boolean("APP_DEBUG", false);
const level = env.oneOf("LOG_LEVEL", ["debug", "info", "warn"] as const);
```

Omitir el valor por defecto hace que la variable sea obligatoria. Los errores
identifican la variable y la regla incumplida, pero nunca incluyen su contenido.

## Primera aplicación

```ts
import { BoltApplication } from "@bolt/kernel";

const application = BoltApplication.create();

await application.start();

console.log(`Bolt is running at ${application.url}`);
```

`BoltApplication.create()` construye la instancia sin efectos secundarios.
`start()` abre el servidor Bun —aunque todavía no existan rutas— y `stop()` lo
cierra de forma segura. Por defecto Bun escucha en el puerto `3000`; puedes
configurarlo con `BoltApplication.create({ port: 8080 })`.

## Rutas

```ts
import router from "@bolt/router";

router.get("/", () => ({ hello: "world" }));

router
  .group(() => {
    router.post("signup", () => ({ created: true })).as("signup");
    router.post("login", () => ({ authenticated: true })).as("login");
  })
  .prefix("/api/v1/auth")
  .as("auth");

const routes = router.compile();
```

El router compila la sintaxis declarativa en una tabla por path y método. No
realiza matching durante una petición ni depende del servidor; el kernel
transforma esa tabla en las rutas nativas de Bun al iniciar la aplicación.

Puedes ejecutar el ejemplo con `bun run example:routing`.

Los directorios estáticos se delegan al router nativo de Bun:

```ts
import { resolve } from "node:path";

router.static("/assets", resolve(import.meta.dir, "../public"));
```

Bolt normaliza la ruta como `/assets/*`; Bun se encarga de MIME types, rangos,
cache condicional, streaming y protección frente a escapes del directorio.
Como estas rutas se delegan directamente a Bun, no pueden heredar middleware;
Bolt rechaza esa combinación para evitar que un directorio parezca protegido
cuando no lo está. Los callbacks de `router.group()` también deben ser
síncronos.

## Contexto y errores HTTP

Los handlers reciben un contexto inferido por TypeScript con acceso a la
petición nativa, parámetros, query string, cookies y parsers de body:

```ts
import { abort } from "@bolt/kernel";
import router from "@bolt/router";

router.post("/accounts", async (context) => {
  const input = await context.json<{ email?: string }>();

  if (!input.email) {
    abort(422, "Email is required", { code: "INVALID_INPUT" });
  }

  context.cookies.set("registered", "true");
  return { email: input.email };
});
```

Los errores esperados conservan su status y código. Los errores inesperados se
convierten en una respuesta JSON `500`; fuera de desarrollo nunca incluyen el
mensaje interno ni el stack trace.

Cada contexto incluye además `requestId`, `clientIp`, un logger hijo,
`resolve(token)` para servicios y `timeout(seconds)`. El kernel propaga
`x-request-id`, registra duración/status y permite hooks `onRequest`,
`onResponse` y `onError`. Las cabeceras de proxy solo se confían cuando
`requests.trustProxy` se habilita explícitamente.

## Validación

Los esquemas son composables, infieren su tipo y se conectan directamente al
contexto HTTP:

```ts
import v from "@bolt/validation";

const accountSchema = v.object({
  age: v.number().integer().min(18),
  email: v.string().email(),
  nickname: v.string().min(2).optional(),
});

router.post("/accounts", async (context) => {
  const input = await context.validate.body(accountSchema);
  return { account: input };
});
```

También están disponibles `context.validate.query()` y
`context.validate.params()`. Los errores se agregan con paths deterministas y
se responden como `422 VALIDATION_ERROR`; JSON malformado produce `400`.

El paquete incluye literales, enums, uniones, valores anulables, fechas, UUID,
archivos, defaults, refinamientos, transformaciones y objetos parciales.

## Contenedor y proveedores

Los tokens mantienen la resolución tipada sin decoradores ni reflexión:

```ts
import { createToken, provideClass, provideValue } from "@bolt/container";

const databaseToken = createToken<Database>("database");
const usersToken = createToken<UsersController>("users controller");

const application = BoltApplication.create({
  router,
  bindings: [
    provideValue(databaseToken, database),
    provideClass(usersToken, [databaseToken], UsersController),
  ],
});

router.get("/users", [usersToken, "index"]);
```

El contenedor admite valores, factories y clases, lifetimes `singleton`,
`scoped` y `transient`, detecta ciclos y libera recursos en orden inverso.
Cada petición posee un scope aislado, conservado hasta terminar o cancelar
el streaming de su respuesta. Un singleton no puede capturar servicios scoped.
Los proveedores separan `register`, `boot` y `shutdown`; las rutas registradas
en `boot` se incorporan antes de abrir el servidor.

## Logs

Cada aplicación incluye un logger listo para usar:

```ts
application.logger.info("Account created", {
  accountId: "account-1",
});

const requestLogger = application.logger.child({ requestId: "request-1" });
requestLogger.warn("Slow request", { durationMs: 750 });
```

En desarrollo la salida es legible y en producción usa JSON por línea. Los
campos sensibles comunes se redactan automáticamente. El nivel se puede cambiar
con `LOG_LEVEL=debug`; durante las pruebas el logger predeterminado permanece
silencioso.

## Base de datos

`SqlDatabase` ofrece una API asíncrona común y transportes nativos para SQLite,
PostgreSQL, MySQL y MariaDB. SQL Server y Oracle usan el transporte explícito
de `@bolt/database-odbc`, con un driver ODBC instalado y un worker PowerShell
propio; no requieren un paquete JS de terceros. Los pools son acotados, las
transacciones reservan una conexión física y el cierre espera las operaciones.

```ts
import { SqlDatabase, SqlMigrator, sqlMigration } from "@bolt/database";

const database = SqlDatabase.create({
  dialect: "postgresql",
  url: process.env["DATABASE_URL"],
  maxConnections: 10,
});
await database.start();
const migrator = new SqlMigrator(database, [sqlMigration("001_users", [
  "CREATE TABLE users (id VARCHAR(36) PRIMARY KEY, name VARCHAR(120) NOT NULL)",
])]);
await migrator.migrate();
await database.transaction(async tx => {
  await tx.execute("INSERT INTO users (id, name) VALUES ($1, $2)", [crypto.randomUUID(), "Ana"]);
});
await database.close();
```

Los placeholders de `execute` corresponden al motor; el ORM los compila
automáticamente. Dentro de una transacción se usa exclusivamente su executor.
`SqlConnections` administra conexiones nombradas. `SqlMigrator` comprueba
checksums SHA-256, registra fallos y detecta migraciones aplicadas ausentes;
usa locks propios del motor. El DDL de MySQL/MariaDB/Oracle exige declarar
`transactional: false`; Oracle usa un lock de sesión `SYS.DBMS_LOCK` y requiere
su permiso de ejecución, o un lock alternativo configurado por el despliegue.
El SQL de cada migración debe revisarse para su dialecto.

La API anterior `Database` sigue envolviendo `bun:sqlite` sin ocultar sus statements ni
transacciones. Activa claves foráneas, timeout de espera y WAL para archivos;
en `NODE_ENV=test` usa memoria por defecto.

```ts
import { Database } from "@bolt/database";

const database = Database.create();
database.register({
  id: "001_create_accounts",
  up(db) {
    db.run("CREATE TABLE accounts (id INTEGER PRIMARY KEY, email TEXT NOT NULL)");
  },
});

application.use(database);
```

Las migraciones son síncronas, forward-only, se ordenan por ID y se aplican en
una transacción `IMMEDIATE`. El servicio abre antes del servidor y se cierra en
el orden inverso junto con la aplicación. Esto serializa el descubrimiento y
la ejecución cuando arrancan varios procesos contra el mismo archivo. Usa
`migrateOnStart: false` o `database.start({ migrate: false })` para inspeccionar
el estado antes de aplicar cambios.

## ORM y almacenamiento

El [ORM propio](packages/orm/README.md) compila expresiones tipadas a SQL
parametrizado. Incluye proyecciones, joins, agrupaciones, agregados, codecs,
claves compuestas, relaciones por lotes, concurrencia optimista y una unidad
de trabajo explícita por petición.

```ts
const page = await repository.query()
  .where(user => user.name.startsWith("Ana"))
  .orderBy(user => user.name)
  .thenBy(user => user.id)
  .select(user => ({ id: user.id, name: user.name }))
  .take(20)
  .toList();
```

[Storage](packages/storage/README.md) permite registrar discos intercambiables
locales y S3 compatibles: lectura por stream, límites de tamaño, escritura
local atómica, listados paginados, copia, multipart y URLs firmadas. Declara
capacidades para rechazar operaciones que el proveedor no puede garantizar;
las subidas usan un transporte propio con `AbortSignal` y limpieza multipart.
Floci se prueba sin autenticación; una suite independiente verifica las firmas
SigV4 de las peticiones reales y sus payloads.
Otros proveedores se añaden implementando `StorageDisk`.

El [ejemplo de persistencia](examples/persistence/README.md) integra migración,
repositorios scoped, metadatos SQL y archivos versionados con compensación.
Se ejecuta con `bun run example:persistence`.

## Seguridad

`@bolt/security` ofrece middleware y primitivas independientes del servidor:

```ts
import { cors, rateLimit, secureHeaders } from "@bolt/security";

router
  .group(() => {
    router.get("/profile", profile);
  })
  .prefix("/api")
  .use([
    secureHeaders(),
    cors({ origin: "https://app.example" }),
    rateLimit({ limit: 100, windowMs: 60_000 }),
  ]);
```

También incluye cookies HMAC con rotación de secretos, CSRF double-submit y
hashing/verificación Argon2id mediante `Bun.password`. Los límites en memoria
son adecuados para una sola instancia; una aplicación distribuida deberá
reemplazar esa política por almacenamiento compartido.

## Pruebas

`@bolt/testing` ejecuta las peticiones contra un servidor HTTP real en un
puerto efímero. Inicia la aplicación bajo demanda y solo la detiene cuando el
cliente adquirió su ciclo de vida.

```ts
import { expect, test } from "bun:test";
import { TestClient } from "@bolt/testing";

test("creates a task", async () => {
  await using client = TestClient.create({ router });
  const response = await client.post("/tasks", {
    json: { title: "Ship Bolt" },
  });

  expect(response.status).toBe(201);
});
```

## Servidor

```ts
import { BoltApplication } from "@bolt/kernel";
import router from "@bolt/router";

const application = BoltApplication.create({
  hostname: "127.0.0.1",
  port: 3000,
  router,
  server: {
    idleTimeout: 10,
    maxRequestBodySize: 1_048_576,
  },
});

await application.start();

console.log(`Bolt is running at ${application.url}`);
```

No existe una segunda instancia `BoltServer`: la aplicación posee el servidor y
expone su `url` y `port` después de arrancar. Los servicios adicionales
registrados con `use()` conservan su ciclo de vida ordenado alrededor del
servidor. Bolt también escucha `SIGINT` y `SIGTERM` para ejecutar un cierre
ordenado; esto permite que `bun --watch` libere recursos antes de reiniciar.
El kernel limita los cuerpos a 1 MiB por defecto, valida las opciones del
servidor y permite configurar TLS, `reusePort`, IPv6 e idle timeout mediante
`server`.

## Estado y distribución

La versión inicial es `0.1.0`. El origen canónico y el
registry de paquetes son [GitLab](https://gitlab.com/ferchd/bolt). El registry
usa el protocolo npm en GitLab; no se publican paquetes en npmjs.org.
[GitHub](https://github.com/ferchd/bolt) queda destinado a contribuciones y
mirror. El espejo push de GitLab está habilitado mediante una clave SSH de
despliegue para ramas protegidas y tags; ambos historiales iniciales se conservaron
y se comprobó que `main` coincide. Véase [CONTRIBUTING.md](CONTRIBUTING.md).

El pipeline GitLab verifica tipos, pruebas, tarballs y motores SQL. El job de
publicación es manual, requiere un tag protegido coincidente y valida que las
dependencias de runtime sean exclusivamente propias. `bun run release:check`
valida los metadatos localmente; no requiere credenciales. Los proyectos
generados referencian un token de GitLab mediante una variable de entorno.

MongoDB y DynamoDB quedan fuera de esta etapa. Las migraciones son forward-only;
Oracle captura claves generadas mediante parámetros de salida. No hay traducción
de lambdas JavaScript arbitrarias ni relaciones con carga perezosa. El rate limiting
en memoria no es distribuido; el aprovisionamiento de usuarios, recuperación de
contraseñas y políticas de dominio pertenecen a la aplicación. La base SQL y el disco
no comparten una transacción distribuida. Las pruebas no sustituyen la
validación operativa del despliegue y del proveedor concreto.

La configuración se basa en la documentación oficial de
[Bun](https://bun.com/docs), incluyendo las recomendaciones para
[TypeScript](https://bun.com/docs/typescript),
[`bunfig.toml`](https://bun.com/docs/runtime/bunfig) y
[workspaces](https://bun.com/docs/pm/workspaces), además de las APIs nativas de
[SQLite](https://bun.com/docs/runtime/sqlite) y
[`bun:test`](https://bun.com/docs/test),
[`Bun.serve`](https://bun.com/docs/runtime/http/server),
[`Bun.spawn`](https://bun.com/docs/runtime/child-process) y
[`Bun.password`](https://bun.com/guides/util/hash-a-password).
