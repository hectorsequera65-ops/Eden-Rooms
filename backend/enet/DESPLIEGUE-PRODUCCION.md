# Despliegue de Eden Rooms y ENet en producción

## Referencia histórica

El HTML público de producción coincidía con `76747b4` de `main` durante la revisión. El historial de GitHub mostró despachos de Cloudflare cada cinco minutos en esa revisión y la corrida 45356651805 completó `publish-preview`. En este equipo, el timer legado está inactivo y el servicio bajo demanda de Preview está activo. Ese servicio procesa su propia cola y no usa el endpoint programado. El informe de Preview del 22 de noviembre registró muestras válidas, salas sin versión y salas que rechazaron o no respondieron a ENet. Una consulta sin versión deja el campo vacío y una sala inaccesible no interrumpe la consulta de las demás.

## Destinos y migraciones

| Entorno | Host canónico de Pages | Base D1 | Binding ENet | Tabla de muestras |
| --- | --- | --- | --- | --- |
| Preview | `test-enet-versions-sralcer.eden-rooms.pages.dev` | `eden-rooms-test-db` | `ENET_PREVIEW_DB` | `enet_scheduled_snapshots` |
| Producción | `eden-rooms.pages.dev` | `eden-rooms-db` | `DB` | `enet_production_snapshots` |

- Consultar la configuración remota de Pages y el inventario D1. Registrar los UUID reales. Todos los bindings D1 de Production deben apuntar a `eden-rooms-db` y ambos bindings de Preview (`DB` y `ENET_PREVIEW_DB`) a `eden-rooms-test-db`. Si Preview difiere, detener el despliegue para resolverlo con el responsable del entorno.
- Revisar el esquema, el historial de migraciones y el marcador de rollback del chat mediante consultas de solo lectura. Aplicar el SQL aditivo `migrations/production/0001_enet_production.sql` únicamente a `eden-rooms-db` tras verificar el UUID y el despliegue de rollback. Las migraciones de nivel superior corresponden a Preview. Las rutas ENet de Preview rechazan un binding que exponga la tabla de control de producción `enet_scheduled_target`.
- Verificar que `enet_scheduled_target` contiene `production` y que `enet_production_snapshots` responde. Al reaplicar el SQL se conserva el turno reservado.

Las muestras existentes se conservan en la D1 de Preview. Producción empieza
con su tabla propia vacía y genera muestras nuevas con sus primeras consultas.
Se mantienen las tablas y filas legadas, incluso si existen tablas de muestras
anteriores en producción. La migración conserva el binding `DB` y es reaplicable.

Antes de migrar, con autorización, registrar por UUID los bindings, tablas,
índices, historial de migraciones y conteos de filas de ambas D1. Incluir chat,
autorizaciones, endpoints y tablas de versiones. Registrar referencias de
recuperación Time Travel y obtener exportaciones por separado en almacenamiento
privado autorizado. Validar su integridad y ensayar la recuperación en una base
descartable. Anotar las referencias, la hora UTC y los responsables fuera del
repositorio. Comparar el inventario tras migrar y explicar las variaciones por
actividad normal antes de activar. Para el rollback operativo conservar ambas
bases y sus escrituras posteriores al respaldo.

## Despliegue con autorización

