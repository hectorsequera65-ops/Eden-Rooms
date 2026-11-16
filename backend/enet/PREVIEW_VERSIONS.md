# Jugadores en vivo y versiones manuales — Preview

Entorno exclusivo: test/enet-versions-sralcer, eden-rooms-test-db.
Ver [ON_DEMAND.md](ON_DEMAND.md) para instalación previa y seguridad.
Esta etapa no necesita migración, cambios de secretos ni cambios del servicio Ubuntu.
No activar el temporizador periódico antiguo.

## Fuentes independientes

/api/rooms obtiene rooms[].players del directorio https://api.ynet-fun.xyz/lobby.
La página sigue actualizando esa lista cada 10 segundos mientras está visible;
la API tiene caché de 5 segundos. El código anterior a la captura persistente
usaba esa misma lista para nombres, juegos, cantidad y filtros.
La API sigue registrando versionsRoomId por endpoint autorizado. Las versiones
ENet añadidas por /api/rooms se quitan en la UI: no sustituyen la consulta manual.

Abrir/cerrar/reabrir no inicia ENet. Solo «↻ Consultar versiones», junto a
«Ver descripción», envía POST /api/versiones-consultar. Clics durante la espera
comparten la solicitud; el botón queda deshabilitado. GET cada 2 s solo sigue
el trabajo pendiente y después lee /api/versiones-sala una vez.

Solo se acepta una respuesta vigente (120 s), de la sala y endpoint correctos.
La copia local después no vence y muestra «Versiones consultadas a las HH:mm»
en la zona horaria del visitante. Otro clic manual reemplaza esa copia. Cerrar
no borra resultados conocidos; recargar la página sí descarta el estado local.
D1 y las APIs mantienen su caducidad y sus protecciones sin cambios.

La lista visible siempre es la del directorio, nunca los jugadores de la captura.
Se asocian versiones por nombre + IP virtual únicos, juego y Title ID cuando
está disponible, conservando enteros de 64 bits exactos. Sin IP compartida o
ante ambigüedad se muestra «Versión sin consultar». Cambios de juego/identidad,
salidas o duplicados detectados invalidan la asociación anterior hasta consultar
manualmente. Actualizar el listado visible no borra datos históricos en D1.

El directorio no ofrece aquí un identificador de sesión correlacionado con el
paquete ENet. Si alguien sale y vuelve entre dos refrescos con idéntica identidad,
no se puede detectar. Si faltan nombres individuales en el directorio no se
simulan: solo se muestra la información disponible sin consultar ENet de oficio.

## Verificación en Preview

1. Esperar el despliegue del commit y confirmar DB=eden-rooms-test-db.
2. Abrir una sala registrada. En Network no debe haber POST versiones-consultar.
3. Sin consultar versiones, comprobar entradas/salidas y cantidades cada 10 s.
4. Pulsar Consultar versiones: un POST con solo sala_id; aparece el estado de
   espera, luego versiones y hora original. El navegador no recibe claves.
5. Esperar más de 120 s: las versiones de identidades que continúan presentes
   siguen visibles. Si sale alguien desaparece; los nuevos quedan sin consultar.
6. Cerrar y reabrir: ningún POST. Otro clic sí consulta de nuevo, sujeto a cuotas,
   cooldown y deduplicación. Comprobar también desde un celular.

## Pruebas locales

Node cubre SQL real, autenticación, límites, coincidencias, caducidad de API,
consultas manuales y continuidad de identidad. Chromium usa APIs simuladas locales
sobre la página real en escritorio y móvil, con reloj adelantado durante horas.
Python cubre protocolo binario, collector y worker; ENet de integración solo loopback.
No se escriben datos remotos ni se consulta ninguna sala pública en estas pruebas.

```sh
node --test tests/*.test.mjs
python3 -m unittest discover -s tests -p 'test_*.py'
```

Chromium requiere EDEN_PLAYWRIGHT_MODULE y /usr/bin/chromium (o EDEN_CHROMIUM).
La prueba ENet requiere EDEN_TEST_CLIENT y EDEN_TEST_SERVER, descritos en README.md.
