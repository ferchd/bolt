# Bolt

Framework para Bun y TypeScript, organizado como un monorepo de Bun.

## Requisitos

- Bun 1.4.0

## Estructura

```text
packages/
├── kernel/       Aplicación, ciclo de vida e integración HTTP con Bun
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