1. Registrar en Pages el ID del despliegue de producción vigente y verificar que sea un destino de rollback válido. Registrar los bindings y las variables actuales de ambos entornos. Verificar que el Worker actual apunte a `main`, que use el mismo Durable Object de siempre, y que la cola de Actions no contenga ejecuciones antiguas con otro publicador. Mantener `EDEN_ENET_PRODUCTION_PUBLISH` apagada. [Rollback de Pages](https://developers.cloudflare.com/pages/configuration/rollbacks/)
2. Ensayar el candidato en un entorno aislado con fixtures y una D1 descartable. Los alias arbitrarios de Pages no habilitan los endpoints ENet. Para el ensayo de los hosts canónicos usar DNS/rutas locales; verificar también el Bridge instalado en una PS5 de prueba. Confirmar que el guardado vuelve al origen correcto, que las salas protegidas conservan su aviso y que funcionan Compartir, chat, favoritos y filtros en escritorio y móvil.
3. Verificar los bindings y preparar el esquema ENet en la D1 existente según los pasos anteriores. Usar una clave nueva y exclusiva en los entornos Production de Pages y `enet-production` de Actions. Restringir el entorno de Actions a `main`. Mantener el secreto de Preview en `enet-preview`. Con el publicador de producción apagado, integrar y desplegar el candidato en Pages. Comprobar chat, directorio y conexión PS5. Inspeccionar los endpoints sin credenciales y confirmar rechazo de publicaciones, y confirmar que ENet devuelve 404 mientras está apagado. Con el publicador de Actions todavía apagado, habilitar deliberadamente `ENET_PRODUCTION_ENABLED=true` en Pages y usar GET autenticado de `/api/versiones-programadas` para verificar el contrato `DB` sin publicar una muestra.
4. Mantener el Worker actual y sus despachos de cinco minutos con `ENET_CRON_PUBLISH=true`, `EDEN_ENET_CRON_SOURCE=cloudflare` y `EDEN_ENET_PREVIEW_PUBLISH=true`. Pages Preview y el filtro del artefacto usan `sralcer` por defecto. Si se personaliza `EDEN_ENET_NICKNAME` en Pages Preview, usar el mismo nombre en `EDEN_ENET_PREVIEW_EXCLUDED_NICKNAME` del entorno de Actions `enet-preview`. La publicación programada de producción debe terminar dentro de los cinco minutos del turno reservado y conserva la hora de la muestra ENet. Preview y los endpoints legados conservan su límite de 120 segundos.
5. Observar al menos tres turnos. Cada título `ENet Cloudflare slot …` debe aparecer una vez y ejecutar `publish-preview` y `publish-production`. Verificar los conteos de publicación y el incremento de `latest_slot`. Para una sala pública con versiones en ambas listas, comprobar que las dos D1 guardaron la misma hora de consulta y que el directorio muestra versiones recientes sin interacción. Verificar también que un error de POST en Preview deja pasar las observaciones elegibles a producción.

Con ambos destinos activos, `publish-preview` toma una muestra por sala pública
y usa su contrato habitual. El artefacto de un día incluye solo la identidad
pública de la sala, la hora y los campos de jugadores del endpoint público,
si existe una versión conocida tras excluir los apodos de consulta. Ambos jobs
usan Node.js 22 para aplicar el mismo filtro de versiones que el sitio. Los POST
de Preview se ejecutan junto con el muestreo de otras salas, por lo que su
latencia no bloquea las siguientes consultas ENet. Producción descarga el artefacto de esa corrida,
valida su lista de salas y reserva el turno de forma atómica en D1 antes de
publicar las muestras más antiguas primero con su propia clave. Un rechazo de reserva detiene todas sus escrituras
de muestras. Si se deshabilita deliberadamente `EDEN_ENET_PREVIEW_PUBLISH`,
producción usa el cliente ENet y reserva antes de muestrear. Un fallo en Preview
antes de producir el artefacto interrumpe la publicación de producción de ese turno. Actions
bloquea la publicación en los reintentos. El manual de Preview conserva el
turno vacío y publica solo en Preview.

La verificación local usa SQLite sintético, ENet en loopback y Chromium con
Bridge simulado. Verificar en una PS5 física durante el despliegue autorizado.

## Rollback

1. Si el problema es ENet, desactivar `ENET_PRODUCTION_ENABLED` en Pages y quitar `EDEN_ENET_PRODUCTION_PUBLISH`. Dejar que terminen las corridas activas y verificar que los turnos nuevos publican únicamente en Preview.
2. Antes de restaurar el sitio anterior, verificar la existencia del marcador `reset_conversations_2026_11_15` en `chat_migrations` de la base del chat. Si falta, usar un despliegue de rollback que incorpore la eliminación del borrado histórico antes de devolverle tráfico. El código anterior podía borrar mensajes al iniciar sin el marcador.
3. Si el problema es el sitio, recuperar el ID de Pages registrado en el paso 1 y seleccionar **Rollback to this deployment**. Verificar el directorio, chat, favoritos y el retorno desde Bridge con el HTML previo. Si también debe retirarse el cambio del repositorio, revertir el merge preservando `main` como primer padre, mediante el flujo habitual de revisión. [Rollback de Pages](https://developers.cloudflare.com/pages/configuration/rollbacks/)
4. Conservar las muestras de ambas D1 y el historial de turnos para una eventual reactivación.
