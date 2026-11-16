# Consultas ENet bajo demanda — Preview

Código exclusivamente en test/enet-versions-sralcer. El desarrollo no instala ni
activa servicios, no ejecuta migraciones remotas y no modifica main, eden-sala,
la configuración de producción ni eden-rooms-db. Los pasos siguientes son para
que el propietario revise y pruebe únicamente Preview y eden-rooms-test-db.

## Recorrido

1. Abrir o reabrir una tarjeta NO crea trabajo ENet. El listado de jugadores
   procede de /api/rooms y se actualiza cada 10 s, como antes de las versiones.
2. Solo «↻ Consultar versiones», junto a «Ver descripción», envía un POST
   /api/versiones-consultar con sala_id. Se deshabilita durante la espera.
3. Cloudflare valida sala/endpoint y comparte el trabajo activo, respetando cuotas.
4. El worker Ubuntu consulta temporalmente como sralcer; no cambia su servicio.
5. La página sigue el estado por GET cada 2 s únicamente mientras espera y lee
   versiones-sala una vez al terminar. No hay renovación automática.
6. La lista actual sigue siendo la del directorio. Las versiones se asocian por
   nombre e IP virtual únicos, juego y Title ID cuando existe. No se sustituye
   el listado por la captura ENet. Sin identidad segura: «Versión sin consultar».
7. Las versiones conocidas no vencen visualmente y muestran su hora original.
   Una salida, cambio de identidad/juego o ambigüedad detectada invalida la
   asociación hasta la siguiente consulta manual. Los históricos de D1 no se borran.
8. Cerrar/reabrir conserva resultados conocidos sin generar POST. Se puede
   consultar otra vez con el enlace, incluso tras error; se mantienen los límites.

Limitación: el directorio se observa cada 10 s (API con caché de 5 s), no es un
registro de sesiones. Una salida y reentrada entre muestras con idéntico nombre,
IP virtual y juego no es distinguible. No se inventan identificadores de sesión.
Si el directorio omite players/nombres no hay otra fuente automática disponible:
no se rellena la lista con una captura ENet antigua. Sin IP compartida no se
atribuye una versión solo por apodo, aunque sea único.

Esta etapa no cambia el esquema, los secretos ni la API privada del worker.
No requiere migración adicional ni reinstalar/reiniciar eden-rooms-on-demand.service.
La migración/instalación de las secciones siguientes corresponde solo a la primera
instalación. Si ya está configurado, basta actualizar el despliegue Preview.

El sistema NO expone un servidor HTTP en Ubuntu. Todas sus conexiones HTTP son
salientes hacia el Preview. El navegador nunca llama a la ruta privada ni recibe
COLLECTOR_API_KEY, VERSIONES_API_KEY o tokens de asignación.

## Límites y seguridad

- D1 y las APIs conservan su caducidad interna de 120 segundos. Solo se acepta
  una muestra vigente al recibirla; después la tarjeta guarda una copia local
  mientras siga abierta. El TTL no la oculta ni dispara consultas. La descarga no
  renueva la fecha. Una sala confirmada vacía es válida; un timeout no equivale
  a una sala vacía. Mantener reloj/NTP de Ubuntu sincronizado.
- Un único trabajo por sala, incluso con peticiones concurrentes de visitantes.
- Máximo global de dos trabajos en ejecución, asignados con un UPDATE atómico.
  El worker también limita sus hilos a uno o dos. No iniciar varias copias para
  intentar aumentar ese límite.
- Hasta 50 trabajos activos en cola; 10 solicitudes NUEVAS por IP/minuto.
  Solicitudes compartidas no crean más consultas ENet.
- Espera máxima de 45 segundos; cada asignación tiene un token privado aleatorio
  y una lease de hasta 30 segundos. Un resultado vencido/repetido o de otro trabajo
  no puede escribir. La autorización y el endpoint se revisan de nuevo al terminar.
- Tras error se permite reintentar con el enlace. Cloudflare conserva el cooldown de 15 s
  y las cuotas: el enlace permite solicitar, pero no evita los límites de seguridad.
  La interfaz no reencola indefinidamente si Ubuntu está desconectado.
- El navegador solo envía sala_id; se rechazan direccion, puerto y otros campos.
  Los POST públicos exigen JSON, origen idéntico y body de hasta 512 bytes, leído
  con un límite de bytes. No se usan cabeceras User-Agent como autenticación.
- Solo IPv4 públicas LITERALES: se rechazan localhost, redes privadas, link-local,
  CGNAT, multicast, rangos de documentación/reservados y dominios. No hay resolución
  DNS ni rebinding del destino ENet. Registrar en salas_endpoints una IPv4 pública
  exacta; no usar un dominio para esta primera versión.
- Ubuntu requiere además una lista explícita de CIDRs permitidos, preferentemente
  /32 por servidor. No acepta redes más amplias que /24 y vuelve a comprobar que
  cada IP sea global. Las IPs virtuales de los JUGADORES sí pueden ser privadas:
  son datos de identidad, nunca se utilizan como destinos de conexión.
