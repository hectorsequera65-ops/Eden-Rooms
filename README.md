# Eden-Rooms

Web de salas públicas con funciones de Cloudflare Pages. La integración local
para versiones ENet está documentada en [backend/enet/README.md](backend/enet/README.md).

El directorio puede mostrar versiones ENet recientes de salas públicas sin
contraseña. Una muestra antigua conserva su fecha, mientras que las versiones
asociadas caducan a los seis minutos. El listado de salas y el chat siguen
disponibles si el almacenamiento ENet falla.

La publicación ENet a producción requiere activación explícita. El plan de
inventario, respaldo, activación y rollback está en el
[runbook de producción](backend/enet/DESPLIEGUE-PRODUCCION.md).
