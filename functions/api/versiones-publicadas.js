import {knownVersion, snapshotFresh} from '../../assets/player-versions.js';
import {isEnetPreview, isScheduledProduction, productionStorage, previewStorage, PREVIEW_SNAPSHOTS, PRODUCTION_SNAPSHOTS, respond} from '../../lib/enet-preview.js';
import {findLobbyRoom} from '../../lib/public-lobby.js';

export async function onRequest({request, env}) {
  const production = isScheduledProduction(request, env);
  if (!production && !isEnetPreview(request, env)) return respond({error:'No disponible'}, 404);
  if (request.method !== 'GET') {
    return new Response(null, {status:405, headers:{Allow:'GET', 'Cache-Control':'no-store'}});
  }

  const id = new URL(request.url).searchParams.get('id');
  if (!/^lobby-(?:[0-9]{1,3}-){4}[0-9]{1,5}$/.test(id ?? '')) return respond({error:'ID de sala inválido'}, 400);
  const table = production ? PRODUCTION_SNAPSHOTS : PREVIEW_SNAPSHOTS;
  const db = production ? await productionStorage(env) : await previewStorage(env);
  if (!db) return respond({error:'Base de datos no configurada'}, 503);

  const unavailable = {disponible:false, sala_id:id, jugadores:[]};
  try {
    // Recheck that the endpoint still belongs to a public, unambiguous lobby room.
    const room = await findLobbyRoom(id);
    if (!room) return respond(unavailable);

    const row = await db.prepare(
      `SELECT jugadores_json, actualizado_en FROM ${table} WHERE sala_id = ?`
    ).bind(id).first();
    if (!row || !snapshotFresh(row.actualizado_en, Date.now(), Infinity)) return respond(unavailable);

    const players = JSON.parse(row.jugadores_json);
    if (!Array.isArray(players)) throw Error('Datos inválidos');
    const jugadores = players.map(({nombre, juego, version, virtual_ip, title_id}) =>
      ({nombre, juego, version, virtual_ip, title_id}));
    if (!jugadores.some(player => knownVersion(player.version))) return respond(unavailable);
    return respond({
      disponible:true,
      sala_id:id,
      consultado_en:row.actualizado_en,
      endpoint:{direccion:room.direccion, puerto:room.puerto},
      jugadores
    });
  } catch {
    return respond({error:'No se pudieron consultar las versiones'}, 503);
  }
}
