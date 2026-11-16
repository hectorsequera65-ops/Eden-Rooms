import {mergeVersionPlayers, snapshotFresh} from '../assets/player-versions.js';
export const enrichPlayers = mergeVersionPlayers;

export async function enrichRooms(rooms, db, now = Date.now()) {
  if (!db) return rooms;
  try {
    const { results } = await db.prepare(`
      SELECT a.sala_id, e.direccion, e.puerto, v.jugadores_json, v.actualizado_en
      FROM salas_autorizadas a
      INNER JOIN salas_endpoints e ON e.sala_id = a.sala_id
      LEFT JOIN versiones_salas v ON v.sala_id = a.sala_id
      WHERE a.autorizada = 1
    `).all();
    return rooms.map(room => {
      const matches = (results || []).filter(row => row.direccion === room.address && Number(row.puerto) === Number(room.port));
      if (matches.length !== 1) return room;
      const row = matches[0];
      if (typeof row.sala_id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(row.sala_id)) return room;
      const registered = {...room, versionsRoomId: row.sala_id};
      if (!snapshotFresh(row.actualizado_en, now)) return registered;
      try {
        return {...registered, players: enrichPlayers(room.players, JSON.parse(row.jugadores_json), {observedAt: row.actualizado_en, now})};
      } catch { return registered; }
    });
  } catch { return rooms; }
}
