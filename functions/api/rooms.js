import {enrichRooms} from '../../lib/player-versions.js';
import {previewOnly} from '../../lib/enet-jobs.js';
import {lobbyRoomId, readLobby} from '../../lib/public-lobby.js';

export async function onRequestGet({request, env} = {}) {
  try {
    const lobby = await readLobby();
    const rooms = request && previewOnly(request, env)
      ? lobby.map(room => ({...room, versionsRoomId:lobbyRoomId(room)}))
      : await enrichRooms(lobby, env?.DB, Date.now(), env?.ENET_JOBS_ENABLED === 'true');
    return Response.json({rooms}, {headers:{'Cache-Control':'public, max-age=5'}});
  } catch {
    return Response.json({error:'No se pudo consultar la API de Eden'}, {status:502});
  }
}