- collector.py mantiene el timeout normal de C y añade un watchdog externo para
  el worker. El proceso C no hereda las claves HTTPS. Los redirects HTTP se
  rechazan; TLS sigue verificándose y los errores no publican credenciales.
- Las rutas nuevas están deshabilitadas por defecto. Solo operan con
  ENET_JOBS_ENABLED=true y el hostname exacto del Preview. Si CF_PAGES_BRANCH
  existe, debe coincidir con test/enet-versions-sralcer. No funcionan en el host
  de producción. No se cambia la protección general de Cloudflare.

Los límites acotan recursos, no garantizan que siempre haya capacidad ante muchas
salas o fallos de red. La UI conserva el diseño, no bloquea navegación, no mezcla
salas y muestra la hora original de la consulta, sin presentarla como actualización en vivo. Al cerrar una tarjeta deja de
consultar su estado; no cancela el trabajo compartido que puede necesitar otro
visitante. Trabajos abandonados vencen solos.

## 1. Migración exclusiva de la base de pruebas

Desde un equipo autenticado en la cuenta correcta:

```sh
npx wrangler d1 execute eden-rooms-test-db --remote \
  --file migrations/0001_enet_jobs.sql
```

El script crea solo enet_version_jobs, enet_request_limits y un índice. No altera
las tres tablas existentes ni elimina datos. NO ejecutarlo contra eden-rooms-db.
Este comando no se ejecutó durante el desarrollo.

Revisar que el binding DB de PREVIEW siga conectado a eden-rooms-test-db y que la
sala-prueba-20668 esté autorizada con la IP pública y el puerto reales. El script
no autoriza salas ni acepta endpoints del visitante. No tocar el binding de
producción.

## 2. Configuración de Cloudflare Preview, aún por realizar manualmente

En Settings del proyecto Pages, seleccionar únicamente Preview:

- Secret COLLECTOR_API_KEY: valor aleatorio NUEVO, distinto de VERSIONES_API_KEY
  y AUTORIZACIONES_API_KEY. El mismo valor se instalará en Ubuntu. Una opción
  para generarlo localmente es openssl rand -hex 32. No enviarlo al chat ni a Git.
- Variable ENET_JOBS_ENABLED: texto true, solo después de aplicar la migración.
- Binding DB: eden-rooms-test-db (confirmar la base real, no solo su nombre).

No es necesario dar VERSIONES_API_KEY al nuevo worker: su clave solo permite
reclamar/finalizar trabajos autorizados con una asignación vigente. El recolector
manual y versiones-multiples conservan su interfaz anterior.

Después de guardar esta configuración, desplegar/reintentar únicamente la rama
Preview. Usar el alias canónico:
https://test-enet-versions-sralcer.eden-rooms.pages.dev
Los hosts por hash de deployment y dominios ajenos no están habilitados para la
cola. Una consulta manual necesita la cola para solicitar una muestra nueva. Si falta la
configuración, la UI muestra un error discreto y permite reintentar con el enlace.

## 3. Instalación futura en Ubuntu, SIN iniciar ni habilitar

Comandos a ejecutar por el propietario DESPUÉS de revisar los cambios, desde el
checkout del repositorio:

```sh
git switch test/enet-versions-sralcer
git pull --ff-only origin test/enet-versions-sralcer
sudo apt update
sudo apt install -y build-essential libenet-dev python3
mkdir -p work
cc -O2 -Wall -Wextra -Werror backend/enet/client.c -lenet -o work/eden-collector
sudo install -d -m 755 /opt/eden-rooms-enet
sudo install -m 755 work/eden-collector /opt/eden-rooms-enet/eden-collector
sudo install -m 644 backend/enet/collector.py backend/enet/protocol.py \
  backend/enet/job_worker.py /opt/eden-rooms-enet/
sudo install -m 644 backend/enet/eden-rooms-on-demand.service \
  /etc/systemd/system/eden-rooms-on-demand.service
```

Solo la primera vez, si no existe ya el archivo de secretos:

```sh
sudo install -m 600 backend/enet/on-demand.environment.example \
  /etc/eden-rooms-on-demand-preview.env
sudoedit /etc/eden-rooms-on-demand-preview.env
sudo systemctl daemon-reload
```

Si ya existe el archivo, NO sobrescribirlo con la plantilla: editarlo directamente.
El contenido debe tener COLLECTOR_API_KEY con la clave de Preview y, por ejemplo:

```
ENET_ALLOWED_CIDRS=69.24.117.72/32
```

Agregar únicamente IPs públicas autorizadas de las salas que se quieren probar,
separadas por comas. Si el administrador cambia un endpoint en D1, revisar también
esta lista. La sala puede estar autorizada en D1 y ser rechazada por la lista local:
en ese caso el worker falla sin abrir ENet.

No hay comandos start/enable en esta fase de instalación. No instalar el timer
periódico antiguo para este flujo. La unidad nueva sigue separada de eden-sala y
no cambia su Docker, red, volúmenes, configuración ni puertos.

## 4. Primera prueba manual, sin activar el servicio automático

Para probar en primer plano con un usuario normal, introducir la clave sin
imprimirla ni incluirla como argumento del proceso:

