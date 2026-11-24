# Versiones ENet en Preview

El directorio actualiza la lista de jugadores cada diez segundos mientras la
página está visible. En salas públicas elegibles, las muestras programadas
asocian versiones automáticamente durante seis minutos desde su toma. La
tarjeta muestra «Muestra ENet reciente» con la fecha, «Muestra ENet antigua»
con la fecha al vencer, o «Versiones ENet no disponibles» si falta una muestra
con versiones. Las versiones de una muestra vencida dejan de mostrarse.

«Consultar versiones» lee la muestra publicada mediante
`GET /api/versiones-publicadas?id=<enetVersionsRoomId>`, con el identificador
que entrega `/api/rooms`. Abrir o reabrir la tarjeta no hace esa lectura.
El botón no requiere credenciales en el navegador ni inicia una conexión ENet.

Durante la lectura aparece «Consultando versiones…». Una muestra vigente
muestra «Versiones consultadas a las HH:mm» en la zona horaria del visitante.
Si hay asociaciones, la tarjeta indica cuántas versiones de la muestra se
asociaron y si se usó la coincidencia sin IP virtual. Una muestra antigua conserva
la fecha. Si la API indica que no hay muestra disponible aparece «Versión no
disponible». Ante un error de lectura, la tarjeta ofrece reintentar con el botón.
Una muestra programada vigente y posterior a la leída con el botón tiene
precedencia.

Las versiones se asocian a los jugadores actuales por nombre, IP virtual y
juego, con un Title ID coincidente cuando está disponible en ambos lados. Si
el directorio omite la IP virtual, se exige apodo único en ambas listas, juego
exacto y Title ID no nulo coincidente. La asociación no verifica continuidad
de sesión entre refrescos del directorio.

## Despacho manual de Preview

En la fase autorizada, comprobar que `DB` y `ENET_PREVIEW_DB` apuntan a
`eden-rooms-test-db`. El despacho manual sigue disponible cuando el cron pasa
a producción. Ejecutar el workflow «ENet versions» desde `main` con
`publish=true` y `cloudflare_slot` vacío, con
`EDEN_ENET_PREVIEW_PUBLISH=true`. Confirmar que se ejecuta `publish-preview`
y revisar `Published: N/M`. Los pasos de activación, inventario y rollback
están en el [runbook](DESPLIEGUE-PRODUCCION.md).

## Verificación

- En escritorio y móvil, abrir una sala elegible y comprobar que abrir la
  tarjeta no llama a `versiones-publicadas`. Pulsar el botón y confirmar un
  GET con el identificador de la sala y sin credenciales.
- Verificar el estado reciente, el paso a antiguo a los seis minutos y la
  retirada de las versiones vencidas. Comprobar también los estados sin
  muestra y de error, y que una sala protegida no ofrece el botón.
- La suite local usa SQLite sintético, ENet en loopback y Chromium con
  respuestas simuladas. La inspección del entorno real y la PS5 física
  quedan para la fase autorizada.

El recorrido anterior de la cola bajo demanda se conserva en
[ON_DEMAND.md](ON_DEMAND.md).
