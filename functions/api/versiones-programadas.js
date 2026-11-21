import {previewOnly, respond} from '../../lib/enet-jobs.js';
import {findLobbyRoom, listEligibleLobbyRooms, readLobby} from '../../lib/public-lobby.js';
import {authorizeVersionRequest, normalizeVersionSnapshot} from '../../lib/version-snapshots.js';

function guard(request, env) {
  if (!previewOnly(request, env) || env.ENET_SCHEDULED_ENABLED !== 'true') {
    return respond({error:'No disponible'}, 404);
  }
  return authorizeVersionRequest(request, env) ||
    (!env.DB ? respond({error:'Base de datos no configurada'}, 503) : null);
}

export async function onRequestGet({request, env}) {
  const denied = guard(request, env);
  if (denied) return denied;
  try {
    const lobby = await readLobby({fresh:true});
    return respond({salas:[...listEligibleLobbyRooms(lobby)].map(([id, room]) => ({
      id, direccion:room.address, puerto:Number(room.port), hasPassword:false
    }))});
  } catch {
    return respond({error:'Lobby no disponible'}, 503);
  }
}

export async function onRequestPost({request, env}) {
  const denied = guard(request, env);
  if (denied) return denied;
  if ((request.headers.get('content-type') || '').split(';')[0].trim() !== 'application/json') {
    return respond({error:'Se requiere JSON'}, 415);
  }
  const raw = await request.text();
  if (raw.length > 20000) return respond({error:'Datos demasiado grandes'}, 413);
  let data;
  try { data = JSON.parse(raw); }
  catch { return respond({error:'JSON inválido'}, 400); }
  const now = Date.now();
  const normalized = normalizeVersionSnapshot(data, env, now);
  if (normalized.error) return normalized.error;
  const {id, when, players} = normalized;
  if (!/^lobby-(?:\d{1,3}-){4}\d{1,5}$/.test(id) || when > now + 30000) {
    return respond({error:'Identidad o fecha inválida'}, 400);
  }
  try {
    if (!await findLobbyRoom(id)) return respond({error:'Sala pública no disponible'}, 409);
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM enet_scheduled_snapshots WHERE actualizado_en < ?`)
        .bind(new Date(now - 86400000).toISOString()),
      env.DB.prepare(`INSERT INTO enet_scheduled_snapshots(sala_id,jugadores_json,actualizado_en)
        VALUES (?,?,?) ON CONFLICT(sala_id) DO UPDATE SET
        jugadores_json=excluded.jugadores_json,actualizado_en=excluded.actualizado_en
        WHERE excluded.actualizado_en >= enet_scheduled_snapshots.actualizado_en`)
        .bind(id, JSON.stringify(players), new Date(when).toISOString())
    ]);
    return respond({ok:true});
  } catch {
    return respond({error:'No se pudo guardar la muestra'}, 503);
  }
}
