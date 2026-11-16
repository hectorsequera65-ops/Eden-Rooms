# Versiones por jugador en Preview

La etapa actual es bajo demanda: ver [ON_DEMAND.md](ON_DEMAND.md). Este documento
describe la integración visual original; el caché ahora dura 120 s y el polling
de 2 s solo sigue trabajos pendientes. No activar el temporizador periódico antiguo.

Entorno exclusivo: test/enet-versions-sralcer. Los fetch de la página son relativos
al origen actual; al abrir el Preview usan su DB=eden-rooms-test-db y nunca
redirigen a producción. No se cambian tablas, bindings, secretos ni configuraciones
de producción. No se modifica eden-sala ni se activa ninguna unidad de Ubuntu.

## Asociación y visualización

/api/rooms lee el registro de salas autorizadas y endpoints en D1 y agrega
versionsRoomId cuando la dirección y el puerto coinciden con una única sala
registrada. El nombre visible no se usa como identificador. La UI no necesita
acceder a /api/autorizaciones ni conocer claves privadas.

Al abrir la tarjeta de una sala registrada con jugadores, la página consulta
/api/versiones-sala?id=versionsRoomId en su propio origen. La respuesta incluye
sala_id, consultado_en, expira_en, endpoint y jugadores. La interfaz exige ID
coincidente y, si hay endpoint en la respuesta, comprueba dirección y puerto.

Jugadores: nombre + IP virtual cuando están disponibles. Se reconocen virtual_ip,
fakeIp, fake_ip y virtualIp, tanto IPv4 textual como array de cuatro octetos.
Si no hay IP común, solo se usa un apodo único en ambas listas. IPs contradictorias,
IPs inválidas, identidades duplicadas, otro juego o un Title ID incompatible no
reciben versiones. Dos jugadores con el mismo apodo sí pueden distinguirse si
ambos extremos tienen sus IPs y la pareja nombre/IP es única.

El backend conserva enteros JSON de 64 bits como cadenas exactas antes de que
JSON.parse los redondee. Esto permite comparar gameId con el Title ID hexadecimal
sin inventar coincidencias. La UI mantiene clases, disposición y estilo existentes:
nombre, juego y «Versión X». Sin una versión vigente muestra nombre y juego,
sin marcadores vacíos ni una versión inferida del juego preferido de la sala.
Todos los textos se escapan antes de insertarse en el HTML.

## Frecuencia y caducidad

- Las salas cerradas/no registradas/vacías no originan solicitudes de versiones.
- Solo se consulta la tarjeta abierta; se reutiliza su respuesta durante 30 s.
  Abrir/cerrar la tarjeta o refrescar el lobby no duplica una petición en curso.
- El lobby conserva su refresco de 10 s. Las versiones se revisan cada 15 s pero
  la caché limita las peticiones normales a una cada 30 s por sala abierta.
- Cuando la pestaña está oculta se suspenden los refrescos de lobby/versiones y
  se cancelan solicitudes de versiones pendientes. Al volver se revisa la caducidad.
- La antigüedad se calcula desde consultado_en, no desde la descarga. A los 120 s
  se retira la versión mediante un temporizador propio, aunque falle la red o el
  lobby. Una respuesta no renueva artificialmente la fecha de la muestra.
- La API y el matcher comparten el límite de 120 s. Las versiones ENet del lobby
  llevan fecha/origen; el navegador no permite que esos campos eludan la consulta
  de versiones-sala ni vuelvan a aparecer después de vencer.
- Conservar versiones explícitas nativas del lobby no equivale a conservar una
  muestra ENet vencida: esos campos se distinguen por su origen.

Las consultas HTTP de la web NO abren ENet. Solo el recolector independiente
consulta salas y publica muestras. No se guarda estado de jugadores en localStorage.

## Recolector automático: propuesta, no activada

Se actualizaron eden-rooms-enet.service y el nuevo eden-rooms-enet.timer:
URL fija https://test-enet-versions-sralcer.eden-rooms.pages.dev, una sala indicada
por EDEN_ROOM_ID, --send --once --duration 15. La unidad requiere un ID no vacío;
si falta, no consulta todas las salas por accidente. El archivo de entorno propuesto
es /etc/eden-rooms-enet-preview.env, con secretos exclusivos de Preview, nunca los
secretos de producción. EnvironmentFile de systemd no reemplaza variables del shell.

El temporizador espera 30 s después de finalizar cada intento, sin solapar su
propia unidad. Un ciclo habitual dura unos 46–60 s incluyendo conexión/HTTP: deja
margen antes de los 120 s. No es una garantía bajo caídas de red o carga extrema;
si faltan muestras, la web muestra solo el juego al vencer las anteriores.

