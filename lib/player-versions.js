// Only enrich unique matches within the same registered room and current game.
export function enrichPlayers(players, observations) {
  if (!Array.isArray(players) || !Array.isArray(observations)) return players;
  const key = (name, game) => JSON.stringify([name, game]);
  const counts = new Map();
  for (const p of players) {
    const k = key(p.nickname, "");
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  return players.map(p => {
    const k = key(p.nickname, "");
    if (!p.nickname || !p.gameName || counts.get(k) !== 1) return p;
    const matches = observations.filter(o => o.nombre === p.nickname);
    if (matches.length !== 1 || matches[0].juego !== p.gameName || !matches[0].version) return p;
    const observation = matches[0];
    if (p.gameId != null && observation.title_id) {
      try {
        if (typeof p.gameId === 'number' && !Number.isSafeInteger(p.gameId)) return p;
        if (BigInt(String(p.gameId)) !== BigInt('0x' + observation.title_id)) return p;
      } catch { return p; }
    }
    // Do not overwrite an explicit version supplied by the lobby.
    if (['gameVersion','game_version','gameVer','game_ver','applicationVersion','application_version']
      .some(field => p[field] != null && String(p[field]).trim())) return p;
    return { ...p, gameVersion: observation.version,
      ...(observation.title_id ? { gameTitleId: observation.title_id } : {}) };
  });
}

export async function enrichRooms(rooms, db, now = Date.now()) {
  if (!db) return rooms;
  try {
    const { results } = await db.prepare(`
      SELECT e.direccion, e.puerto, v.jugadores_json, v.actualizado_en
      FROM versiones_salas v
      INNER JOIN salas_autorizadas a ON a.sala_id = v.sala_id AND a.autorizada = 1
      INNER JOIN salas_endpoints e ON e.sala_id = v.sala_id
    `).all();
    return rooms.map(room => {
      const matches = (results || []).filter(row => row.direccion === room.address && Number(row.puerto) === Number(room.port));
      if (matches.length !== 1) return room;
      const row = matches[0], age = now - Date.parse(row.actualizado_en);
      if (!Number.isFinite(age) || age < -30000 || age > 120000) return room;
      try {
        return { ...room, players: enrichPlayers(room.players, JSON.parse(row.jugadores_json)) };
      } catch { return room; }
    });
  } catch { return rooms; }
}
