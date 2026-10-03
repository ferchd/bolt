# Bolt

Framework para Bun y TypeScript, organizado como un monorepo de Bun.

## Requisitos

- Bun 1.4.0

## Estructura

```text
packages/
├── config/       Acceso tipado a las variables de entorno
├── http/         Contexto, respuestas y errores HTTP
├── kernel/       Aplicación, ciclo de vida e integración HTTP con Bun
├── logger/       Logs legibles o estructurados con contexto
└── router/       Definición y compilación de rutas

examples/
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

Comprueba los tipos y ejecuta las pruebas de todos los workspaces:

```bash
bun run check
```

Las dependencias internas entre paquetes usarán el protocolo `workspace:*`, de
modo que Bun las enlace localmente durante el desarrollo y las convierta a una
versión concreta al publicar.

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
servidor.

La configuración se basa en la documentación oficial de
[Bun](https://bun.com/docs), incluyendo las recomendaciones para
[TypeScript](https://bun.com/docs/typescript),
[`bunfig.toml`](https://bun.com/docs/runtime/bunfig) y
[workspaces](https://bun.com/docs/pm/workspaces).
