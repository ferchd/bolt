# Validación de Bolt 0.1.1

Registro de la implementación posterior a la [auditoría inicial](framework-readiness.md),
realizada el 3 de octubre de 2026 con Bun 1.4.0 en Windows.

La aplicación de referencia combina autenticación, CSRF, permisos, SQL, ORM y
archivos versionados. Comprueba sesiones y contenido después de reiniciar con
almacenamiento durable, 64 altas en lotes concurrentes y dos escritores que
compiten por la misma versión. Estas comprobaciones prueban comportamientos
concretos; no constituyen un benchmark de carga sostenida.

La ejecución final contra los seis motores y Floci aprobó 286 pruebas, con
1334 assertions y cero fallos. Se omitió una prueba de DDL implícitamente
confirmado porque ese comportamiento no corresponde a PostgreSQL. La
comprobación TypeScript pasó en los 19 workspaces.

| Proveedor | Evidencia |
| --- | --- |
| SQLite | SQL real, rollback, scopes HTTP, joins, agregados, codecs y unidad de trabajo |
| PostgreSQL 16.9 | Servidor real, migraciones concurrentes, ORM y sesiones; caída y recuperación del servidor |
| MySQL 8.4.5 | Servidor real, DDL no transaccional, migraciones concurrentes, ORM y sesiones; caída y recuperación |
| MariaDB 11.4.5 | Servidor real, `RETURNING`, migraciones concurrentes, ORM y sesiones; caída y recuperación |
| SQL Server 2022 CU20 | ODBC nativo en PowerShell 5.1/7.6.5; precisión decimal/bigint, GUID, triggers, claves compuestas, rollback y sesiones |
| Oracle Free 26ai 23.26.3 | Instant Client 23.26.3 y PowerShell 5.1 reales: Unicode, valores exactos, output binds, claves generadas múltiples, triggers, transacciones, locks de migración y sesiones |
| S3 / Floci 1.5.8 | PUT/GET/copia, multipart, cancelación, error del stream y ausencia de cargas abandonadas |

Floci se ejecuta sin autenticación. Una suite independiente verifica SigV4
contra peticiones reales, incluyendo el hash del contenido y tokens de sesión.
Esto no valida políticas IAM de AWS ni todas las variantes de endpoints S3.
El disco local comprueba confinamiento de rutas, symlinks, publicación atómica,
límites de tamaño y cancelación.

La cancelación durante el inicio multipart recupera el ID con un plazo propio
de 10 segundos y limpia únicamente esa sesión. Las regresiones retienen la
respuesta de inicio o interrumpen una parte activa; comprueban cancelación del
input, transporte y limpieza, con repeticiones en Windows y Linux. La pérdida
de la respuesta por red o timeout todavía requiere lifecycle de uploads
abandonados en el proveedor.

El transporte ODBC usa drivers nativos instalados y requiere una plataforma
compatible. La suite de protocolos prueba límites de conexiones y colas,
timeouts, caídas del worker y reposición de conexiones. La matriz anterior no
certifica ODBC en Linux ni todas las versiones de los servidores. El harness
de Oracle extrae un RPM oficial verificado en un contenedor de compatibilidad;
los despliegues deben seguir las plataformas soportadas por Oracle.

Oracle requiere precisión explícita `NUMBER(p,s)` para resultados numéricos
exactos; `NUMBER`/`FLOAT` sin precisión que el driver describe como double se
rechaza con `unsupported_numeric_precision`. También puede seleccionarse
`TO_CHAR` para texto exacto. El ORM tipa conteos y booleanos explícitamente;
su aritmética, `sum` y `avg` tienen el contrato JavaScript `number`.

MySQL también se validó con una contraseña de 21 bytes y TLS obligatorio,
comprobando un `Ssl_cipher` de sesión no vacío. Esto evita la limitación RSA
sin TLS de Bun 1.4; el desarrollo sin TLS recibe un error accionable cuando
opta por recuperación de claves públicas con una contraseña afectada. No se
truncan credenciales. Los despliegues deben verificar el certificado y hostname.

`SqlPostCommitError.committed` distingue un commit confirmado seguido de un
fallo de limpieza. El ORM reconcilia los valores persistidos y el ejemplo
conserva el objeto referenciado. Una pérdida de conexión mientras se confirma
el commit puede dejar el resultado desconocido; Bolt no repite esas escrituras
automáticamente. La aplicación debe usar claves de idempotencia cuando proceda.

SQL y almacenamiento de objetos no comparten una transacción. La reconciliación
del ejemplo es acotada, comienza en modo inspección y requiere detener todos los
escritores. La limpieza en línea requiere un outbox o protocolo del dominio.
Las migraciones son forward-only, con checksums y bloqueo por motor; los fallos
de DDL no transaccional dejan un estado dirty que impide repetirlo a ciegas.

Todos los paquetes de runtime dependen exclusivamente de Bolt, Bun y APIs del
sistema. TypeScript y las definiciones existentes siguen siendo dependencias de
desarrollo. Crear componentes propios no elimina la necesidad de revisar su
seguridad. Los proveedores de usuarios y políticas de dominio son reemplazables;
no se incluyen MFA, recuperación de contraseñas ni un límite distribuido de login.
MongoDB y DynamoDB quedan aplazados. Azure Blob y GCS requieren adaptadores
específicos de `StorageDisk`; no se anuncian como implementados.

Comprobaciones reproducibles:

```sh
bun run check
bun run verify:packages
bun run release:check
bun run verify:recovery
# Después de publicar; BOLT_GITLAB_TOKEN se obtiene fuera del repositorio:
bun run verify:registry
# Con las variables del servidor PostgreSQL y del almacenamiento S3 de pruebas:
bun run verify:registry --services
```

Las suites contra servicios externos se habilitan con las variables documentadas
por cada paquete. CI ejecuta tipos, pruebas, instalación de tarballs, PostgreSQL,
MySQL, MariaDB y Floci. SQL Server y Oracle se validan con los drivers Windows;
los jobs Linux no sustituyen esas pruebas. Antes de un despliegue se deben
validar TLS, permisos, backups/restauración, límites y carga esperada en su
infraestructura concreta. Bolt 0.1.1 permite construir la aplicación, pero aún
no declara la estabilidad de una API 1.0 ni certifica cualquier despliegue.
