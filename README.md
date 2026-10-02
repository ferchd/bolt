# bolt

Runtime de TypeScript configurado para Bun.

## Requisitos

- Bun 1.4.0

## Desarrollo

Instala las dependencias exactas registradas en `bun.lock`:

```bash
bun install --frozen-lockfile
```

Ejecuta el proyecto con recarga automática:

```bash
bun run dev
```

También puedes iniciarlo una sola vez o comprobar los tipos:

```bash
bun run start
bun run typecheck
```

## Producción

Genera un bundle optimizado para el runtime de Bun:

```bash
bun run build
```

Para reducir el tiempo de arranque, también puedes crear un ejecutable nativo
con bytecode precompilado:

```bash
bun run compile
```

La configuración se basa en la documentación oficial de
[Bun](https://bun.com/docs), incluyendo las recomendaciones para
[TypeScript](https://bun.com/docs/typescript),
[`bunfig.toml`](https://bun.com/docs/runtime/bunfig) y
[bundles ejecutables](https://bun.com/docs/bundler/executables).
