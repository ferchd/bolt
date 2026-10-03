# Contribuir a Bolt

GitLab (`https://gitlab.com/ferchd/bolt`) es el origen canónico del código,
las versiones y el Package Registry. GitHub (`https://github.com/ferchd/bolt`)
se destina a contribuciones y debe reflejar las ramas y tags canónicos.

Una contribución comienza con un PR de GitHub. Un mantenedor integra los cambios
en un MR de GitLab, conserva su autoría, ejecuta los checks y realiza el merge
en GitLab. Después se actualiza el mirror hacia GitHub. Los PR y comentarios no
se sincronizan mediante Git. No fusionar cambios independientemente en ambos
`main` ni ejecutar pipelines de contribuciones con credenciales de publicación.

La política anterior está preparada localmente. Aún falta sincronizar el código
con los remotos y habilitar el mirror en GitLab, en Settings → Repository →
Mirroring repositories, con dirección push hacia GitHub y una credencial del
mantenedor guardada en GitLab. Mantener una sola autoridad para ramas y tags;
no almacenar esa credencial en el repositorio ni en los proyectos generados.

## Desarrollo

Usar Bun 1.4.0 y el lockfile versionado:

```sh
bun install --frozen-lockfile --ignore-scripts
bun run check
bun run verify:packages
bun run release:check
```

Los paquetes de runtime se desarrollan en este repositorio. No añadir librerías
de terceros de runtime. Bun y las bibliotecas estándar proporcionan las APIs
base. Los drivers nativos de sistema, cuando un adaptador los requiera, deben
documentarse explícitamente. MongoDB y DynamoDB quedan fuera del alcance actual.

Toda funcionalidad debe incluir pruebas del comportamiento observable. Los
adaptadores deben distinguir pruebas unitarias de integración con servicios
reales y declarar sus requisitos. Nunca anunciar soporte basándose solo en la
compilación de tipos. Mantener los parámetros separados del SQL y evitar
registrar credenciales o valores sensibles.

Los commits y títulos de cambios siguen Conventional Commits, con cambios
atómicos. Marcar los cambios incompatibles y documentar su migración. No incluir
tokens, archivos de entorno, bases de datos locales ni artefactos temporales.

## Releases

Todos los paquetes Bolt usan una versión coherente y están preparados para el
endpoint de proyecto de GitLab, conservando el scope `@bolt`. Las versiones se
preparan junto con sus notas y los checks. La publicación se ejecuta como un job
manual tras los checks de un tag protegido `vMAJOR.MINOR.PATCH`; el script
rechaza proyectos, tags y versiones que no coincidan. No publicar Bolt en npmjs.org.

El proyecto GitLab es privado actualmente: instalar desde su registry requiere
acceso y autenticación. Las dependencias de desarrollo existentes siguen
resolviéndose desde su origen; la política anterior se refiere a los paquetes
Bolt y sus dependencias de runtime.
