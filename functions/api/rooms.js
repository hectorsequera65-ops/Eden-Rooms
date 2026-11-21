import {enrichRooms} from '../../lib/player-versions.js';
import {previewOnly} from '../../lib/enet-jobs.js';
import {lobbyRoomId, listEligibleLobbyRooms, readLobby} from '../../lib/public-lobby.js';

import {mergeVersionPlayers, SCHEDULED_VERSION_TTL_MS} from '../../assets/player-versions.js';

async function previewRooms(lobby, env) {
  if (env.ENET_SCHEDULED_ENABLED !== 'true' || !env.DB) {
    return lobby.map(room => ({...room, versionsRoomId:lobbyRoomId(room)}));
  }
  const eligible = listEligibleLobbyRooms(lobby);
  const now = Date.now();
  let snapshots = new Map();
  try {
    const {results} = await env.DB.prepare(
      'SELECT sala_id,jugadores_json,actualizado_en FROM enet_scheduled_snapshots WHERE actualizado_en > ?'
    ).bind(new Date(now - SCHEDULED_VERSION_TTL_MS).toISOString()).all();
    snapshots = new Map(results.map(row => [row.sala_id, row]));
  } catch {
    // Keep the directory and manual queries available if scheduled storage is unavailable.
  }
  return lobby.map(room => {
    const id = lobbyRoomId(room);
    const registered = {...room, versionsRoomId:eligible.get(id) === room ? id : null};
    const snapshot = snapshots.get(registered.versionsRoomId);
    if (!snapshot) return registered;
    try {
      const players = mergeVersionPlayers(room.players, JSON.parse(snapshot.jugadores_json),
        {observedAt:snapshot.actualizado_en, now, scheduled:true});
      return {...registered, players};
    } catch {
      return registered;
    }
  });
}

export async function onRequestGet({request, env} = {}) {
  try {
    const lobby = await readLobby();
    const rooms = request && previewOnly(request, env)
      ? await previewRooms(lobby, env)
      : await enrichRooms(lobby, env?.DB, Date.now(), env?.ENET_JOBS_ENABLED === 'true');
    return Response.json({rooms}, {headers:{'Cache-Control':'public, max-age=5'}});
  } catch {
    return Response.json({error:'No se pudo consultar la API de Eden'}, {status:502});
  }
}
