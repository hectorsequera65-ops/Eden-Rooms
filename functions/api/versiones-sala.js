import {allowedRoom, previewOnly} from '../../lib/enet-jobs.js';
import {isLobbyRoomId} from '../../lib/public-lobby.js';
import {readEnetSnapshot} from '../../lib/enet-snapshot.js';
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
    const preview = previewOnly(request, env);
    if (isLobbyRoomId(id) && !preview) return respond({disponible:false, jugadores:[]}, 404);
    const authorized = preview ? await allowedRoom(env.DB, id) : await env.DB.prepare(
      'SELECT a.nombre,e.direccion,e.puerto FROM salas_autorizadas a INNER JOIN salas_endpoints e ON e.sala_id=a.sala_id WHERE a.sala_id = ? AND a.autorizada = 1'
    ).bind(id).first();
    if (!authorized) return respond({ disponible: false, jugadores: [] }, 404);

    const row = env.ENET_JOBS_ENABLED === 'true'
      ? await readEnetSnapshot(env.DB, id, authorized.direccion, authorized.puerto)
      : await env.DB.prepare(
        'SELECT nombre_sala, jugadores_json, actualizado_en FROM versiones_salas WHERE sala_id = ?'
      ).bind(id).first();

    if (!row) return respond({ disponible: false, sala_id: id, jugadores: [] });
    const age = Date.now() - Date.parse(row.actualizado_en);
    if (!Number.isFinite(age) || age < -30000 || age >= 120000) {
      return respond({ disponible: false, sala_id: id, jugadores: [] });
    }

    const jugadores = JSON.parse(row.jugadores_json);
    if (!Array.isArray(jugadores)) throw new Error('Datos invalidos');
    return respond({
      disponible: true,
      sala_id: id,
      sala: row.nombre_sala,
      consultado_en: row.actualizado_en,
      expira_en: new Date(Date.parse(row.actualizado_en) + 120000).toISOString(),
      endpoint: { direccion: authorized.direccion, puerto: Number(authorized.puerto) },
      jugadores
    });
  } catch {
    return respond({ error: 'No se pudieron consultar las versiones' }, 503);
  }
}
