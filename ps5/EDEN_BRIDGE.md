# Eden Bridge: protocolo de integración (prototipo)

**Estado:** la interfaz web PS5 tiene un botón **Enviar a ProsperoEden**, pero **el payload receptor aún no está implementado**. No se debe interpretar un error de conexión como un guardado exitoso.

## Solicitud propuesta

- Destino local: `http://127.0.0.1:24879/v1/connection`
- Método: `POST`
- Cuerpo de texto JSON: `{"host":"192.0.2.1","port":24872}`
- Respuesta positiva: `{"ok":true}`
- Respuesta de error: `{"ok":false,"error":"..."}`
- CORS: aceptar exclusivamente el origen `https://eden-rooms-ps5.pages.dev`; denegar orígenes desconocidos y solicitudes sin `Origin`, salvo un cliente local autenticado.

## Seguridad necesaria antes de habilitar escrituras

1. No exponer el servicio en interfaces LAN/WAN: escuchar únicamente en loopback.
2. Rechazar peticiones de otras páginas, incluyendo solicitudes simples `text/plain`; validar `Origin` **antes** de procesar el cuerpo.
3. Añadir emparejamiento o confirmación local para evitar que cualquier web abierta en la PS5 pueda alterar el destino de conexión.
4. Validar IP/hostname y puerto (1 a 65535); limitar tamaño de petición y aplicar timeouts.
5. Mantener un backup del JSON y preservar todos los campos ajenos a `multiplayer.host` y `multiplayer.port`, incluidos los perfiles inactivos.
6. Modificar solamente el perfil activo y el bloque general correspondiente, tras verificar su estructura. Escritura atómica, permisos originales y reversión ante error.
7. Ejecutar con ProsperoEden cerrado; confirmar que no esté ejecutándose antes de modificar el archivo.
8. Probar si el navegador de PS5 permite `fetch` desde HTTPS hacia HTTP loopback: podrían intervenir restricciones de contenido mixto, origen privado o CORS. Si falla, necesitará un puente HTTPS seguro u otra integración; no desactivar las protecciones del navegador.

**Ruta prevista:** `/data/prosperoeden/config/prosperoeden.json`.

La primera versión del frontend es una prueba de conectividad y no incluye el servicio nativo. El botón **Copiar IP y puerto** sigue disponible.
