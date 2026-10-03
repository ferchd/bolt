# Evaluación de Bolt para aplicaciones estables

Fecha: 3 de octubre de 2026. Auditoría histórica del commit indicado abajo,
anterior a la implementación multimotor. El estado actual se documenta en el
[README](../README.md). La posterior decisión de desarrollar ORM y adaptadores
propios sustituye la propuesta de integrar paquetes externos de este informe;
MongoDB y DynamoDB quedan aplazados.

## Dictamen

Bolt tiene una base HTTP modular y comprobada que merece conservarse. El estado
actual es un MVP con SQLite, no un framework que satisfaga el objetivo de
persistencia multimotor, ORM de estilo LINQ, almacenamiento intercambiable y
generación de proyectos con estructura elegida por el desarrollador.

SQLite puede respaldar aplicaciones reales. La limitación de Bolt para este
proyecto es su contrato de persistencia, que expone directamente SQLite y no
permite sustituirlo por los motores exigidos conservando el API de aplicación.
Agregar nombres de drivers a una configuración no resolvería esa limitación.

## Alcance y evidencia

- Código local revisado: `0a8df07a08ab87da244e9b2439c791917a297bff`, rama `master`.
- El árbol de trabajo estaba limpio al comenzar; no había remotos configurados.
- Se revisaron los paquetes, sus contratos, pruebas, CLI, ejemplo CRUD,
  configuración de Bun y verificación de consumidores externos.
- `bun run check`: tipos y pruebas de los workspaces pasan con Bun 1.4.0.
- `bun run verify:packages`: pasan los 11 tarballs en un consumidor externo.
- Estas comprobaciones no prueban carga sostenida, recuperación frente a fallos
  de red, bases de datos externas ni almacenamiento de objetos.
- Dos sondas adicionales ejecutadas desde stdin reprodujeron el cierre prematuro
  de una migración asíncrona en el CLI y la retención de recursos transient
  hasta el cierre del contenedor. No modificaron el código de producción.

Se verificaron ambos repositorios mediante los conectores autenticados:

