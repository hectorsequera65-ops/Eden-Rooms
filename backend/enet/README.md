# Eden Rooms: recolector Ubuntu y API de Pages

Cambios en la rama test/enet-versions-sralcer para revisión. No se ha desplegado ni configurado D1 ni se ha
modificado Docker eden-sala. El diseño y index.html permanecen intactos.

## Protocolo recuperado

Fuente: eden_maduro_jugadores.sh y eden_jugadores_ultimo.log proporcionados.
ENet usa un peer, un canal (0), connect data=0 y paquetes fiables.
Tras ENET_EVENT_TYPE_CONNECT se envía ID 1:

| Campo | Formato |
| --- | --- |
| ID | uint8 = 1 |
| Apodo | longitud uint32 BE + UTF-8 |
| IP virtual solicitada | FF FF FF FF (asignación automática) |
| network_version | uint32 BE = 1 |
| Contraseña | longitud uint32 BE + bytes (vacía en recolector) |
| Token de verificación | longitud uint32 BE = 0 |

El cliente original acepta ID 2 o 24 como ingreso confirmado. La captura muestra
el mensaje de confirmación, pero no imprime esos bytes: ID 24 solo está respaldado
por el código fuente. Rechazos: 8 nombre, 9 IP, 10 protocolo, 11 contraseña,
12 sala cerrada, 13 llena, 15 expulsión y 16 bloqueo.
El ID 4 original anuncia juego + uint64 BE Title ID + cadena de versión; se
eliminó del recolector para no anunciar Mario Kart ficticiamente.

### Paquete ID 3, variante comprobada

Todas las longitudes son bytes uint32 BE; cadenas UTF-8; enteros big-endian.
Cabecera: ID uint8, nombre de sala, descripción, uint32 (interpretado como
capacidad), uint16 (interpretado como puerto), juego preferido, nombre del
propietario y cantidad uint32 de jugadores. Los significados de capacidad,
puerto y propietario se infieren de la captura; no se usan para asociar salas.
Cada jugador contiene apodo, IPv4 virtual (4 bytes), juego, Title ID uint64,
versión y tres cadenas con longitud: usuario, nombre visible y URL de avatar.
Las cadenas vacías ocupan doce ceros; no son un bloque fijo de doce bytes.

El parser consume la cabecera y exactamente la cantidad declarada, exige final
exacto del paquete y no busca cadenas en offsets arbitrarios. Conserva jugadores
sin juego o versión y todos los apodos duplicados. Rechaza truncamientos, IPs
virtuales duplicadas y longitudes de metadatos inválidas. Los metadatos se
consumen por longitud, incluso si no están vacíos o no son UTF-8. La cabecera
se consume como bytes delimitados y sus etiquetas se escapan solo al mostrarlas;
los campos binarios nunca se convierten en texto. Ver PROTOCOL.md.

Los cuatro paquetes originales se decodificaron completamente: 11 jugadores,
ocho versiones 1.4.0, una 1.0.0 y dos versiones vacías. Solo cambia el juego
anunciado por el cliente de prueba. El fixture de pruebas deriva del paquete de
1023 bytes y sustituye los nombres y la descripción por texto anónimo de igual
longitud; no incluye el dominio/IP real de la sala.

### Identidad y asociación

La IPv4 identifica al miembro dentro de la instantánea; no hay evidencia de
identidad permanente ni de que sobreviva a una reconexión. Title ID identifica
el juego y se conserva como 16 caracteres hexadecimales para evitar pérdida de
precisión en JavaScript.

La API conserva title_id y virtual_ip en jugadores_json. /api/rooms combina solo
salas autorizadas por endpoint registrado IP:puerto y snapshots de hasta 120 s.
Asigna gameVersion por apodo e IP virtual cuando están disponibles y el juego
coincide exactamente. Sin IP común exige apodos únicos en ambas listas; los
homónimos ambiguos se omiten.
Cuando el lobby contiene gameId, exige igualdad con title_id y rechaza números
que JavaScript no representa exactamente. gameTitleId conserva el título en el
JSON enriquecido; la IP virtual no se añade al JSON del lobby.

