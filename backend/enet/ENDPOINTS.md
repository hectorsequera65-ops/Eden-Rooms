# Endpoints existentes y estado de publicación

En el candidato de producción, `GET /api/versiones-programadas` requiere la
clave del entorno y devuelve el contrato de almacenamiento y las salas
elegibles. En producción, `POST /api/versiones-programadas?reserve` reserva el
turno y el POST sin query publica con ese turno activo. La escritura debe
recibirse dentro de los cinco minutos del turno. La fecha original de ENet debe
estar entre el comienzo del turno y la recepción de la solicitud, inclusive.
Preview y las rutas legadas conservan el límite de 120 segundos. La producción usa
`X-ENet-Production-Key` y el binding `DB`. Preview usa
`X-ENet-Preview-Key` y `ENET_PREVIEW_DB` y publica sin turno.
`GET /api/versiones-publicadas?id=…` es público y revalida la sala. Las rutas
legadas de la tabla siguiente conservan su contrato.

## Hechos comprobados

El checkout Ubuntu informado estaba en d1601d3, cuyo árbol NO contiene
versiones-validar.js ni --check-auth. Este cambio agrega ambos a la rama
remota test/enet-versions-sralcer en una revisión posterior: actualizar el checkout
con git pull --ff-only origin test/enet-versions-sralcer para obtener el cliente.
Eso NO despliega las Functions de Pages: la ruta HTTP sigue pendiente de una
publicación separada y autorizada. El commit omite CI y Pages mediante sus marcas.

El GET 200 con HTML reportado por el usuario es compatible con el fallback del
frontend para una ruta sin Function; no valida la clave ni demuestra D1. El GET
por sí solo tampoco distinguiría una Function POST-only de una ruta ausente.
La revisión local anterior de versiones-validar tenía solo POST; ahora tiene GET
y POST, con propósitos distintos.

No se pudo inspeccionar la configuración privada ni la revisión desplegada de
Pages. La comprobación directa desde este entorno falla en el proxy con
Tunnel connection failed: 403 Forbidden, antes de obtener una respuesta del sitio.
No se afirma haber observado el HTML ni probado las claves del entorno remoto.

## Matriz de rutas

| Método/ruta | En d1601d3 | Código actual de la rama | Efectos |
| --- | --- | --- | --- |
| GET /api/autorizaciones | Sí | Sí | Lee salas autorizadas; clave de lectura opcional |
| GET /api/versiones-validar | No | Nuevo | Comprueba la clave de versiones, sin consultas D1 |
| POST /api/versiones-validar | No | Nuevo | Autentica y valida snapshot con lecturas D1; no escribe |
| POST /api/versiones-multiples | Sí | Sí, misma interfaz | Autentica y guarda snapshot por sala_id |
| GET /api/versiones-sala?id=... | Sí | Sin cambios | Lee snapshot vigente de una sala autorizada |
| GET /api/rooms | Sí | Sin cambios | Lee lobby y enriquece desde D1 |
| GET/POST /api/versiones | Sí | Sin cambios | Ruta heredada de Eden Rooms Test; POST escribe y NO es un test inocuo |

Esta tabla describe código conocido, no certifica que el sitio publicado ejecute
ese commit. Antes de habilitar envío, revisar el deployment de Pages y su revisión
exacta; verificar además el mismo binding DB en todas las rutas del entorno.

## GET: prueba exclusiva de autenticación

Solicitud: X-API-Key en encabezado; sin body, sin query de secretos, sin ENet.
El cliente heredado utiliza `X-API-Key` con `VERSIONES_API_KEY`. En el alias
HTTPS `test-enet-versions-sralcer.eden-rooms.pages.dev`, el workflow ENet
utiliza `X-ENet-Preview-Key` con `ENET_PREVIEW_API_KEY`. La clave de Preview
también habilita GET/POST de `/api/versiones-programadas` con los controles
existentes. Cada encabezado se valida contra su propia clave. Los POST de
`/api/versiones-validar`, `/api/versiones-multiples` y `/api/versiones`
conservan la autenticación heredada.

