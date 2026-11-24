import {mergeVersionPlayers, snapshotFresh} from '../assets/player-versions.js';
export const enrichPlayers = mergeVersionPlayers;

export async function enrichRooms(rooms, db, now = Date.now(), jobGuard = false) {
  if (!db) return rooms;
  try {
    const { results } = await db.prepare(`
      SELECT a.sala_id, e.direccion, e.puerto, v.jugadores_json, v.actualizado_en
      ${jobGuard ? ', j.sala_id AS job_room, j.status AS job_status, j.direccion AS job_address, j.puerto AS job_port' : ''}
      FROM salas_autorizadas a
      INNER JOIN salas_endpoints e ON e.sala_id = a.sala_id
      LEFT JOIN versiones_salas v ON v.sala_id = a.sala_id
      ${jobGuard ? 'LEFT JOIN enet_version_jobs j ON j.sala_id=a.sala_id' : ''}
      WHERE a.autorizada = 1
    `).all();
    return rooms.map(room => {
      const matches = (results || []).filter(row => row.direccion === room.address && Number(row.puerto) === Number(room.port));
      if (matches.length !== 1) return room;
      const row = matches[0];
      if (typeof row.sala_id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(row.sala_id)) return room;
      const registered = {...room, versionsRoomId: row.sala_id};
      if (jobGuard && row.job_room && (row.job_status !== 'done' || row.job_address !== row.direccion || Number(row.job_port) !== Number(row.puerto))) return registered;
      if (!snapshotFresh(row.actualizado_en, now)) return registered;
      try {
        return {...registered, players: enrichPlayers(room.players, JSON.parse(row.jugadores_json), {observedAt: row.actualizado_en, now})};
      } catch { return registered; }
    });
  } catch { return rooms; }
}
