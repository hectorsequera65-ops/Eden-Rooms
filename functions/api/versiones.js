const json = (data, status = 200) => Response.json(data, {
  status,
  headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }
});

export async function onRequestGet({ env }) {
  if (!env.DB) return json({ error: 'Base de datos no configurada' }, 503);
  try {
    const row = await env.DB.prepare(
      'SELECT nombre_sala, jugadores_json, actualizado_en FROM versiones_salas WHERE sala_id = ?'
    ).bind('eden-rooms-test').first();
    if (!row) return json({ disponible: false, jugadores: [] });
    const age = Date.now() - Date.parse(row.actualizado_en);
    if (!Number.isFinite(age) || age < -30000 || age > 120000) {
      return json({ disponible: false, jugadores: [] });
    }
    return json({
      disponible: true,
      sala: row.nombre_sala,
      consultado_en: row.actualizado_en,
      jugadores: JSON.parse(row.jugadores_json)
    });
  } catch {
    return json({ error: 'No se pudieron consultar las versiones' }, 503);
  }
}

export async function onRequestPost({ request, env }) {
  if (!env.DB || !env.VERSIONES_API_KEY) return json({ error: 'Servicio no configurado', falta_db: !Boolean(env.DB), falta_clave: !Boolean(env.VERSIONES_API_KEY) }, 503);
  const received = request.headers.get('X-API-Key') || '';
  const expected = env.VERSIONES_API_KEY;
  const encoder = new TextEncoder();
  const a = encoder.encode(received), b = encoder.encode(expected);
  let mismatch = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    mismatch |= (a[i] || 0) ^ (b[i] || 0);
  }
  if (mismatch !== 0 || !received) return json({ error: 'No autorizado' }, 401);
  if ((request.headers.get('content-type') || '').split(';')[0].trim() !== 'application/json') {
    return json({ error: 'Se requiere application/json' }, 415);
  }
  const raw = await request.text();
  if (raw.length > 20000) return json({ error: 'Datos demasiado grandes' }, 413);
  let data;
  try { data = JSON.parse(raw); } catch { return json({ error: 'JSON invalido' }, 400); }
  if (data?.sala !== 'Eden Rooms Test' || !Array.isArray(data.jugadores) || data.jugadores.length > 32) {
    return json({ error: 'Sala o jugadores invalidos' }, 400);
  }
  const when = Date.parse(data.consultado_en);
  if (!Number.isFinite(when) || Math.abs(Date.now() - when) > 120000) {
    return json({ error: 'Datos vencidos' }, 400);
  }
  const players = data.jugadores.map(p => ({
    nombre: String(p.nombre || '').slice(0, 80),
    juego: String(p.juego || '').slice(0, 160),
    version: String(p.version || '').slice(0, 40)
  })).filter(p => p.nombre && p.nombre !== 'EdenRoomsConsulta');
  try {
    await env.DB.prepare(
      'INSERT INTO versiones_salas (sala_id, nombre_sala, jugadores_json, actualizado_en) VALUES (?, ?, ?, ?) ON CONFLICT(sala_id) DO UPDATE SET nombre_sala=excluded.nombre_sala, jugadores_json=excluded.jugadores_json, actualizado_en=excluded.actualizado_en'
    ).bind('eden-rooms-test', 'Eden Rooms Test', JSON.stringify(players), new Date(when).toISOString()).run();
    return json({ ok: true, jugadores: players.length });
  } catch {
    return json({ error: 'No se pudieron guardar los datos' }, 503);
  }
}