No se infiere identidad por orden. Sin ID común de sesión, una reconexión con el
mismo apodo/juego dentro del periodo de vigencia aún puede reutilizar una muestra
anterior. No hay garantía de identidad entre sesiones con los datos disponibles.
La API conserva versiones explícitas del lobby y el listado funciona si falla D1.

## Ubuntu: preparación manual posterior a la revisión

Dependencias: build-essential, libenet-dev y python3. Compilar:

```sh
cc -O2 -Wall -Wextra -Werror backend/enet/client.c -lenet -o eden-collector
python3 backend/enet/read_packet3.py /ruta/eden_jugadores_ultimo.log
```

El recolector consulta /api/autorizaciones, conecta secuencialmente a endpoints
registrados y recibe snapshots. Usa solo sralcer y no envía juego ni
chat. Cada conexión ocupa una plaza y es visible brevemente en el lobby. No es
un mecanismo pasivo. Salas llenas, con contraseña, token obligatorio o rechazo del
apodo no se pueden consultar con este recolector sin ampliar su configuración.
No se intenta renombrar automáticamente ni adivinar contraseñas.

Para probar tras la revisión, imprime snapshots sin escribir a Pages:

```sh
python3 backend/enet/collector.py --base-url https://PROJECT.pages.dev --client ./eden-collector --once
```

Ese comando sí conecta a las salas autorizadas. No se ejecutó contra salas reales.
El envío requiere --send y VERSIONES_API_KEY privada. Los POST usan HTTPS,
Content-Type application/json y X-API-Key en /api/versiones-multiples. El JSON
incluye sala_id, consultado_en UTC y jugadores con nombre, juego, version,
title_id y virtual_ip. Cada paquete reemplaza la lista; no se acumula por apodo.
Solo se envía una lista vacía al decodificar un snapshot vacío válido. Fallos de
red o parseo dejan vencer el registro anterior; no generan listas vacías.

La propuesta de systemd usa ahora una unidad oneshot y un temporizador, ambos
SIN INSTALAR ni ACTIVAR. La URL queda fijada al Preview; requiere el archivo
/etc/eden-rooms-enet-preview.env y EDEN_ROOM_ID explícito. Consulta una sola sala
durante 15 s y espera 30 s desde el fin antes del próximo intento. No habilitar
el servicio o temporizador en esta etapa. Ver PREVIEW_VERSIONS.md.

SnapshotPublisher omite POST duplicados dentro de una ejecución, publica cambios
inmediatamente y renueva datos sin cambios cada 60 s en modo continuo. Cada nueva
ejecución oneshot publica su primera muestra válida, necesaria para renovar D1.
El temporizador impide solapar ejecuciones de su propia unidad. No ejecutar a la
vez el modo continuo y el temporizador sobre la misma sala.

## Pages / D1

Se reutilizan DB y VERSIONES_API_KEY y las tablas salas_autorizadas,
salas_endpoints y versiones_salas. No hay una nueva columna ni migración:
los nuevos campos se almacenan en jugadores_json. El upsert evita que un
snapshot anterior sobrescriba uno más nuevo (timestamps ISO UTC normalizados).
Falta comprobar el esquema D1 y los bindings reales antes de desplegar.

## Verificación

```sh
python3 -m unittest discover -s tests -p 'test_*.py'
node --test tests/*.test.mjs
wrangler pages functions build functions --outdir work/pages-build
```

La prueba ENet opcional usa exclusivamente loopback: compilar tests/enet_mock.c
con libenet y definir EDEN_TEST_CLIENT y EDEN_TEST_SERVER con las rutas absolutas
a los dos ejecutables. Valida bytes exactos de handshake, recepción de ID 3 y
que no se envíen anuncios de juego. Sin esas variables se omite esa prueba.

