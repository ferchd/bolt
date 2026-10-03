# Changelog

Todos los cambios relevantes de Bolt se documentarán en este archivo.

El formato está basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/)
y el proyecto sigue [Versionado Semántico](https://semver.org/lang/es/).

## [Sin publicar]

### Añadido

- Se incorporó `@bolt/cli` con comandos de desarrollo, arranque, pruebas,
  listado de rutas, migración, estado de migraciones y generadores seguros de
  aplicaciones, controladores y migraciones.
- Se incorporó `@bolt/container` con tokens tipados, providers de valor,
  factory y clase, lifetimes, detección de ciclos y disposición inversa.
- `BoltApplication` ahora acepta bindings y providers con fases `register`,
  `boot` y `shutdown`; los controladores pueden resolverse por token.
- Se incorporó `@bolt/security` con cabeceras seguras, CORS/preflight, rate
  limiting acotado, cookies HMAC, CSRF double-submit y Argon2id.
- El contexto HTTP ahora incluye request ID, IP del cliente, logger por
  petición, resolución de servicios y control del timeout.
- Se añadieron hooks de petición/respuesta/error, access logs con duración y
  propagación configurable de `x-request-id`.
- Se añadieron límites seguros del servidor para cuerpos e idle timeout, junto
  con configuración de TLS, IPv6 y reutilización de puerto.
- La validación ahora incluye literales, enums, uniones, nullables, fechas,
  UUID, archivos, defaults, refinamientos, transformaciones y objetos parciales.
- Se añadió estado de migraciones aplicadas, pendientes o ausentes y apertura
  de la base sin migración automática para tooling.
- Se añadió una prueba reproducible que empaqueta todos los workspaces, instala
  sus tarballs en un consumidor externo, comprueba TypeScript y arranca Bolt.
- Se incorporó `@bolt/database` sobre `bun:sqlite`, con ciclo de vida,
  statements tipados, transacciones, claves foráneas, busy timeout y WAL para
  bases de datos persistentes.
- Se añadieron migraciones forward-only, síncronas y transaccionales, ordenadas
  por ID y registradas en `__bolt_migrations`.
- Se incorporó `@bolt/testing` con un cliente HTTP que arranca aplicaciones en
  puertos efímeros, construye query strings y cuerpos JSON, y respeta el
  ownership del ciclo de vida.
- Se añadió `examples/api`, una API CRUD de tareas que integra kernel, router,
  configuración, validación, SQLite, migraciones y pruebas de extremo a
  extremo.
- Se incorporó `@bolt/config` con lectura tipada de strings, números, enteros,
  booleanos y conjuntos de valores desde el entorno cargado por Bun.
- Se añadieron valores por defecto, detección de variables obligatorias y
  errores de configuración que no exponen sus contenidos.
- Se incorporó `@bolt/http` con un contexto tipado para parámetros, query
  string, cookies, headers y cuerpos de petición.
- Se añadió un contrato JSON para errores HTTP esperados e inesperados, con
  ocultación de detalles internos fuera del entorno de desarrollo.
- Los callbacks y middleware del router ahora reciben tipos concretos para el
  contexto y la continuación de la cadena.
- Se incorporó `@bolt/logger` con niveles, salida legible o JSON, contexto hijo
  y redacción automática de campos sensibles.
- `BoltApplication` registra su ciclo de vida y los errores HTTP inesperados
  mediante un logger disponible sin configuración adicional.
- Se incorporó `@bolt/validation` con esquemas composables, inferencia de tipos,
  coerción conservadora y errores con paths deterministas.
- El contexto HTTP ahora ofrece `validate.body`, `validate.query` y
  `validate.params`, devolviendo errores `400` o `422` estables.
- Se incorporó `@bolt/kernel` como primer paquete del framework.
- Se añadió un ciclo de vida extensible con servicios que arrancan en orden, se
  detienen en orden inverso y se revierten cuando falla el inicio.
- Se integró `Bun.serve` directamente en el ciclo de vida de
  `BoltApplication`.
- Se integró la tabla compilada del router con las rutas nativas de Bun al
  iniciar la aplicación.
- Se añadió ejecución de middleware, resolución de controladores por petición y
  serialización automática de resultados HTTP.
- Se incorporó `@bolt/router` con una API declarativa inspirada en AdonisJS.
- Se añadieron rutas para los métodos HTTP comunes y handlers inline o basados
  en controladores.
- Se añadieron grupos anidados con prefijos, nombres y middleware compartido.
- Se añadió `router.static()` para servir directorios mediante las rutas
  nativas y seguras de Bun.
- Se añadió la compilación de definiciones en una tabla por path y método para
  mantener el router separado del runtime HTTP.
- Se añadió detección temprana de paths y nombres de ruta duplicados.
- Se añadió `BoltApplication.create()` para construir aplicaciones Bolt.
- Se implementó el ciclo de vida mediante `start()`, `stop()` e `isRunning`;
  `start()` inicia el servidor y `stop()` lo detiene.
- Se añadió una aplicación vacía en `examples/empty` que consume el kernel como
  dependencia local.
- Se incorporaron pruebas para la creación, el inicio y la detención idempotente
  de aplicaciones.
- Se añadieron comandos globales para desarrollo, comprobación de tipos y
  pruebas de los workspaces.

### Cambiado

- Las migraciones adquieren una transacción `IMMEDIATE` antes de descubrir el
  trabajo pendiente para tolerar arranques concurrentes.
- Las migraciones se aplican al arrancar por defecto y pueden desactivarse de
  forma persistente o para una apertura concreta.
- Los paquetes declaran explícitamente exports de TypeScript para Bun, tipos,
  contenido del tarball y runtime mínimo sin dejar de ser privados.
- El ejemplo API usa providers, controladores con DI, trazas por petición,
  seguridad y la CLI para sus flujos diarios.
- El ejemplo API persistente es ahora el destino de `bun run dev` y
  `bun run start`.
- El kernel valida y compila las rutas antes de iniciar servicios, y registra
  las señales de cierre mientras la aplicación todavía está arrancando.
- Las pruebas de los ejemplos forman parte de la configuración TypeScript
  compartida.
- Las llamadas concurrentes a `start()` y `stop()` ahora comparten y ordenan
  sus transiciones sin iniciar o detener servicios más de una vez.
- Los fallos durante el rollback de inicio conservan el error original junto
  con cualquier error producido durante la limpieza.
- La aplicación ahora procesa `SIGINT` y `SIGTERM` con un cierre ordenado y
  retira sus listeners al detenerse.
- El repositorio ahora utiliza Bun Workspaces para organizar paquetes y
  ejemplos.
- La instalación de dependencias usa enlaces aislados y el almacén global de
  Bun.
- La configuración compartida de TypeScript incluye explícitamente el código y
  las pruebas de todos los workspaces.

### Corregido

- Los callbacks asíncronos de grupos de rutas ahora se rechazan antes de que
  puedan registrar rutas fuera de su prefijo o middleware.
- Las rutas estáticas ya no pueden heredar middleware que el servidor nativo
  no aplicaría silenciosamente.
- El rollback de arranque elimina los listeners de señales incluso cuando
  falla el destino de logs.

### Infraestructura inicial

- Se configuró Bun 1.4.0 como runtime y gestor de paquetes.
- Se configuró TypeScript 7 con comprobaciones estrictas e incrementales.
- Se añadió un lockfile reproducible y configuración común de desarrollo.
