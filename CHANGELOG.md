# Changelog

Todos los cambios relevantes de Bolt se documentarán en este archivo.

El formato está basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/)
y el proyecto sigue [Versionado Semántico](https://semver.org/lang/es/).

## [0.1.2] - 2026-10-03

### Corregido

- La publicación desde workspaces usa configuración Bun explícita con la
  credencial limitada al registry GitLab, validada mediante HTTP real.

`0.1.2` es la primera distribución. Los tags previos conservan las validaciones
y los intentos de publicación que no llegaron a subir paquetes.

## [0.1.1] - 2026-10-03 (sin distribución)

### Corregido

- Cancelar durante el inicio de una carga multipart espera de forma acotada
  el identificador para abortar únicamente esa sesión y evitar cargas huérfanas.
- El scaffold genera dependencias de la versión instalada del CLI.

El tag `v0.1.0` se conserva para auditoría; sus paquetes no se publicaron al
detectarse una carrera de cancelación en la validación final. La publicación
de `0.1.1` se detuvo por configuración de autenticación antes del primer paquete.

## [0.1.0] - 2026-10-03 (sin distribución)

### Añadido

- Se incorporó `@bolt/auth` con contraseñas Argon2id, sesiones SQL opacas,
  rotación atómica, expiración, revocación y autorización por políticas.
- La aplicación de persistencia incorpora CSRF, permisos, respuestas privadas,
  pruebas concurrentes, recuperación tras reinicio y reconciliación de objetos.
- Se validó S3 contra Floci 1.5.8 y se implementó transporte propio SigV4 con
  cancelación y limpieza multipart; los fallos de limpieza se informan.
- Se añadieron pruebas reales de caída, rollback y recuperación de los pools
  PostgreSQL, MySQL y MariaDB.

- Se añadió SQL asíncrono con pools, conexiones nombradas, transacciones
  reservadas y migraciones con checksums para múltiples dialectos.
- Se incorporó el transporte propio ODBC para SQL Server y Oracle, con
  parámetros preparados y worker PowerShell, sin dependencias JS externas.
- Se incorporó `@bolt/orm` con expresiones LINQ tipadas, SQL parametrizado,
  joins, agregados, concurrencia optimista y unidad de trabajo explícita.
- Se incorporó `@bolt/storage` con disco local, S3 compatible, streaming,
  escritura local atómica, multipart y URLs firmadas.
- Se añadió `examples/persistence` con metadata SQL, repositorios por petición
  y actualización versionada de archivos.
- Se añadió configuración de estructura y plantillas para el scaffold,
  generación de entidades, vistas previas y conexiones de migración nombradas.
- Se incorporó distribución en GitLab Package Registry, con validación de metadatos,
  pipeline de integración SQL y publicación manual mediante tags protegidos.
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

- El scaffold predeterminado ahora es mínimo y deja la persistencia como opción.
- Los 15 paquetes declaran versiones coherentes y un registry GitLab canónico;
  GitHub recibe el mirror de ramas protegidas y tags de release.
- El contenedor admite scopes por petición, conservados durante streaming;
  los singleton no pueden capturar recursos scoped.
- Las migraciones adquieren una transacción `IMMEDIATE` antes de descubrir el
  trabajo pendiente para tolerar arranques concurrentes.
- Las migraciones se aplican al arrancar por defecto y pueden desactivarse de
  forma persistente o para una apertura concreta.
- Los paquetes declaran explícitamente exports de TypeScript para Bun, tipos,
  contenido del tarball y runtime mínimo.
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

- La conexión MySQL afectada por autenticación RSA de Bun requiere TLS sin
  modificar contraseñas; CI verifica el cifrado real de la sesión.
- Oracle conserva Unicode y valores exactos con precisión explícita; el driver
  rechaza resultados numéricos ambiguos y preserva salidas temporales nativas.
- Las rutas registradas en `boot` se incorporan antes de iniciar HTTP.
- Las migraciones del CLI esperan operaciones asíncronas antes del cierre.
- La creación de SQLite con un nombre relativo evita intentar recrear `.` en Windows.
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