- Secreto de servidor ausente: 503 JSON.
- Clave ausente, incorrecta o solo clave de lectura: 401 JSON.
- Clave correcta: 200 JSON, Cache-Control: no-store:

```json
{
  "ok": true,
  "endpoint": "versiones-validar",
  "contrato": 1,
  "modo": "autenticacion",
  "autenticado": true,
  "escritura": false,
  "db_configurada": true
}
```

`db_configurada` solo indica que existe env.DB: NO prueba conexión, tablas,
permisos de escritura ni que sea la base correcta. Puede ser false y la clave
seguir siendo válida. El GET nunca llama prepare ni consulta tablas.
No devuelve ni registra claves ni acepta claves en la URL.

Tras una futura publicación de prueba autorizada y con VERSIONES_API_KEY ya
cargada en el entorno del shell (no hace falta copiarla al comando):

```sh
python3 backend/enet/collector.py \
  --base-url https://HOST_DE_PRUEBAS_CONFIRMADO --check-auth
```

El cliente exige JSON y el contrato endpoint/contrato/modo/autenticado/escritura
exactos. HTML 200, JSON genérico o 404 producen error y código de salida 1, sin
fallback al endpoint de escritura. --check-auth hace un solo GET, no consulta
/api/autorizaciones ni exige la clave de lectura y no arranca el cliente C.
No existe en el collector del commit d1601d3: actualizar Ubuntu desde esta rama.
La Function HTTP requiere posteriormente un despliegue expresamente autorizado.

## POST de validación y compatibilidad del recorrido

--validate-send usa únicamente POST /api/versiones-validar y exige VERSIONES_API_KEY.
Recibe sala_id, consultado_en, jugadores[{nombre,juego,version,title_id,virtual_ip}].
Comprueba autorización, endpoint y columnas de versiones_salas con SELECT.
Rechaza versiones inválidas por formato, fecha o sala antes de cualquier escritura.
No crea ni reemplaza snapshots. No equivale a probar que INSERT funcione.

El collector d1601d3 y el local mantienen el formato de POST /api/versiones-multiples:
X-API-Key, Content-Type application/json, Title ID hexadecimal de 16 caracteres,
fecha UTC reciente y hasta 32 jugadores. No se agregó una señal dry_run a ese
endpoint: versiones antiguas podrían ignorarla y escribir de todos modos.

/api/rooms sigue asociando endpoint exacto y apodos únicos con juego coincidente,
conservando title_id en D1 y exponiendo gameVersion/gameTitleId en el JSON del lobby.
Omite homónimos y compara gameId cuando está disponible sin pérdida de precisión.
La UI existente ya consume gameVersion; no necesita rediseño. HTTP 200 del lobby
sin gameVersion no demuestra que D1 haya sido leído correctamente (hay fallback).

Las pruebas ejecutan SQL real con SQLite, incluyendo datos de ejemplo Eden y SataHT,
Mario Kart 8 Deluxe, Title ID 0100152000022000 y versión 4.0.1. No son lecturas del
D1 remoto. La prueba HTTP local de Pages confirma GET JSON 401/401/200 con clave
incorrecta/ausente/correcta y sin binding D1. Nada se ha enviado al servidor real.

Para el plan de verificación del esquema/bindings y aislamiento de la base,
seguir D1_PREFLIGHT.md. Los datos de la base, la configuración de claves y el ENet
funcional informados por el usuario no implican que una ruta nueva ya esté desplegada.

Cuando se habilita ENet programado en producción, `/api/rooms` conserva el
`versionsRoomId` legado para las salas registradas. La consulta manual usa
`enetVersionsRoomId` con `GET /api/versiones-publicadas?id=…`. Preview también
expone ese campo. Cuando la sala no admite la consulta, el campo vale `null`.
