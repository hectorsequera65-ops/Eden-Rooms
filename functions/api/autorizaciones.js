// Lista publica de salas aprobadas manualmente. No permite cambios desde la web.
// Solo publica IP:puerto cuando fueron registrados por el administrador en D1.
export async function onRequestGet({ env }) {
  const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
  if (!env.DB) return Response.json({ error: 'Base de datos no configurada' }, { status: 503, headers });
  try {
    const { results } = await env.DB.prepare(
      `SELECT a.sala_id, a.nombre, e.direccion, e.puerto
       FROM salas_autorizadas a
       LEFT JOIN salas_endpoints e ON e.sala_id = a.sala_id
       WHERE a.autorizada = 1 ORDER BY a.nombre LIMIT 200`
    ).all();
    return Response.json({ salas: (results || []).map(r => ({
      id: String(r.sala_id), nombre: String(r.nombre), autorizada: true,
      direccion: r.direccion == null ? null : String(r.direccion),
      puerto: r.puerto == null ? null : Number(r.puerto)
    })) }, { headers });
  } catch {
    // Compatibilidad durante la migracion de D1: conserva las autorizaciones existentes.
    try {
      const { results } = await env.DB.prepare(
        'SELECT sala_id, nombre FROM salas_autorizadas WHERE autorizada = 1 ORDER BY nombre LIMIT 200'
      ).all();
      return Response.json({ salas: (results || []).map(r => ({
        id: String(r.sala_id), nombre: String(r.nombre), autorizada: true,
        direccion: null, puerto: null
      })) }, { headers });
    } catch {
      return Response.json({ error: 'No se pudieron consultar autorizaciones' }, { status: 503, headers });
    }
  }
}
