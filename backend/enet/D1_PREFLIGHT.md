# Verificación previa al envío a D1

Estado: cambios preparados en test/enet-versions-sralcer para revisión en GitHub.
No se desplegó Pages, no se fusionó main, no se ejecutaron escrituras remotas ni
se modificó eden-sala.

La prueba real informada desde Ubuntu confirma transporte y lectura ENet:
EU Official, cinco jugadores; Eden y SataHT con Mario Kart 8 Deluxe,
Title ID 0100152000022000, versión 4.0.1. El usuario confirmó después que las tres tablas existen y VERSIONES_API_KEY
está configurada en Ubuntu y Cloudflare. Esto aún no verifica sus columnas,
restricciones, binding DB del entorno concreto ni la presencia de la integración
en el sitio desplegado.
No reutilizar una captura vieja como si fuera una muestra actual.

## Qué se verificó y qué falta

- Código: el POST autentica X-API-Key contra VERSIONES_API_KEY antes de consultar
  D1; requiere DB, JSON, sala autorizada con endpoint y fecha de hasta 120 s.
  Admite hasta 32 miembros y preserva title_id como cadena de 16 dígitos hex.
  No acumula jugadores por apodo y excluye sralcer. La clave opcional de lectura
  AUTORIZACIONES_API_KEY no reemplaza VERSIONES_API_KEY.
- SQL: pruebas nuevas con SQLite real ejecutan los SELECT y UPSERT compartidos,
  conservan el Title ID, impiden reemplazo por muestras anteriores y comprueban
  el recorrido POST -> D1 -> /api/rooms y /api/versiones-sala. No son una prueba
  del servicio remoto D1 ni de permisos reales de la cuenta.
- UI: index.html ya usa gameVersion y refresca salas cada diez segundos.
- Configuración real: no hay archivo wrangler ni migraciones versionadas.
  No hay credenciales Cloudflare en este entorno y el panel no estaba accesible
  en la revisión anterior. La base LOCAL de Wrangler disponible solo contiene
  tablas del chat. No se la considera una copia del D1 remoto.
- La consulta HTTP pública desde este entorno también fue impedida por el proxy
  (Tunnel connection failed: 403 Forbidden), no por un diagnóstico de la Function.
  Hace falta verificar el esquema, los bindings y los datos desde tu cuenta/Ubuntu.

## 1. Confirmar la base y los bindings sin cambiar nada

En el proyecto Eden-Rooms de Workers & Pages, revisar por separado Production y
Preview. El binding D1 debe llamarse exactamente DB. Registrar nombre y UUID de
la base conectada; no alcanza con que la base exista en la cuenta. Comparar el
binding de los endpoints de validación, recepción y /api/rooms: deben usar la
misma base dentro del mismo entorno. No modificar bindings del chat por error.

Para una prueba aislada posterior, usar un proyecto/preview con una base D1 de
pruebas distinta, una clave de escritura distinta y solo el registro autorizado
de la sala a consultar. Un preview que apunte a la base de producción NO aísla
las escrituras. No arrancar systemd ni cambiar EDEN_PAGES_URL del servicio real
para probar. No modificar Docker, puertos, volúmenes ni variables de eden-sala.

Esquema mínimo requerido por las consultas:

| Tabla | Columnas requeridas |
| --- | --- |
| salas_autorizadas | sala_id, nombre, autorizada |
| salas_endpoints | sala_id, direccion, puerto |
| versiones_salas | sala_id, nombre_sala, jugadores_json, actualizado_en |

versiones_salas.sala_id necesita PRIMARY KEY o UNIQUE individual para el UPSERT.
Los registros de autorizaciones/endpoints deben asociar inequívocamente un sala_id
al IP/dominio y puerto del lobby. El puerto debe estar entre 1 y 65535.
Las fechas almacenadas deben ser ISO UTC normalizadas (el POST las normaliza);
los jugadores se guardan en jugadores_json. No hace falta una columna title_id.

Desde un equipo con Wrangler autenticado, usando el NOMBRE/UUID DE LA BASE
CONFIRMADA (no el texto literal del ejemplo):

```sh
npx wrangler d1 list
npx wrangler d1 execute NOMBRE_O_UUID_D1 --remote \
  --file backend/enet/d1-audit-readonly.sql
```

El archivo contiene solo SELECT y PRAGMA; no crea tablas ni modifica datos.
Si falta una tabla/columna o la restricción UNIQUE, detenerse y preparar una
migración a partir del esquema REAL y su respaldo. NO ejecutar remotamente
`tests/fixtures/versions-schema.sql`: es únicamente el esquema inferido de tests.
Para EU Official debe aparecer un único registro autorizado con endpoint correcto;
no usar el nombre visible como sala_id sin comprobar el valor real. Revisar
cualquier IP:puerto duplicado, porque el enriquecimiento omite endpoints ambiguos.

## 2. Verificar autenticación y despliegue existente

- VERSIONES_API_KEY: secreto de escritura de Pages y variable del recolector;
  deben coincidir y no estar vacíos. No enviarlo por chat, Git ni parámetros CLI.
- AUTORIZACIONES_API_KEY: solo si está habilitada la lectura privada; mismo valor
  en cliente y Function. Usa X-Collector-Key y NO autoriza el POST de versiones.
- EDEN_ENET_NICKNAME=sralcer en Ubuntu; si se personaliza el nombre, mantener
  igual el filtro EDEN_ENET_NICKNAME de Pages.
