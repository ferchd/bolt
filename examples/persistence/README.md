# Persistencia y almacenamiento

Aplicación HTTP que combina SQL asíncrono, ORM propio, repositorios por petición,
validación y almacenamiento intercambiable. Ejecutar `bun run example:persistence`.
El entry requiere `AUTH_USER_ID`, `AUTH_LOGIN`, `AUTH_PASSWORD_HASH` (Argon2id)
y `CSRF_SECRET` (al menos 32 bytes). No incluye credenciales por defecto. Para
HTTP local usar `AUTH_SECURE_COOKIE=false`; en producción mantener cookies
seguras y servir mediante HTTPS. Generar el hash con `hashPassword` de
`@bolt/security` y almacenar las variables fuera del repositorio.

Obtener primero `GET /auth/csrf`, conservar sus cookies y enviar el campo
`token` como cabecera `x-csrf-token` en las mutaciones, incluido
`POST /auth/login` con `{ "login": "...", "password": "..." }`. Conservar la
cookie de sesión devuelta. `POST /auth/rotate` rota la sesión sin extender su
vida absoluta y `POST /auth/logout` la revoca. Las rutas de assets requieren
`assets.read` o `assets.write`; el proveedor de usuarios es reemplazable y debe
aplicar la pertenencia a tenants y el estado actual de las cuentas. El ejemplo
de entry usa un operador configurado por entorno, no un sistema de altas.
El arranque valida las variables de credenciales antes de aceptar peticiones.
El login expone únicamente `id` y `permissions`; los campos internos del
proveedor no se serializan. Todas las respuestas de la aplicación autenticada,
incluidos errores, tokens CSRF y descargas, usan `Cache-Control: no-store`.

Usa SQLite y disco local por defecto. Para PostgreSQL/MySQL/MariaDB, configurar
`DATABASE_DIALECT` y `DATABASE_URL`. Para S3, configurar `STORAGE_DISK=s3`,
`S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, y opcionalmente endpoint/región.

Crear un asset con `POST /assets` y JSON `{ "title": "Report" }`. Su versión
inicial es 1. Subir su contenido con `PUT /assets/<id>/content` e
`If-Match: "1"`. Descargar con `GET /assets/<id>/content` y filtrar metadata con
`GET /assets?title=Report`. Las consultas se ejecutan en SQL; no filtran arrays
cargados en memoria. El listado se limita a 50 filas ordenadas por clave.

Cada actualización escribe un objeto nuevo y después cambia la referencia con
concurrencia optimista. Si falla la actualización de metadata, elimina el objeto
nuevo; si falla limpiar el anterior, registra la necesidad de limpieza.
Si `COMMIT` fue confirmado y falla la limpieza de la conexión, conserva el
objeto nuevo referenciado e informa el error; no se debe repetir la escritura
sin comprobar su versión persistida. Una
interrupción del proceso entre almacenamiento y DB puede dejar un objeto huérfano:
`src/reconcile.ts` permite reconciliar durante mantenimiento exclusivo, con los
escritores detenidos en todas las réplicas. Por defecto solo inspecciona: informa
objetos huérfanos y referencias sin contenido. `dryRun: false` elimina únicamente
objetos no referenciados dentro de `assets/`, después de completar la inspección;
los límites de filas, referencias y objetos fallan antes de borrar. Si necesitas
limpieza mientras la aplicación escribe, implementa un outbox con leases en tu
dominio. No hay una
transacción distribuida entre SQL y el disco. El factory permite omitir `auth`
para pruebas aisladas; el entry ejecutable siempre la configura. El límite de
login es por proceso; una aplicación con varias réplicas necesita un límite
compartido. Las pruebas comprueban rechazo de acceso anónimo, CSRF, revocación,
permisos, 64 altas concurrentes, conflicto de escritura y recuperación de SQL,
objetos y sesiones después de reiniciar la aplicación con almacenamiento durable.

SQL Server/Oracle pueden suministrarse a `createPersistenceApplication` con un
transporte explícito. Oracle requiere permisos de ejecución sobre `DBMS_LOCK`
para el lock de migraciones predeterminado, o un `migrationOptions.lock` propio;
el arranque de este ejemplo se limita a los proveedores nativos indicados.
