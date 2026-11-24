# Decodificación binaria del paquete ID 3

## Corrección

La cabecera se lee por campos, respetando longitudes y tamaños binarios:
ID uint8; nombre y descripción delimitados por longitud uint32 BE; capacidad
uint32 BE; puerto uint16 BE; juego preferido y propietario delimitados por
longitud; cantidad de miembros uint32 BE. Ningún entero, longitud, puerto,
Title ID ni dirección se pasa a un decodificador UTF-8.

Las etiquetas de cabecera son metadatos, no identificadores utilizados por la
integración. Se consumen como bytes; solo al producir la salida de diagnóstico
se muestran como UTF-8 con escape visible de bytes no válidos (por ejemplo
`R\xa6`). No se usan errors=ignore ni sustituciones en los apodos. El recolector
no envía esas etiquetas de cabecera a Pages y sigue asociando la sala por su ID
registrado, no por texto arbitrario del paquete.

Cada miembro se recorre en el orden:

| Campo | Lectura |
| --- | --- |
| Apodo | longitud uint32 BE + texto UTF-8 estricto |
| IP virtual | exactamente 4 octetos, sin prefijo de longitud |
| Juego | longitud uint32 BE + texto UTF-8 estricto |
| Title ID | exactamente 8 bytes, uint64 BE, salida hex de 16 dígitos |
| Versión | longitud uint32 BE + texto UTF-8 estricto |
| Usuario, nombre visible, avatar | tres campos con longitud uint32 BE, consumidos como bytes |

El parser anterior exigía doce ceros después de cada versión. Eso solo representa
tres campos vacíos: con cuentas no vacías hay que leer sus longitudes y saltar sus
payloads para que el siguiente apodo quede alineado. Estos campos no intervienen
en la asociación de versiones y no se incluyen en los snapshots enviados.

Los errores de apodo/juego/versión incluyen ahora nombre del campo y offset en el
paquete, en lugar de un UnicodeDecodeError sin contexto. No se escanean offsets
alternativos ni se adivina una codificación para identidades corruptas. Siguen
siendo obligatorios los límites, el número de miembros y el final exacto del
paquete. Una muestra inválida se rechaza entera, sin enviar una sala vacía.

## Evidencia y límites

El núcleo de Eden obtiene la versión de los metadatos de control del juego
cargado y la asigna a `game_info.version` antes de enviarla a la sala.
El servidor guarda ese valor en el miembro asociado al peer ENet y lo
escribe dentro del registro de ese miembro en el paquete 3. La versión
puede venir vacía si el cliente no tiene metadatos. El servidor transmite
lo que informa el cliente, sin verificar su instalación.

- [Carga del juego en Eden](https://github.com/eden-emulator/mirror/blob/master/src/core/core.cpp)
- [Recepción y difusión por miembro](https://github.com/eden-emulator/mirror/blob/master/src/network/room.cpp)


La estructura se contrastó con la implementación pública de Eden en este snapshot:
- https://github.com/xatyy/Eden4/blob/fab246cbac93c7995aaf451dca83ae93ba0bd234/eden/src/network/room_member.cpp
  (HandleRoomInformationPacket, secuencia de campos y metadatos de cuenta).
- https://github.com/xatyy/Eden4/blob/fab246cbac93c7995aaf451dca83ae93ba0bd234/eden/src/network/packet.h
  (arrays de tamaño fijo sin prefijo, vectores con prefijo).
- https://github.com/xatyy/Eden4/blob/fab246cbac93c7995aaf451dca83ae93ba0bd234/eden/src/network/packet.cpp
  (enteros en orden de red y strings como bytes delimitados).

No se dispone todavía del hex del incidente en 69.24.117.72:20668. Un único intento
de consulta con sralcer desde este entorno no recibió paquetes. Por tanto no se
atribuye el byte 0xa6 a un campo concreto de esa captura ni se afirma haber
reproducido la sala real. La corrección cubre metadatos/cabeceras con bytes no
UTF-8 y cuentas no vacías, sin confundirlos con IPs ni texto de jugador.

Pruebas de regresión sintéticas:
- Smash, Title ID 01006A800016E000, versiones 13.0.2, 13.0.3, 13.0.4, 13.0.5 y
  7.0.0, cabeceras con byte 0xa6, IPs 10.166.255.x y cuentas no vacías.
- Mario Kart 8 Deluxe, Title ID 0100152000022000, versión 4.0.1, con y sin metadatos.
- Todos los truncamientos de una muestra con metadatos variables; cola extra;
  apodo UTF-8 inválido rechazado con contexto.
- Recorrido por collector.collect desde una línea ASCII EDEN_PACKET3 hexadecimal,
  sin interpretar el paquete binario completo como UTF-8.

Además sigue pasando el fixture de captura real anonimizada Monster Hunter y
la prueba de transporte ENet local. Para confirmar el incidente original, ejecutar
read_packet3.py contra el log original y compartir cualquier error contextual
restante junto con la línea EDEN_PACKET3, sin credenciales. No requiere activar
--send, cambiar D1, tocar Cloudflare ni modificar el servidor de juegos.
