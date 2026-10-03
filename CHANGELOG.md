# Changelog

Todos los cambios relevantes de Bolt se documentarán en este archivo.

El formato está basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/)
y el proyecto sigue [Versionado Semántico](https://semver.org/lang/es/).

## [Sin publicar]

### Añadido

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

- El repositorio ahora utiliza Bun Workspaces para organizar paquetes y
  ejemplos.
- La instalación de dependencias usa enlaces aislados y el almacén global de
  Bun.
- La configuración compartida de TypeScript incluye explícitamente el código y
  las pruebas de todos los workspaces.

### Infraestructura inicial

- Se configuró Bun 1.4.0 como runtime y gestor de paquetes.
- Se configuró TypeScript 7 con comprobaciones estrictas e incrementales.
- Se añadió un lockfile reproducible y configuración común de desarrollo.
