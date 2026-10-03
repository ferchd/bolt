# Bolt

Framework con baterías incluidas para Bun y TypeScript. El MVP ofrece una ruta
directa desde `BoltApplication.create()` hasta una API HTTP persistente y
probada, sin dependencias externas de runtime.

Bolt adopta configuración progresiva: funciona con defaults útiles y permite
reemplazarlos cuando la aplicación realmente lo necesita.

## Requisitos

- Bun 1.4.0

## Estructura

```text
packages/
├── config/       Acceso tipado a las variables de entorno
├── database/     SQLite, transacciones y migraciones
├── http/         Contexto, respuestas y errores HTTP
├── kernel/       Aplicación, ciclo de vida e integración HTTP con Bun
├── logger/       Logs legibles o estructurados con contexto
├── router/       Definición y compilación de rutas
├── testing/      Cliente HTTP para pruebas de aplicaciones Bolt
└── validation/   Esquemas pequeños para validar entradas

examples/
├── api/          API CRUD vertical con SQLite y pruebas HTTP
├── empty/        Aplicación Bolt mínima, sin rutas
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

Esto inicia la API de tareas en `http://localhost:3000`. La base de datos se
crea automáticamente en `storage/tasks.sqlite`; `DATABASE_PATH`, `APP_NAME`,
`PORT` y `LOG_LEVEL` permiten cambiar los defaults sin un archivo de
configuración del framework.

Comprueba los tipos y ejecuta las pruebas de todos los workspaces:

```bash
bun run check
```

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
validación de body/query/params, errores estables, migraciones y pruebas HTTP.
Se ejecuta con `bun run example:api`.

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

`@bolt/database` envuelve `bun:sqlite` sin ocultar sus statements ni
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
el orden inverso junto con la aplicación.

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
});

await application.start();

console.log(`Bolt is running at ${application.url}`);
```

No existe una segunda instancia `BoltServer`: la aplicación posee el servidor y
expone su `url` y `port` después de arrancar. Los servicios adicionales
registrados con `use()` conservan su ciclo de vida ordenado alrededor del
servidor. Bolt también escucha `SIGINT` y `SIGTERM` para ejecutar un cierre
ordenado; esto permite que `bun --watch` libere recursos antes de reiniciar.

## Alcance del MVP

El MVP cubre aplicaciones HTTP, configuración tipada, logs, validación,
SQLite, migraciones y pruebas de integración. Aún no incluye CLI de
scaffolding, contenedor de dependencias, ORM/query builder, autenticación ni
sesiones. SQLite es el único almacenamiento integrado y las migraciones no
tienen `down`.

Los paquetes continúan privados y en `0.0.0`: el repositorio es consumible como
workspace, pero todavía no representa una beta publicable en un registry. Ese
hito requerirá fijar la API pública, asignar una versión prerelease y validar
una instalación desde un proyecto externo.

La configuración se basa en la documentación oficial de
[Bun](https://bun.com/docs), incluyendo las recomendaciones para
[TypeScript](https://bun.com/docs/typescript),
[`bunfig.toml`](https://bun.com/docs/runtime/bunfig) y
[workspaces](https://bun.com/docs/pm/workspaces), además de las APIs nativas de
[SQLite](https://bun.com/docs/runtime/sqlite) y
[`bun:test`](https://bun.com/docs/test).