SnapshotPublisher compara el contenido completo de jugadores sin considerar orden
ni fecha de consulta: envía cambios de inmediato, omite duplicados y mantiene un
heartbeat de 60 s en ejecuciones continuas. Un POST fallido no se considera publicado.
En cada nueva ejecución oneshot se envía la primera muestra válida para renovar D1.
Una sala confirmada vacía se publica vacía; un error/timeout no se convierte en vacío.

NO se instaló, habilitó, inició ni reinició ningún servicio/temporizador. No se
incluyen comandos de activación en esta etapa. No ejecutar simultáneamente otra
copia continua del recolector sobre la misma sala cuando se active más adelante.

## Cómo verificar el Preview tras el push

1. Esperar el deployment Preview del nuevo commit, sin promoverlo a producción.
   Confirmar que su binding DB sigue siendo eden-rooms-test-db. No hace falta
   migración: se reutilizan las tres tablas existentes y jugadores_json.
2. Abrir https://test-enet-versions-sralcer.eden-rooms.pages.dev/api/rooms y buscar
   el endpoint registrado para sala-prueba-20668. Debe llevar
   versionsRoomId="sala-prueba-20668". Si no aparece, comprobar IP/dominio y puerto
   en salas_endpoints y que no haya duplicados. No basta el nombre de la sala.
   La sala debe seguir publicada en el lobby: no se crean tarjetas de salas
   desconectadas a partir de una captura almacenada.
3. Revisar https://test-enet-versions-sralcer.eden-rooms.pages.dev/api/versiones-sala?id=sala-prueba-20668
   y confirmar disponible=true y consultado_en reciente. Si el recolector se detuvo
   hace más de 120 s, disponible=false es correcto y la página no debe inventar datos.
4. Si hace falta renovar manualmente la muestra, con el binario actual, la clave
   de Preview en el entorno y sin activar ningún servicio:

```sh
python3 backend/enet/collector.py \
  --base-url https://test-enet-versions-sralcer.eden-rooms.pages.dev \
  --client ./work/eden-collector --room-id sala-prueba-20668 \
  --send --once --duration 15
```

   Ese comando sí consulta temporalmente la sala y escribe SOLO en el D1 del
   Preview; ejecutarlo únicamente si se quiere renovar la muestra de prueba.
5. Abrir https://test-enet-versions-sralcer.eden-rooms.pages.dev/ y desplegar la
   tarjeta de la sala. Usar «Ver los N jugadores» si hay más de cuatro. Cada versión
   debe coincidir con el registro de su jugador; quien no tenga versión conserva
   únicamente el juego junto a su nombre. El diseño de la tarjeta no cambia.
6. En Network del navegador comprobar la petición versiones-sala y su ID. Reabrir
   la misma tarjeta dentro de 30 s reutiliza la caché. Al detener el recolector y
   esperar hasta consultado_en + 120 s, las versiones deben desaparecer.
7. Confirmar que otra sala con el mismo apodo no hereda versiones y que en móvil
   no hay desbordamiento horizontal. Ninguna clave debe estar en solicitudes del
   navegador a versiones-sala.

## Pruebas

Node: matcher, IPs, apodos duplicados, Title IDs exactos, XSS, caché/deduplicación,
fallos de red, caducidad límite, SQL real para POST -> D1 -> lectura de rooms.
Python: parser binario, publisher, supresión de duplicados, heartbeat, cambio de
jugadores y reintento tras un POST fallido. ENet de integración solo en loopback.
Chromium: página real de escritorio y móvil con API fixtures locales; apertura de
sala, versiones, jugador sin versión, duplicados por IP, caché y retirada a 120 s.
No hacen escrituras en D1 remoto ni consultas a salas públicas.

```sh
node --test tests/*.test.mjs
python3 -m unittest discover -s tests -p 'test_*.py'
```

La prueba Chromium es opcional si no se indica EDEN_PLAYWRIGHT_MODULE con una
instalación de @playwright/test. Usa Chromium local (/usr/bin/chromium o la ruta
EDEN_CHROMIUM). La prueba ENet requiere EDEN_TEST_CLIENT y EDEN_TEST_SERVER para
sus dos binarios locales, como se explica en README.md.

La consulta directa al Preview desde este entorno de desarrollo quedó bloqueada
por el proxy (Tunnel connection failed: 403 Forbidden); las comprobaciones de UI
se hicieron localmente. La operación de D1 remoto se basa en la confirmación del
usuario y debe comprobarse en el Preview tras su despliegue automático.
