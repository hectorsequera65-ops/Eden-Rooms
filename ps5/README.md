# Eden Rooms PS5 — publicación en Cloudflare Pages

El sitio PS5 está en `ps5/index.html` dentro del repositorio `hectorsequera65-ops/Eden-Rooms`. La web original de la raíz permanece intacta.

## Crear un proyecto independiente

1. Cloudflare → Workers & Pages → Create → Pages → Connect to Git.
2. Elegí GitHub y el repositorio `hectorsequera65-ops/Eden-Rooms`, rama `main`.
3. Nombre del proyecto: `eden-rooms-ps5` (si está disponible).
4. Framework preset: `None`; build command: vacío; **Build output directory: `ps5`**.
5. **Root directory: `/` (raíz del repositorio)**. No la cambies a `ps5`: las funciones API se encuentran en `functions/api/rooms.js` en la raíz.
6. Deploy. Verificá `https://eden-rooms-ps5.pages.dev/` y `https://eden-rooms-ps5.pages.dev/api/rooms`.

Si el nombre de proyecto no está disponible, necesitaremos cambiar `deeplinkUri` en `ps5-browser-app/assets/param.json` y recompilar el instalador.

## Funciones y límites

La página usa el mismo endpoint `/api/rooms` que la versión general, basado en el directorio público de Eden. Muestra salas y sus IP/puertos; el botón **Conectar PS5** presenta los datos para ingresarlos en ProsperoEden. **Todavía no modifica archivos de PS5** ni tiene servicio local instalado.

La web utiliza botones grandes y estilos de foco visibles para navegación con mando; la compatibilidad exacta del navegador PS5 y DualSense debe probarse en la consola.
