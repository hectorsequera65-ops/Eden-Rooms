// Estado publico de autorizaciones aprobadas; no expone tokens ni direcciones privadas.
export async function onRequestGet({ env }) {
  const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
  if (!env.DB) return Response.json({ error: 'Base de datos no configurada' }, { status: 503, headers });
  try {
    const { results } = await env.DB.prepare(
      'SELECT sala_id, nombre, autorizada FROM salas_autorizadas WHERE autorizada = 1 ORDER BY nombre LIMIT 200'
    ).all();
    return Response.json({
      salas: (results || []).map(r => ({
        id: String(r.sala_id),
        nombre: String(r.nombre),
        autorizada: true
      }))
    }, { headers });
  } catch {
    return Response.json({ error: 'No se pudieron consultar autorizaciones' }, { status: 503, headers });
  }
}
