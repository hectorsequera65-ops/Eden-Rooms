const respond = (body, status = 200) => Response.json(body, {
  status,
  headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }
});

export async function onRequestGet({ request, env }) {
  if (!env.DB) return respond({ error: 'Base de datos no configurada' }, 503);
  const id = new URL(request.url).searchParams.get('id');
  if (!id || !/^[a-zA-Z0-9_-]{1,100}$/.test(id)) {
    return respond({ error: 'ID de sala invalido' }, 400);
  }

  try {
    const authorized = await env.DB.prepare(
      'SELECT nombre FROM salas_autorizadas WHERE sala_id = ? AND autorizada = 1'
    ).bind(id).first();
    if (!authorized) return respond({ disponible: false, jugadores: [] }, 404);

    const row = await env.DB.prepare(
      'SELECT nombre_sala, jugadores_json, actualizado_en FROM versiones_salas WHERE sala_id = ?'
    ).bind(id).first();

    if (!row) return respond({ disponible: false, jugadores: [] });
    const age = Date.now() - Date.parse(row.actualizado_en);
    if (!Number.isFinite(age) || age < -30000 || age > 120000) {
      return respond({ disponible: false, jugadores: [] });
    }

    const jugadores = JSON.parse(row.jugadores_json);
    if (!Array.isArray(jugadores)) throw new Error('Datos invalidos');
    return respond({
      disponible: true,
      sala_id: id,
      sala: row.nombre_sala,
      consultado_en: row.actualizado_en,
      jugadores
    });
  } catch {
    return respond({ error: 'No se pudieron consultar las versiones' }, 503);
  }
}