| Repositorio | Estado observado |
| --- | --- |
| [GitLab](https://gitlab.com/ferchd/bolt) | Privado, proyecto `87197832`, Package Registry habilitado, rama predeterminada `main` protegida |
| [GitHub](https://github.com/ferchd/bolt) | Público, rama predeterminada declarada `main` |

El árbol raíz de GitLab `main`, en el commit
`7bab62d2f8e86e084db08984ffe0878affd3d470`, contiene solo `README.md` y
`.gitlab-ci.yml`. No contiene el framework local revisado. La descripción del
commit corresponde a configurar detección de secretos. No se auditó la ejecución
de ese pipeline ni se verificó una configuración activa de mirroring.
La existencia de los dos repositorios no acredita su sincronización. La
integración inicial debe preservar el contenido remoto existente.

## Brechas frente a los requisitos

| Requisito | Estado actual | Trabajo necesario |
| --- | --- | --- |
| HTTP, validación, configuración, logs y DI | Implementados y con pruebas | Conservar; completar aislamiento de recursos y validación operativa |
| SQLite | Implementado con `bun:sqlite`, WAL, transacciones y migraciones | Mantener como adaptador con pruebas propias |
| MariaDB y MySQL | Sin adaptadores | Drivers, dialectos, pools y pruebas contra ambos motores |
| PostgreSQL | Sin adaptador | Driver, dialecto, transacciones y pruebas reales |
| Microsoft SQL Server y Oracle | Sin adaptadores | Integrar drivers, normalizar tipos y comprobar compatibilidad con Bun |
| MongoDB y DynamoDB | Sin adaptadores | Proveedores con semántica de documentos y claves, respectivamente |
| Otros motores | Sin contrato de extensión | Registro de adaptadores y capacidades verificables |
| ORM y consultas LINQ | No existen | Mapping, consultas diferidas, expresiones tipadas y seguimiento de cambios |
| S3 y otros almacenamientos | No existe paquete de almacenamiento | Contrato de objetos, adaptadores y pruebas |
| Scaffold configurable | Generadores básicos con rutas fijas | Skeleton mínimo, rutas y plantillas configurables |
| Distribución por GitLab | Paquetes privados `0.0.0`, sin registry local configurado | Versionado, publicación e instalación desde GitLab |
| GitHub como mirror de contribuciones | Repositorio público existente | Definir integración de PR y espejo en una sola dirección |

## Hallazgos concretos

### La persistencia pública depende de SQLite

En `packages/database/src/database.ts`, `connection` devuelve `SQLiteDatabase`,
`query()` devuelve `Statement`, `run()` devuelve `Changes` y `transaction()`
expone las variantes `deferred`, `immediate` y `exclusive`. Las migraciones
rechazan promesas y el descubrimiento de esquema usa `sqlite_schema`.

No hay contratos de pool, dialecto, sesión transaccional, repositorio, entidades
o compilación de expresiones. Los parámetros genéricos de `query<Row>()`
describen el resultado esperado por el usuario; no verifican un mapping de
entidades ni la concordancia entre SQL y tipos.

La capa nueva debe ser asíncrona y separar conexión, consultas, ORM y gestión de
esquema. El API SQLite existente requiere una ruta de migración explícita; un
cambio incompatible debe marcarse incluso antes de 1.0.

### El CLI todavía presupone migraciones síncronas

En `packages/cli/src/application-module.ts`, `DatabaseLike.migrate()` y
`migrationStatus()` devuelven arrays síncronos. `withDatabase()` devuelve
`callback(database)` dentro de un `try/finally` sin esperar su resolución antes
de cerrar la conexión.

Una sonda con un adaptador simulado asíncrono produjo este orden:

```text
start → migration-start → stop → migration-finished-disconnected
```

El camino SQLite actual es síncrono y sus pruebas pasan. Para incorporar un
driver remoto hay que cambiar el contrato y esperar la operación dentro del
`try`, antes del `finally`. `migrationStatus()` también debe esperarse antes
de transformar su resultado.

### Falta un scope por petición o trabajo

`packages/container/src/provider.ts` ofrece solo `singleton` y `transient`.
`Container.track()` conserva todos los recursos disposable hasta
`Container.dispose()`. Una sonda resolvió 100 recursos transient: ninguno fue
liberado antes del cierre; los 100 se liberaron al cerrar el contenedor.

Para un EntityManager, una Unit of Work o recursos por petición, este contrato
puede retener memoria y conexiones durante toda la vida del servidor. Se
necesitan scopes hijos con disposición al finalizar la petición o trabajo,
incluyendo errores y cancelaciones. Pools y clientes compartidos pueden seguir
siendo singleton; sesiones y seguimiento de entidades deben aislarse.

### El scaffold no satisface la libertad estructural solicitada

`packages/cli/src/scaffold.ts` fija `src/controllers`, `database/migrations`,
`src/application.ts` y `src/main.ts`. `--entry` y `--app` ya permiten cambiar
los puntos de carga del CLI, pero no los destinos de los generadores.

`bolt new` crea una ruta de ejemplo, registra SQLite y añade dependencias
`latest`; no genera configuración de GitLab. Los paquetes locales son privados
y no tienen una versión publicada, por lo que un `bun install` ordinario del
scaffold no está validado por la prueba de tarballs.

`make:migration` genera un archivo, pero no incorpora ese archivo al registro de
migraciones de la aplicación. El descubrimiento o registro explícito de
migraciones necesita un contrato y documentación coherentes.

### La estabilidad requiere más que conectividad

Hay manejo de errores HTTP, cierre de servicios y protección básica, pero no
evidencia de una matriz de integración para los motores pedidos. El rate limiter
actual usa memoria local. Autenticación/autorización completa, almacenamiento
compartido cuando se despliegue en varias instancias, readiness, métricas y
trazas requieren alcance y pruebas propios según la aplicación.

## Arquitectura recomendada

Conservar kernel, router, HTTP, validación, configuración y logging. Añadir
contratos estrechos y adaptadores opcionales; el core no debe instalar todos los
drivers. La política actual de cero dependencias externas de runtime debe
limitarse al core: los adaptadores podrán depender de drivers mantenidos.

| Responsabilidad propuesta | Contrato |
| --- | --- |
| Persistencia | Conexiones nombradas, ciclo de vida, capacidades y errores normalizados |
| SQL | Ejecución parametrizada, pools, sesión transaccional y dialectos |
| Consultas | Plan inmutable, expresiones tipadas y ejecución diferida |
| ORM | Metadata de entidades, relaciones, repositorios y seguimiento de cambios |
| Esquema | Migraciones asíncronas y comportamiento explícito por proveedor |
| Almacenamiento | Discos nombrados y operaciones sobre objetos/streams |
| CLI | Skeletons y generators que consumen configuración de proyecto |

Esta separación expresa responsabilidades; no exige crear un paquete vacío
por cada fila antes de tener implementación.

### Proveedores y reutilización de componentes

La documentación de [Bun SQL](https://bun.com/docs/runtime/sql) ofrece una API
asíncrona para PostgreSQL, MySQL y SQLite. Puede servir como transporte de esos
adaptadores, pero no proporciona por sí misma el ORM solicitado. MariaDB debe
tener validación propia; compartir protocolo no prueba toda su semántica.

Antes de construir desde cero un ORM completo, recomiendo evaluar una
integración encapsulada con [MikroORM](https://mikro-orm.io/docs/quick-start).
Su documentación lista drivers para SQLite, PostgreSQL, MySQL, MariaDB, SQL
Server, Oracle y MongoDB, e incluye instalación con Bun. Es una cobertura
prometedora, no una certificación de compatibilidad con esta versión de Bolt ni
una implementación LINQ disponible en Bolt. DynamoDB requiere un proveedor
separado.

El spike debe verificar esos drivers en Bun y los mecanismos de metadata usados
por el ORM; evitar introducir una obligación de decoradores/reflexión para el
usuario. Como alternativas de transporte para SQL Server y Oracle están
[node-mssql](https://tediousjs.github.io/node-mssql/) y
[node-oracledb](https://node-oracledb.readthedocs.io/en/latest/user_guide/installation.html).
Sus documentos de Node.js no certifican ejecución en Bun; esa compatibilidad
debe demostrarse con integración. Oracle distingue modos Thin y Thick y sus
requisitos de cliente.

Para MongoDB y DynamoDB, evaluar el [driver oficial de MongoDB](https://www.mongodb.com/docs/drivers/node/current/)
y el [SDK de AWS para DynamoDB](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/javascript_dynamodb_code_examples.html).
No seleccionar versiones ni publicar garantías sin ejecutar la matriz.

### Un ORM robusto orientado a LINQ

API ilustrativa propuesta, aún no disponible:

```ts
const users = await orm.repository(User)
  .query()
  .where(u => u.active.eq(true).and(u.age.gte(18)))
  .select(u => ({ id: u.id, email: u.email }))
  .orderBy(u => u.email)
  .take(50)
  .toList();
```

`u` representa campos de una expresión, no una entidad cargada. Los callbacks
construyen un árbol de expresiones y los métodos terminales ejecutan el plan en
el proveedor. Filtros, proyección y paginación deben ocurrir en el servidor.

Las comparaciones JavaScript ordinarias como `u.age >= 18` no generan ese árbol.
Aceptar esa sintaxis exigiría una transformación de compilación explícita, con
captura de variables y límites documentados. No analizar `Function.toString()`
ni ejecutar código arbitrario para traducir consultas. Una DSL tipada explícita
permite comenzar sin ese requisito de build.

El contrato robusto debe cubrir:

- Inferencia de filtros/proyecciones, nulabilidad, relaciones y claves compuestas.
- Consultas diferidas, `where`, `select`, `orderBy/thenBy`, agregaciones,
  `join/groupBy` cuando el proveedor los admita y operadores terminales.
- Paginación determinista, cursores y streaming con cancelación.
- Mapping explícito de decimal, bigint, fecha, zona horaria, JSON, binarios y enum.
- Carga de relaciones sin consultas N+1 accidentales; límites explícitos de carga.
- Identity Map y Unit of Work aisladas por scope, escritura por lotes y
  concurrencia optimista donde pueda garantizarse.
- Transacciones en una conexión/sesión, aislamiento y savepoints según capacidades.
- SQL parametrizado, identificadores validados, vía de acceso nativa explícita y
  diagnóstico del plan sin valores sensibles.
- Migraciones con checksums, locks adecuados y estrategia de recuperación;
  indicar DDL no transaccional y operaciones irreversibles.

No crear una falsa equivalencia entre SQL, MongoDB y DynamoDB. El proveedor debe
declarar capacidades y rechazar operaciones no soportadas. DynamoDB necesita
partition/sort keys, índices y cursores; scans deben ser explícitos. No emular
joins o filtros descargando tablas completas. Las garantías de consistencia y
transacción deben reflejar el proveedor real. No prometer transacciones atómicas
entre motores distintos o entre una base de datos y S3.

### Almacenamiento intercambiable

Proponer discos nombrados: `local`, `s3`, otros endpoints compatibles con S3,
`azure` y `gcs`, además de adaptadores personalizados. El contrato debe incluir
lectura/escritura por streams, eliminación, existencia, metadata, listado con
cursor, copia y URLs temporales cuando el proveedor las admita.

[Bun S3](https://bun.com/docs/runtime/s3) permite comenzar con AWS S3, MinIO,
Cloudflare R2 y otros servicios compatibles. Azure Blob y Google Cloud Storage
necesitan adaptadores específicos cuando se usen sus APIs nativas.

Definir capacidades para multipart, escritura condicional, checksums, URLs
firmadas y operaciones de copia. No simular que cada proveedor ofrece lo mismo.
La política de credenciales, límites, timeout, cancelación y reintentos debe
formar parte de la integración. En fallos entre DB y objetos usar estados
explícitos y compensación o un outbox cuando la aplicación lo requiera.

### Skeleton y estructura elegida por el desarrollador

`bolt new` debe generar un arranque mínimo, sin base de datos, dominio ni ruta de
demostración obligatorios. SQLite y otros proveedores se añadirían mediante
opciones o recetas. Las recetas deben ser inspeccionables y reversibles.

Introducir configuración opcional de entrypoint, módulo de aplicación, rutas,
controllers, entidades, migraciones, tests y plantillas. Los defaults ayudan a
comenzar, pero deben admitir MVC, módulos por dominio, hexagonal o estructura
propia sin renombrar el runtime. Los imports deben derivarse de la configuración.

Comandos ilustrativos propuestos, aún no implementados:

```sh
bolt new my-app --template minimal
bolt make:controller User --path app/accounts/http
bolt make:entity User --path app/accounts/domain
bolt make:migration create_users --connection primary
```

Exigir destinos seguros incluyendo symlinks, no sobrescritura, dry-run, planes
de archivos revisables y comportamiento claro ante un fallo parcial. Fijar
versiones de Bolt y tooling, generar la configuración del registry y probar el
proyecto generado completo: instalación, tipos, arranque, prueba HTTP y generación
en una estructura personalizada. La referencia de [Symfony](https://symfony.com/doc/current/setup.html)
sirve para el enfoque de skeleton mínimo y capacidades opcionales; la libertad
de rutas aquí descrita es un requisito adicional de Bolt.

## GitLab como origen y registry; GitHub para contribuciones

Usar GitLab como origen canónico de código, tags, pipeline y releases. Bun puede
instalar/publicar en registries compatibles con el formato npm; esto no obliga
a usar el comando npm ni a publicar Bolt en npmjs.org. Véanse
[registries de Bun](https://bun.com/docs/pm/scopes-registries) y
[GitLab Package Registry](https://docs.gitlab.com/user/packages/npm_registry/).

El endpoint de proyecto verificado permite conservar el scope `@bolt`. Esta es
la configuración propuesta para instalar paquetes Bolt, todavía no aplicada:

```ini
@bolt:registry=https://gitlab.com/api/v4/projects/87197832/packages/npm/
//gitlab.com/api/v4/projects/87197832/packages/npm/:_authToken=${BOLT_GITLAB_TOKEN}
```

El proyecto es privado: sus consumidores requieren acceso/autenticación. Si se
pretende instalación pública, hay que definir la visibilidad de la distribución.
Separar la decisión de no publicar Bolt en npmjs.org de la procedencia de
dependencias externas. Si se requiere cero tráfico a npmjs.org, también hay que
replicar/aprovisionar dependencias y controlar el forwarding de GitLab y el
registry por defecto; configurar solo `@bolt` no alcanza ese objetivo.

La publicación requiere versiones SemVer reales, manifiestos publicables con
`publishConfig`, dependencias internas resueltas, `files/exports`, verificación
de contenidos y CI que publique con credenciales de job en tags protegidos.
El monorepo raíz y los ejemplos deben seguir privados. Los tarballs actuales
son una buena prueba inicial; todavía falta instalar por nombre y versión desde
GitLab, sin overrides locales.

Para contribuciones, usar el flujo:

```text
PR en GitHub → revisión y CI sin credenciales de publicación
             → integración en MR de GitLab
             → merge y release en GitLab
             → mirror de código/tags hacia GitHub
```

El mirror debe tener una sola dirección para las ramas canónicas. No fusionar
independientemente en los dos `main`: el
[push mirror de GitLab](https://docs.gitlab.com/user/project/repository/mirror/push/)
puede sobrescribir referencias divergentes. Preservar autoría y documentar cómo
se trasladan contribuciones; los PR, comentarios e issues no forman parte del
espejo Git. Antes de la apertura del código, definir licencia y guía de
contribución. No se configuraron remotos, mirror, publicación ni pushes durante
esta evaluación.

## Secuencia de ejecución y criterios de aceptación

| Orden | Entrega | Evidencia exigida |
| --- | --- | --- |
| 1 | Contratos asíncronos, scopes y migración del API SQLite | Pruebas de cierre, rollback, cancelación y aislamiento entre peticiones/trabajos |
| 2 | Spike del backend ORM y expresiones LINQ | Consultas ejecutadas en servidor, inferencia y mapping correctos, sin evaluación implícita en memoria |
| 3 | SQLite, PostgreSQL, MariaDB, MySQL | Misma suite de contrato y pruebas específicas por dialecto contra motores reales |
| 4 | SQL Server y Oracle | Validación en Bun y plataformas objetivo; pools, transacciones y tipos reales |
| 5 | MongoDB y DynamoDB | Suite de capacidades, índices, cursores, consistencia y errores de operaciones no soportadas |
| 6 | Local, S3 y proveedores adicionales | Streaming, paginación, fallos de red, URLs temporales y semántica específica verificadas |
| 7 | Scaffold libre y distribución GitLab | Crear una app fuera del monorepo, instalar desde GitLab y ejecutar checks sin overrides |
| 8 | Validación operativa y contribuciones | CI reproducible, carga sostenida, fallo/recuperación, despliegue y flujo PR→MR→mirror comprobados |

Esta secuencia es de implementación, no una reducción del alcance: todos los
motores exigidos deben pasar su matriz antes de declarar satisfecha la meta.
Cada adaptador debe publicar versiones de motor/runtime soportadas y su nivel
de compatibilidad. Las pruebas SQLite o mocks no sustituyen integración real.

El primer hito útil es una aplicación externa instalada desde GitLab con un
proveedor remoto, consultas tipadas ejecutadas en servidor, almacenamiento S3 y
estructura propia. Después se aplica esa validación a toda la matriz, sin
anunciar soporte para adaptadores que todavía no se han comprobado.