```sh
read -rsp 'COLLECTOR_API_KEY de Preview: ' COLLECTOR_API_KEY
export COLLECTOR_API_KEY
export ENET_ALLOWED_CIDRS=69.24.117.72/32
python3 /opt/eden-rooms-enet/job_worker.py --workers 2 --poll-seconds 3
```

Dejar esa terminal abierta. No hace conexiones ENet mientras no haya trabajos.
También existe --once para retirar como máximo un trabajo y terminar; si no hay
ninguno sale sin conectar a salas. --help muestra opciones y la URL de destino
está fijada/validada como Preview, nunca producción.

En otra ventana:

1. Abrir https://test-enet-versions-sralcer.eden-rooms.pages.dev/.
2. Desplegar la sala cuyo versionsRoomId sea sala-prueba-20668. Debe seguir en el
   lobby público y coincidir por endpoint; no se crean salas offline desde D1.
3. Abrir/reabrir no envía POST. Solo pulsar Consultar versiones lo envía.
   Solo se reutiliza un trabajo PENDIENTE o EN EJECUCIÓN de otro visitante.
4. Ver «Consultando versiones…» y en Network un POST versiones-consultar que solo
   contiene sala_id, seguido por GET de estado. No debe haber peticiones del
   navegador a /api/collector/jobs ni cabeceras con claves.
5. Al terminar el worker aparece la versión sin recargar. Comparar con
   /api/versiones-sala?id=sala-prueba-20668. Varios visitantes simultáneos comparten
   el mismo trabajo activo. Otro clic manual posterior a su finalización puede crear otro.
6. Mantener la tarjeta abierta diez minutos: no debe haber nuevos POST de
   versiones-consultar. Tras 120 s o varias horas las versiones y hora originales siguen visibles para jugadores que continúan presentes.
   El enlace permite otra consulta; cerrar/reabrir no la inicia.
7. Detener el worker con Ctrl+C. La espera termina como máximo a los 45 s con un
   mensaje discreto que permite reintentar con Consultar versiones. Esperar el cooldown de servidor antes
   de hacerlo; dejar abierta la tarjeta no vuelve a solicitar trabajo.

Los logs HTTP conservan código, detalle acotado y CF-Ray si Cloudflare rechaza
al cliente. Un 404 puede indicar que no se habilitó la cola o que el host no es el
alias canónico; un 401 privado indica clave incorrecta; un 503 puede indicar
migración/binding/configuración faltante. Los mensajes públicos no incluyen
trazas, IPs internas ni tokens. Reloj incorrecto o un worker muy demorado pueden
producir una lease vencida y el resultado se descarta con 409.

## 5. Activación y parada posteriores, solo por decisión del propietario

No se ejecutaron estos comandos. Si la prueba manual fue satisfactoria y se decide
activar el servicio después, primero terminar el worker de primer plano. Luego:

```sh
sudo systemctl start eden-rooms-on-demand.service
sudo systemctl status eden-rooms-on-demand.service
sudo journalctl -u eden-rooms-on-demand.service -f
```

start lo inicia manualmente, pero NO lo habilita para el arranque. Si más adelante
se decide iniciar también al arrancar Ubuntu:

```sh
sudo systemctl enable eden-rooms-on-demand.service
```

Para detener y deshabilitar:

```sh
sudo systemctl disable --now eden-rooms-on-demand.service
```

KillMode=control-group y un límite de parada de 30 s evitan dejar clientes ENet
huérfanos. Las asignaciones pendientes vencen y la API deja de entregar muestras al cumplir
120 s; las versiones locales conocidas siguen visibles para identidades que continúan presentes. No borrar tablas para detenerlo. Para deshabilitar también la creación de
trabajos, cambiar ENET_JOBS_ENABLED a false solo en Preview y desplegar Preview.

No usar a la vez el temporizador/recolector periódico antiguo y el worker bajo
demanda: generaría consultas innecesarias. Ninguno se ha activado desde este trabajo.

## Pruebas de desarrollo

```sh
node --test tests/*.test.mjs
python3 -m unittest discover -s tests -p 'test_*.py'
```

Las pruebas de cola ejecutan SQLite real en memoria: concurrencia/deduplicación,
autenticación, límites, destinos privados, caducidad, tokens viejos, reapertura y
transacción de resultado. Chromium comprueba escritorio/móvil, llegada asíncrona,
mensaje de espera y Ubuntu offline con APIs simuladas locales. Python comprueba
validación de IP/CIDRs, ausencia de claves en C, timeout externo y selección de la
última instantánea. La prueba ENet de transporte se ejecuta solo en loopback.

La prueba Chromium requiere EDEN_PLAYWRIGHT_MODULE apuntando a @playwright/test
instalado y Chromium local; la de ENet requiere EDEN_TEST_CLIENT/EDEN_TEST_SERVER.
No se ejecutaron peticiones a D1 remoto ni se conectó a salas públicas durante
estas pruebas. La verificación del Preview real debe hacerse tras los pasos
manuales de migración, configuración y ejecución del worker.
