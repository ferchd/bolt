# Bolt

Framework para Bun y TypeScript, organizado como un monorepo de Bun.

## Requisitos

- Bun 1.4.0

## Estructura

```text
packages/
├── kernel/       Ciclo de vida y arranque de una aplicación Bolt
└── router/       Controladores y resolución de rutas

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

Arranca la aplicación vacía:

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

console.log("Bolt application started");
```

Una aplicación vacía no abre puertos ni presupone un transporte. El kernel solo
administra su ciclo de vida y permite detenerla de forma segura con
`await application.stop()`.

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
realiza matching durante una petición ni depende de un servidor. Un adaptador
posterior podrá transformar esta tabla en el objeto requerido por Bun.

Puedes ejecutar el ejemplo con `bun run example:routing`.

La configuración se basa en la documentación oficial de
[Bun](https://bun.com/docs), incluyendo las recomendaciones para
[TypeScript](https://bun.com/docs/typescript),
[`bunfig.toml`](https://bun.com/docs/runtime/bunfig) y
[workspaces](https://bun.com/docs/pm/workspaces).
