# Acceso controlado del recolector a Cloudflare Pages (propuesta sin desplegar)

## Diagnóstico y alcance de la revisión

Incidente reportado desde Ubuntu: curl obtiene 200 en
https://eden-rooms.pages.dev/api/autorizaciones, urllib recibe 403 / Error 1010 /
browser_signature_banned. Ese diagnóstico coincide con Browser Integrity Check
(BIC) rechazando el User-Agent Python-urllib predeterminado.

Se revisó la documentación oficial vigente; NO se pudieron inspeccionar reglas,
Security Events ni la configuración privada del proyecto: la herramienta del
navegador no pudo abrir el panel. No se dispone de un Ray ID, hora UTC ni IP de
salida del incidente para correlacionarlo. No se atribuye el bloqueo a una regla
personalizada concreta. Tampoco se ha probado el arreglo desde el Ubuntu afectado.
No se cambiaron reglas, bindings, secretos ni despliegues remotos.

Fuentes oficiales consultadas:
- https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1010/
- https://developers.cloudflare.com/pages/platform/known-issues/#browser-integrity-check-on-pages
- https://developers.cloudflare.com/pages/configuration/custom-domains/#zone-settings
- https://developers.cloudflare.com/waf/tools/browser-integrity-check/

Pages ejecuta BIC en la zona gestionada por Cloudflare pages.dev, también para
sus dominios personalizados. El propietario no puede desactivarlo ni omitirlo
con reglas de su zona. Esos rechazos pueden no figurar en Security Events de su
zona ni en logs de Functions. Crear un Skip en el WAF de otra zona no resuelve
este control de Pages; cambiar solo a un dominio propio apuntando a Pages tampoco.

La solución recomendada por Cloudflare es identificar explícitamente la
aplicación mediante un User-Agent descriptivo. No requiere imitar un navegador,
rotar firmas, cookies de navegador, desactivar BIC o permitir toda la IP.

## Cambios preparados

collector.py envía en GET y POST:

```
User-Agent: EdenRoomsCollector/1.1 (+https://github.com/hectorsequera65-ops/Eden-Rooms)
Accept: application/json
```

Ese encabezado identifica el software, NO autentica al recolector. Se mantienen
TLS y el WAF. No se hace fallback a curl ni se cambian firmas ante un bloqueo.
Los errores incluyen método, ruta, código HTTP, motivo, CF-Ray y detalle del
cuerpo (JSON o texto HTML simplificado). Retry-After se registra cuando existe;
no se implementa un reintento inmediato. Se leen hasta 8192 bytes de error y se
limita el detalle mostrado a 800 caracteres; los valores conocidos de las dos
claves se ocultan. No se vuelcan encabezados de solicitud, payloads ni URLs de
redirección. Los redirects se rechazan para no reenviar credenciales. Usar la
URL HTTPS canónica en --base-url. --once y --check-api salen con código 1 si falla
la consulta; modo continuo conserva el intervalo de rondas.

### Autorización independiente, opcional y con alcance de lectura

Para controlar quién consulta la lista, la Function admite un secreto separado:
AUTORIZACIONES_API_KEY. Solo cuando está configurado exige X-Collector-Key en
GET /api/autorizaciones y responde 401 antes de consultar D1 si no coincide.
El recolector toma la misma variable del entorno y envía el encabezado solo en
esa petición. VERSIONES_API_KEY continúa reservada para POST de versiones;
X-Collector-Key NO concede acceso de escritura. No usar el User-Agent como clave.

Sin configurar AUTORIZACIONES_API_KEY se conserva la lista pública actual.
Esto permite actualizar primero el cliente Ubuntu y comprobar la corrección
contra la API actual sin desplegar Pages. No se ha generado ni publicado ninguna
clave. Para activar la protección más adelante, generar una clave aleatoria
independiente y guardarla como secreto en Pages y en /etc/eden-rooms-enet.env
(modo 600). No poner secretos en Git, comandos con literales ni archivos públicos.
Coordinar Function y cliente en el despliegue posterior: desde ese momento curl
sin credenciales recibirá 401. Los lectores legítimos existentes necesitan la
clave; no se protege el resto del sitio ni se rompe el navegador de salas, que
consume /api/rooms. La clave de lectura no evita un bloqueo previo en el edge:
User-Agent correcto y autenticación son requisitos separados.

## Revisión de seguridad pendiente en la cuenta (sin aplicar cambios ahora)

1. Desde el Ubuntu afectado registrar hora UTC, host, ruta, método, IP pública
   de salida y CF-Ray. Repetir solo con --check-api del cliente nuevo.
2. En Workers & Pages comprobar el proyecto/host correctos; para un dominio
   personalizado, revisar además la zona propietaria, reglas WAF ordenadas,
   configuración de BIC, controles de bots, rate limiting y políticas Access.
   Buscar el Ray ID en Security Events. Su ausencia no descarta BIC de Pages.
3. Distinguir resultados: 1010 en edge, 401 de la Function por clave, 403 de otra
   regla, 429 por límite o 503 por D1 no son el mismo problema. Conservar el ID de
   regla y el producto que efectivamente bloquea antes de proponer una excepción.
4. Si el nuevo User-Agent obtiene JSON 200, no hace falta ninguna excepción WAF.
   Mantener BIC, reglas gestionadas y límites del sitio.
5. Solo si un evento demuestra una regla PROPIA bloqueando al recolector, preparar
   una excepción a ese control concreto con host exacto, método GET, ruta exacta
   /api/autorizaciones e IP fija de salida del Ubuntu. Usar /32 para IPv4 o /128
   para IPv6. No incluir POST ni todo /api ni todas las reglas. Mantener autenticación
   de lectura, límites y registro. Una condición de User-Agent es solo un filtro
   adicional, no una prueba de identidad. No crear reglas con IPs de ejemplo.
6. No aplicar un Skip de BIC a pages.dev: no es una zona controlada por la cuenta.
   Si se exige control completo del BIC, evaluar posteriormente un Worker con
   dominio/ruta en zona propia y autenticación; workers.dev también tiene ese
   control gestionado. No forma parte de este cambio ni requiere tocar eden-sala.

## Prueba posterior a revisión, sin conexión a salas ni escrituras

En un checkout de test/enet-versions-sralcer actualizado:

```sh
python3 backend/enet/collector.py \
  --base-url https://eden-rooms.pages.dev --check-api
```

Éxito: JSON {"ok": true, "salas": N} y salida 0. No abre ENet ni publica versiones.
Usa AUTORIZACIONES_API_KEY del entorno solo si ya se habilitó la protección.
No activar --send para esta comprobación. No requiere recompilar el cliente C:
la corrección está en Python y el nombre sralcer permanece igual.

Verificación antes de desplegar: GET con clave correcta permite lectura; sin
clave o con clave incorrecta devuelve 401 cuando está activada. POST sin la
clave de escritura continúa rechazado. Home y /api/rooms conservan sus controles.
Si algo falla, registrar el diagnóstico acotado; no desactivar protecciones.
Para revertir el control opcional, quitar el secreto de lectura en un cambio
posterior aprobado devuelve el endpoint al comportamiento público anterior.
