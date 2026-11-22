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
  100.000 escritas. Las cuotas son compartidas en la cuenta.
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
Se descartan turnos viejos o repetidos. Ante un HTTP fallido o un timeout, el
turno se pierde si GitHub no llegó a aceptarlo. El siguiente turno sigue su
curso. Un HTTP 200 o 204 solo confirma el despacho. GitHub puede demorar la
ejecución y la concurrencia de publicación puede reemplazar un job pendiente
por uno más reciente si hay acumulación. El workflow bloquea los reintentos
manuales de corridas iniciadas por el Worker y conserva el grupo que serializa
las publicaciones de Preview.
[Concurrencia de GitHub Actions](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#concurrency)

## Prueba en la nube con autorización

El cron de GitHub sigue habilitado durante esta prueba. El workflow ya existe
en la rama por defecto, requisito de GitHub para poder despacharlo sobre una
rama de prueba. [Eventos de GitHub Actions](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_dispatch)

Desde la raíz, publicar la rama cuando corresponda. Usar Node 22 o superior y
una cuenta de Cloudflare autorizada con un cupo de cron libre. Verificar en el
panel que el nombre del Worker sea nuevo. El primer despliegue usa por defecto
la rama de prueba y `publish: false`.

```bash
git push -u origin feat/enet-cloudflare-cron
npx --yes wrangler@4.166.0 login
(
  set -e
  umask 077
  enet_secret_file=$(mktemp)
  trap 'rm -f "$enet_secret_file"' EXIT
  read -rsp 'PAT fine-grained nuevo de GitHub: ' enet_dispatch_pat
  printf '\n'
  printf 'ENET_GITHUB_DISPATCH_TOKEN=%s\n' "$enet_dispatch_pat" > "$enet_secret_file"
  unset enet_dispatch_pat
  npx --yes wrangler@4.166.0 deploy --config backend/enet/cron/wrangler.toml \
    --secrets-file "$enet_secret_file"
)
```

```bash
npx --yes wrangler@4.166.0 tail --config backend/enet/cron/wrangler.toml
# En otra terminal
gh run list -R hectorsequera65-ops/Eden-Rooms -w enet-versions.yml \
  -b feat/enet-cloudflare-cron -e workflow_dispatch -L 10
gh run view RUN_ID -R hectorsequera65-ops/Eden-Rooms
```

Dejar transcurrir al menos tres turnos después de la propagación. Confirmar un
despacho exitoso por turno, el job `versions` exitoso y `publish-preview`
omitido. Correlacionar por el turno del título de la corrida y del log del
Worker. Confirmar métricas y eventos de CPU en Cloudflare. Si falla, mantener
el cron de GitHub y corregir antes de avanzar.

## Cambio de origen con autorización

Después de la prueba y de una fusión autorizada, verificar en el `main` remoto
que esté el workflow actualizado, que `EDEN_ENET_PREVIEW_PUBLISH` siga habilitada
y que la publicación de Preview del workflow funcione. Desplegar el mismo Worker
para `main` con publicación y comprobar por el título que aparece un nuevo
turno de Cloudflare. Hasta el cambio de selector ese turno se omite y el cron
existente sigue siendo el publicador automático. Entre turnos y con el job de
publicación anterior finalizado, cambiar el selector y comprobar que el próximo
turno de Cloudflare complete `publish-preview` y actualice Preview.

```bash
npx --yes wrangler@4.166.0 deploy --config backend/enet/cron/wrangler.toml \
  --var ENET_CRON_REF:main ENET_CRON_PUBLISH:true
gh run list -R hectorsequera65-ops/Eden-Rooms -w enet-versions.yml \
  -b main -e workflow_dispatch -L 10
gh variable set EDEN_ENET_CRON_SOURCE --body cloudflare -R hectorsequera65-ops/Eden-Rooms
gh run watch RUN_ID --exit-status -R hectorsequera65-ops/Eden-Rooms
```

Si la publicación falla o la cadencia no es aceptable, restaurar el origen
nativo con el siguiente comando. El job en curso puede terminar. La declaración
`schedule` sigue en el workflow como respaldo. Retirar el trigger del Worker
desde el panel de Cloudflare si se abandona la prueba y considerar el tiempo de
propagación.

```bash
gh variable set EDEN_ENET_CRON_SOURCE --body github -R hectorsequera65-ops/Eden-Rooms
```
