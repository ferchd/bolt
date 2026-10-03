# Changelog

Todos los cambios relevantes de Bolt se documentarán en este archivo.

El formato está basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/)
y el proyecto sigue [Versionado Semántico](https://semver.org/lang/es/).

## [Sin publicar]

### Añadido

- Se incorporó `@bolt/kernel` como primer paquete del framework.
- Se incorporó `@bolt/router` con una API declarativa inspirada en AdonisJS.
- Se añadieron rutas para los métodos HTTP comunes y handlers inline o basados
  en controladores.
- Se añadieron grupos anidados con prefijos, nombres y middleware compartido.
- Se añadió la compilación de definiciones en una tabla por path y método para
  futuros adaptadores de servidor.
- Se añadió detección temprana de paths y nombres de ruta duplicados.
- Se añadió `BoltApplication.create()` para construir aplicaciones Bolt.
- Se implementó el ciclo de vida mínimo mediante `start()`, `stop()` e
  `isRunning`, sin acoplar el kernel a un servidor o transporte.
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