- Usar HTTPS y la URL canónica. El cliente rechaza redirecciones, identifica la
  aplicación con su propio User-Agent y registra HTTP/CF-Ray si el edge bloquea.
- Comprobar qué revisión está efectivamente desplegada. Que la rama exista en
  GitHub no implica que Pages la ejecute. Si la recepción antigua descarta Title
  IDs o /api/rooms no enriquece, NO activar --send contra esa revisión.

## 3. Pruebas locales disponibles ahora (sin publicación)

```sh
node --test tests/*.test.mjs
python3 -m unittest discover -s tests -p 'test_*.py'
wrangler pages functions build functions --outdir work/pages-build
```

Las pruebas SQLite requieren un Node con node:sqlite (probado con Node 24).
Sin EDEN_TEST_CLIENT/EDEN_TEST_SERVER se omite solo la prueba ENet local opcional.
Los tests no hacen POST remotos ni abren conexiones a salas públicas.

## 4. Validación autenticada sin escritura (para una publicación de prueba futura)

Se preparó GET /api/versiones-validar para comprobar solo la clave, sin consultar
D1, y POST /api/versiones-validar para validar snapshots. Ver ENDPOINTS.md para la
matriz de métodos y la diferencia entre el código local y el commit d1601d3.
El GET se usa con --check-auth. El POST comparte exactamente validación,
autenticación y autorización con /api/versiones-multiples. Comprueba las columnas
de versiones_salas con SELECT y devuelve:

```json
{"ok":true,"validado":true,"escritura":false,"sala_id":"ID_REAL","jugadores":5}
```

No hace INSERT/UPDATE ni altera una muestra existente. La ruta es nueva para que
un servidor antiguo NO pueda ignorar un flag y ejecutar una escritura. El cliente
exige la confirmación validado=true/escritura=false; nunca cambia al POST real
si falta esa ruta o si la respuesta no coincide.

La Function NO está desplegada: no ejecutar el comando esperando que ya exista
en eden-rooms.pages.dev. Tras una revisión y publicación de prueba expresamente
autorizada, con la clave de PRUEBAS cargada de forma privada en el entorno:

```sh
python3 backend/enet/collector.py \
  --base-url https://HOST_DE_PRUEBAS_CONFIRMADO --check-api

python3 backend/enet/collector.py \
  --base-url https://HOST_DE_PRUEBAS_CONFIRMADO \
  --client ./work/eden-collector --room-id ID_REAL_EU_OFFICIAL \
  --validate-send --once --duration 20
```

El primer comando no abre ENet. El segundo sí consulta temporalmente la sala
seleccionada como sralcer, pero solo hace POST a la ruta SIN ESCRITURA. No abre
ni modifica el servidor de juegos. El ID debe salir de autorizaciones; el cliente
falla si no lo encuentra de manera única. Sin paquetes válidos también falla,
para evitar considerar una conexión sin datos como una validación exitosa.

Una respuesta válida comprueba clave de escritura, DB accesible, sala autorizada,
endpoint registrado, formato, frescura y columnas. No prueba que un INSERT vaya a
funcionar ni demuestra el recorrido real de almacenamiento/renderizado: eso
requiere una escritura posterior en D1 DE PRUEBAS, explícitamente autorizada.

Códigos esperados: 401 clave incorrecta, 403 sala sin autorización/endpoint,
400 formato o fecha inválida, 503 binding/secreto/esquema o acceso D1 defectuoso.
Un 403 con 1010 antes de la Function se diagnostica por separado según
CLOUDFLARE_ACCESS.md. Un 404 o HTML del frontend no valida el endpoint nuevo.

## 5. Condiciones para habilitar --send después

1. Schema y bindings confirmados en el entorno de destino, sin afectar chat.
2. Validación autenticada satisfactoria con una captura nueva y una sala elegida.
3. Escritura de prueba autorizada en D1 separada; leer la fila por sala_id y
   comprobar jugadores_json, title_id=0100152000022000 y version=4.0.1 solo si
   siguen siendo los valores anunciados en ese momento.
4. Leer /api/versiones-sala?id=ID_REAL: disponible=true y muestra actual.
5. Leer /api/rooms del MISMO entorno: endpoint idéntico y apodos/juegos exactos;
   gameVersion debe aparecer junto a gameTitleId. /api/rooms puede funcionar sin
   versiones si D1 falla, así que un simple HTTP 200 NO demuestra integración.
6. Si gameId existe en el lobby, debe compararse sin pérdida de precisión. Un
   gameId JSON numérico fuera del rango seguro de JavaScript hace que el código
   omita la asociación; confirmar el JSON real y corregir el contrato antes de
   activar envío si ocurre. Los tests usan IDs como cadenas decimales exactas.
7. Verificar en navegador la versión junto a cada jugador. La caché de rooms es
   5 s y la web refresca cada 10 s. Las muestras vencen a los 120 s; al detener el
   recolector desaparece el enriquecimiento. No convertir un timeout en sala vacía.
8. Homónimos, juegos distintos, Title ID incompatible o muestras vencidas no deben
   recibir versiones. No confundir el juego preferido de sala con el de un jugador.

El envío periódico real queda pendiente de una decisión posterior. Todo el
recolector se ejecuta fuera del contenedor eden-sala, incluso si ambos comparten
el mismo Ubuntu. No se ha instalado ni activado ninguna unidad systemd.