Se compiló y probó en Linux Debian con ENet 1.3.18; no se ejecutó en una máquina
Ubuntu real. No se hicieron conexiones a las salas públicas ni POST remotos.
La estructura de los tres campos de cuenta se contrastó con una implementación
pública del protocolo. Sigue siendo útil una captura real de la sala Smash
reportada para confirmar el campo exacto que causó el error; los nuevos tests
Smash/Mario Kart son sintéticos, además del fixture real anonimizado existente.

## Nombre configurable

El nombre predeterminado es `sralcer`. Cambiar `EDEN_ENET_NICKNAME` en el
archivo de entorno del servicio (1–24 letras ASCII, números, `_` o `-`). El
cliente C también lee esa variable. El recolector acepta `--nickname` con
prioridad sobre la variable y transmite ese mismo nombre al cliente C; excluye
ese apodo del snapshot antes de enviarlo.

Si se cambia, configurar también `EDEN_ENET_NICKNAME` con el mismo valor en
Cloudflare Pages para mantener el filtro adicional de ambas APIs de recepción.
Sin configurar esa variable, las APIs excluyen `sralcer`. Un jugador real con el
mismo apodo también se excluiría; el protocolo puede rechazar nombres ocupados.
No se cambió ninguna variable remota ni se reinició el servicio.

## Error HTTP 403 / Cloudflare 1010 en Ubuntu

Consultar [CLOUDFLARE_ACCESS.md](CLOUDFLARE_ACCESS.md) para el diagnóstico de BIC
en Pages, la clave de lectura opcional y el plan de revisión de reglas. El
cliente ahora se identifica como EdenRoomsCollector y ofrece --check-api para
probar solo la API, sin ENet ni escrituras.

## Antes de activar --send

Seguir [D1_PREFLIGHT.md](D1_PREFLIGHT.md): auditoría SQL de solo lectura, revisión
de bindings y validación autenticada mediante la nueva ruta versiones-validar.
--validate-send y --room-id están incluidos en esta rama; requieren la futura
publicación revisada de esa ruta y no se han activado en producción.

## Métodos de validación y estado de publicación

Ver [ENDPOINTS.md](ENDPOINTS.md). d1601d3 no contiene versiones-validar: los
cambios posteriores están incluidos en esta rama, pendientes de despliegue Pages. GET valida exclusivamente la clave mediante
--check-auth; POST valida snapshots mediante --validate-send, sin guardarlos.
Un HTTP 200 con index.html no confirma que exista ninguna de esas Functions.

## Versiones en la interfaz Preview

[PREVIEW_VERSIONS.md](PREVIEW_VERSIONS.md) describe asociación por sala/nombre/IP,
consulta de versiones-sala, caché de 30 s, caducidad de 120 s y verificaciones
de escritorio/móvil. No se ha activado ningún servicio automático de Ubuntu.

## Consultas bajo demanda (etapa actual)

La propuesta actual reemplaza el sondeo periódico de salas por trabajos de
Preview, creados al abrir una tarjeta. Ver [ON_DEMAND.md](ON_DEMAND.md) para la
migración de eden-rooms-test-db, la configuración y comandos de instalación
sin activar el servicio. El worker reutiliza collector.py y client.c; no expone
un servidor en Ubuntu. Cada apertura envía un único POST, sin renovación automática mientras siga
abierta. El TTL de 120 s sigue aplicándose en D1/API; una tarjeta abierta conserva su
copia de jugadores y versiones con la hora original, sin vencimiento visual. Cerrar/reabrir permite
una consulta nueva. Se consulta estado cada 2 s únicamente mientras se espera
un trabajo. El timer anterior queda
como referencia y no debe ejecutarse junto al nuevo servicio.

## Una solicitud por apertura

La web inicia trabajos únicamente desde el evento de abrir la tarjeta. Los
refrescos del lobby, el vencimiento de los 120 s y volver a la pestaña no
encolan trabajo. Cloudflare comparte trabajos activos, pero ya no usa una
muestra reciente para omitir el POST de una nueva apertura. El servicio Ubuntu
ondemand sigue compatible y sin cambios; no requiere reinstalación ni migración.
