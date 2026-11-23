# Cron de ENet versions en Cloudflare Workers

El Worker `eden-rooms-enet-cron` despacha el workflow existente `enet-versions.yml`
cada cinco minutos UTC. GitHub aloja el runner `ubuntu-24.04` que compila y ejecuta
las pruebas y, al habilitar la publicación, ejecuta el recolector de Preview con
la rotación existente de 12 nombres. Cloudflare y GitHub ejecutan todo aunque la
laptop esté apagada. El Worker solo contacta a GitHub y utiliza almacenamiento
SQLite propio de un Durable Object para reservar el turno.

## Costos y límites

- **Cloudflare Workers Free** estima 288 invocaciones diarias y 8.640 en 30 días.
  Usa uno de los cinco Cron Triggers por cuenta. El plan documenta 100.000
  solicitudes diarias y 10 ms de CPU por ejecución programada. La espera de
  red no consume CPU. Confirmar que quede un trigger disponible y medir la
  CPU real durante la prueba. Los cambios de cron pueden tardar hasta 15 minutos
  en propagarse. [Límites](https://developers.cloudflare.com/workers/platform/limits/)
  · [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
- **Durable Objects Free** estima 288 solicitudes internas al día y, para turnos
  nuevos, una lectura y una escritura por turno sobre una sola clave. La cuota
  diaria es de 100.000 solicitudes, 13.000 GB-s, 5 millones de filas leídas y
  100.000 escritas. El límite total de almacenamiento SQLite del plan Free es
  de 5 GB. Las cuotas son compartidas en la cuenta.
  [Precios de Durable Objects](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- **GitHub Actions** cuesta USD 0 en el repositorio público con runners estándar.
  Si pasara a privado, 8.640 turnos en 30 días superarían los 2.000 minutos de
  GitHub Free incluso con un solo job por turno, al redondear cada job hacia el
  siguiente minuto. El flujo que publica usa dos jobs y un artefacto de un día.
  [Facturación](https://docs.github.com/en/actions/concepts/billing-and-usage)
  · [Redondeo y tarifas](https://docs.github.com/en/billing/reference/actions-runner-pricing)

## Credenciales y duplicados

Crear un PAT fine-grained nuevo, con vencimiento, limitado a
`hectorsequera65-ops/Eden-Rooms` y permiso de repositorio **Actions: Read and
write**. GitHub otorga ese permiso a nivel de repositorio, por lo que el token
puede operar sobre otros workflows de ese mismo repositorio. Guardarlo solo en
el nuevo Worker como `ENET_GITHUB_DISPATCH_TOKEN`. El Worker no tiene rutas HTTP
públicas, rechaza redirecciones y registra el turno y el estado HTTP sin
registrar el token ni el cuerpo de la respuesta. El workflow conserva su
`GITHUB_TOKEN` de solo lectura y usa el secreto de Preview existente solo en
el job de publicación. [Permisos del dispatch](https://docs.github.com/en/rest/actions/workflows?apiVersion=2026-03-10#create-a-workflow-dispatch-event)

El Durable Object serializa los intentos y confirma la reserva en SQLite antes
del POST. Cada turno válido se intenta como máximo una vez en este Worker.
La marca de tiempo de Cloudflare se redondea hacia abajo al inicio del turno
UTC de cinco minutos. Se descartan marcas inválidas y turnos iguales o
anteriores al último reservado. La demora de ejecución no invalida un turno
por sí sola. Ante un HTTP fallido o un timeout, el
turno se pierde si GitHub no llegó a aceptarlo. El siguiente turno sigue su
curso. Un HTTP 200 o 204 solo confirma el despacho. GitHub puede demorar la
ejecución y la concurrencia de publicación puede reemplazar un job pendiente
por uno más reciente si hay acumulación. El workflow bloquea los reintentos
manuales de corridas iniciadas por el Worker y conserva el grupo que serializa
las publicaciones de Preview.
[Concurrencia de GitHub Actions](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#concurrency)

## Prueba en la nube con autorización

Durante la prueba en la rama de integración, el cron de GitHub sigue
habilitado en `main`. GitHub requiere que el workflow exista en la rama
por defecto para poder despacharlo sobre una rama de prueba. Confirmar en la primera corrida autorizada que el despacho
use los inputs definidos en la rama de integración. [Eventos de GitHub Actions](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_dispatch)

Un despacho manual de la rama de integración ejecuta `versions` y omite
`publish-preview`, aunque se seleccione `publish: true` sin turno. Para
verificar una publicación, revisar la conclusión del job `publish-preview`
y su línea `Published: N/M`. Comparar `actualizado_en` en
`enet_scheduled_snapshots` de `eden-rooms-test-db` con `consultado_en` en
`/api/versiones-publicadas?id=ID_DE_SALA` para una sala pública con versiones.

Desde la raíz, publicar la rama cuando corresponda. Usar Node 22 o superior y
la cuenta de Cloudflare autorizada. El Worker de prueba existente ya tiene
el cron de cinco minutos y el secreto de despacho. Para actualizarlo con
autorización, conservar el nombre, el Durable Object y el secreto, y usar
la configuración de Wrangler con la rama de prueba y `publish: false`.
Usar un commit con el prefijo `[CF-Pages-Skip]` para omitir el despliegue
automático de Pages. Para actualizar el Worker existente, usar `--keep-vars`
y omitir `--secrets-file`. Indicar explícitamente la rama y el modo de
publicación, y verificar ambos valores en la versión activa con
`wrangler versions view`.

```bash
git push -u origin integration/enet-cloudflare-preview
npx --yes wrangler@4.166.0 deploy --config backend/enet/cron/wrangler.toml \
  --keep-vars --var ENET_CRON_REF:integration/enet-cloudflare-preview ENET_CRON_PUBLISH:false
```

```bash
npx --yes wrangler@4.166.0 tail --config backend/enet/cron/wrangler.toml
# En otra terminal
gh run list -R hectorsequera65-ops/Eden-Rooms -w enet-versions.yml \
  -b integration/enet-cloudflare-preview -e workflow_dispatch -L 10
gh run view RUN_ID -R hectorsequera65-ops/Eden-Rooms
```

Dejar transcurrir al menos tres turnos después de la propagación. Confirmar un
despacho exitoso por turno, el job `versions` exitoso y `publish-preview`
omitido. Correlacionar por el turno del título de la corrida y del log del
Worker. Confirmar métricas y eventos de CPU en Cloudflare. Si falla, mantener
`ENET_CRON_PUBLISH=false` y corregir antes de avanzar.

## Activación con autorización

El workflow actualizado elimina el evento `schedule` de GitHub. El Worker
es el único disparador periódico. Los PR y los despachos manuales siguen
disponibles. La publicación requiere un despacho con `publish: true` desde
`main`, la variable `EDEN_ENET_PREVIEW_PUBLISH=true` y el artefacto de la
compilación probada. Los despachos con turno requieren además
`EDEN_ENET_CRON_SOURCE=cloudflare` y el primer intento de la corrida.

1. Completar la prueba de tres turnos con `ENET_CRON_PUBLISH=false`. Verificar
   la versión activa del Worker y el entorno `enet-preview`. Restringir ese
   entorno a la rama exacta `main` y conservar el secreto de Preview existente.
   Confirmar que el alias de Pages corresponda a Preview, que su binding
   `ENET_PREVIEW_DB` tenga el ID de `eden-rooms-test-db` y que producción
   carezca de ese binding y de ese ID.
2. Incorporar el workflow actualizado a `main` con autorización posterior.
   Usar el prefijo `[CF-Pages-Skip]` en el mensaje del commit que llegue a
   `main` para omitir el despliegue automático de Pages. Comprobar que el
   workflow remoto carezca de `schedule` y esperar a que terminen los jobs
   programados que ya estuvieran activos o en cola. Habrá una pausa de
   publicación automática entre la incorporación y la activación del Worker.
   [Omisión del despliegue de Pages](https://developers.cloudflare.com/pages/configuration/git-integration/github-integration/#skipping-a-build-via-a-commit-message)
3. Apuntar el Worker a `main` manteniendo `ENET_CRON_PUBLISH=false`. Verificar
   un turno exitoso de pruebas en `main` con `publish-preview` omitido.
4. Tras esas comprobaciones y con autorización para activar la publicación,
   fijar `EDEN_ENET_CRON_SOURCE=cloudflare` en GitHub, conservar
   `EDEN_ENET_PREVIEW_PUBLISH=true` y actualizar únicamente el Worker con
   `ENET_CRON_REF=main` y `ENET_CRON_PUBLISH=true`. Mantener `--keep-vars`
   y usar el secreto ya instalado. Para pausar la publicación automática,
   cambiar `EDEN_ENET_CRON_SOURCE` a un valor vacío o devolver el Worker a
   `ENET_CRON_PUBLISH=false`. Un job en curso puede terminar.

## Comprobación con la laptop apagada

Después de la propagación, anotar la hora UTC y el `consultado_en` de una
sala pública con versiones. Apagar la laptop durante al menos tres turnos.
Desde otro equipo o al volver, consultar el historial de GitHub Actions.
Buscar una corrida `workflow_dispatch` titulada `ENet Cloudflare slot …`
por cada turno transcurrido, iniciada después de la hora anotada. Verificar
que `publish-preview` terminó con éxito y que `Published: N/M` muestra
`N > 0`. Confirmar que durante ese intervalo no hubo corridas `schedule` y
que un `actualizado_en` nuevo de `eden-rooms-test-db` coincide con
`consultado_en` de la misma sala en el endpoint de Preview. Si la rotación
no consultó la sala inicial, usar una sala publicada en esos turnos. El cron
programa cada cinco minutos y la cola de GitHub puede demorar el inicio.
