import {enrichRooms} from '../../lib/player-versions.js';
import {isEnetPreview, scheduledPreview, isScheduledProduction, productionStorage, previewStorage, PREVIEW_SNAPSHOTS, PRODUCTION_SNAPSHOTS} from '../../lib/enet-preview.js';
import {lobbyRoomId, listEligibleLobbyRooms, readLobby} from '../../lib/public-lobby.js';

import {knownVersion, mergeVersionPlayers, snapshotFresh, SCHEDULED_VERSION_TTL_MS} from '../../assets/player-versions.js';

async function publishedRooms(lobby, rooms, db, table, enabled) {
  const eligible = listEligibleLobbyRooms(lobby);
  const now = Date.now();
  let snapshots = new Map();
  if (db && eligible.size) try {
    const {results} = await db.prepare(
      `SELECT sala_id,jugadores_json,actualizado_en FROM ${table}
       WHERE sala_id IN (SELECT value FROM json_each(?))`
    ).bind(JSON.stringify([...eligible.keys()])).all();
    snapshots = new Map(results.map(row => [row.sala_id, row]));
  } catch {
    // Keep the directory and manual queries available if scheduled storage is unavailable.
  }
  return rooms.map((room, index) => {
    const id = lobbyRoomId(room);
    if (eligible.get(id) !== lobby[index]) return {...room, versionsRoomId:room.versionsRoomId ?? null, enetVersionsRoomId:null};
    const registered = {...room, versionsRoomId:room.versionsRoomId ?? id, enetVersionsRoomId:id,
      ...(enabled ? {scheduledVersionsAt:null} : {})};
    const snapshot = snapshots.get(id);
    if (!snapshot) return registered;
    try {
      const observations = JSON.parse(snapshot.jugadores_json);
      if (!snapshotFresh(snapshot.actualizado_en, now, Infinity) ||
          !observations.some(player => knownVersion(player?.version))) return registered;
      if (!Array.isArray(room.players) || !snapshotFresh(snapshot.actualizado_en, now, SCHEDULED_VERSION_TTL_MS)) {
        return {...registered, scheduledVersionsAt:snapshot.actualizado_en};
      }
      const players = mergeVersionPlayers(room.players, observations,
        {observedAt:snapshot.actualizado_en, now, scheduled:true});
      return {...registered, players:players.map((player, i) => {
        const previous = room.players[i];
        if (player.gameVersionSource !== 'enet-scheduled') return previous;
        if (previous.gameVersionSource === 'enet' &&
            snapshotFresh(previous.gameVersionObservedAt, now) &&
            Date.parse(previous.gameVersionObservedAt) >= Date.parse(player.gameVersionObservedAt)) return previous;
        return player;
      }),
        scheduledVersionsAt:snapshot.actualizado_en};
    } catch {
      return registered;
    }
  });
}

export async function onRequestGet({request, env} = {}) {
  try {
    const lobby = await readLobby();
    let rooms;
    if (request && env && isEnetPreview(request, env)) {
      const enabled = scheduledPreview(request, env);
      rooms = await publishedRooms(lobby, lobby, enabled ? await previewStorage(env) : null, PREVIEW_SNAPSHOTS, enabled);
    } else {
      rooms = await enrichRooms(lobby, env?.DB);
      if (request && env && isScheduledProduction(request, env)) {
        const db = await productionStorage(env);
        rooms = await publishedRooms(lobby, rooms, db, PRODUCTION_SNAPSHOTS, true);
      }
    }
    return Response.json({rooms}, {headers:{'Cache-Control':'public, max-age=5'}});
  } catch {
    return Response.json({error:'No se pudo consultar la API de Eden'}, {status:502});
  }
}
