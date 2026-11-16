export const VERSION_TTL_MS = 120000;
export const VERSION_POLL_MS = 30000;
const VERSION_FIELDS = ['gameVersion','game_version','gameVer','game_ver','applicationVersion','application_version'];
const roomIdValid = id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(id);
export function snapshotFresh(timestamp, now = Date.now()) {
  const age = now - Date.parse(timestamp);
  return Number.isFinite(age) && age >= -30000 && age < VERSION_TTL_MS;
}
export function virtualIp(player) {
  const raw = player.virtual_ip ?? player.fakeIp ?? player.fake_ip ?? player.virtualIp;
  if (raw === undefined || raw === null || raw === '') return undefined;
  const parts = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split('.') : [];
  if (parts.length !== 4 || parts.some(p => !/^\d{1,3}$/.test(String(p)) || Number(p) > 255)) return null;
  return parts.map(Number).join('.');
}
export function withoutEnetVersion(player) {
  if (player.gameVersionSource !== 'enet') return player;
  const result = {...player};
  delete result.gameVersion; delete result.gameTitleId;
  delete result.gameVersionSource; delete result.gameVersionObservedAt;
  return result;
}
export function playerGameVersion(player, now = Date.now()) {
  if (player?.gameVersionSource === 'enet' && !snapshotFresh(player.gameVersionObservedAt, now)) return '';
  for (const key of VERSION_FIELDS) {
    const value = player?.[key];
    if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
  }
  return '';
}
export function playerGameLabel(player) {
  const game = String(player.gameName || '').trim(), version = game ? playerGameVersion(player) : '';
  return game + (version ? ' · v' + version.replace(/^v/i, '') : '');
}
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function playerListMarkup(players) {
  return players.map(player => {
    const game = String(player.gameName || '').trim(), version = game ? playerGameVersion(player) : '';
    return '<div class="player-row"><span class="player-name">👤 ' + escapeHTML(player.nickname || 'Sin nombre') + '</span><span class="player-details">'
      + (game ? '<span class="player-game">' + escapeHTML(game) + '</span>' : '')
      + (version ? '<span class="player-version">Versión ' + escapeHTML(version) + '</span>' : '') + '</span></div>';
  }).join('');
}
export function mergeVersionPlayers(players, observations, {observedAt, now = Date.now()} = {}) {
  if (!Array.isArray(players) || !Array.isArray(observations)) return players;
  const clean = players.map(withoutEnetVersion);
  if (observedAt !== undefined && !snapshotFresh(observedAt, now)) return clean;
  return clean.map(player => {
    if (!player?.nickname || !player.gameName) return player;
    const sameNames = observations.filter(o => o?.nombre === player.nickname);
    const peers = clean.filter(p => p?.nickname === player.nickname);
    const ip = virtualIp(player);
    if (ip === null || sameNames.some(o => virtualIp(o) === null) || peers.some(p => virtualIp(p) === null)) return player;
    let matches = sameNames;
    if (ip !== undefined && sameNames.some(o => virtualIp(o) !== undefined)) {
      matches = sameNames.filter(o => virtualIp(o) === ip);
      if (peers.filter(p => virtualIp(p) === ip).length !== 1) return player;
    } else if (peers.length !== 1 || sameNames.length !== 1) return player;
    if (matches.length !== 1) return player;
    const observation = matches[0];
    if (virtualIp(observation) === null || observation.juego !== player.gameName || !String(observation.version || '').trim()) return player;
    if (player.gameId != null && observation.title_id) {
      try {
        if (typeof player.gameId === 'number' && !Number.isSafeInteger(player.gameId)) return player;
        if (BigInt(String(player.gameId)) !== BigInt('0x' + observation.title_id)) return player;
      } catch { return player; }
    }
    if (playerGameVersion(player, now)) return player; // Keep an explicit version from the lobby.
    return {...player, gameVersion: String(observation.version),
      ...(observation.title_id ? {gameTitleId: observation.title_id} : {}),
      ...(observedAt !== undefined ? {gameVersionSource: 'enet', gameVersionObservedAt: observedAt} : {})};
  });
}
export function applyRoomSnapshot(room, snapshot, now = Date.now()) {
  const players = Array.isArray(room.players) ? room.players.map(withoutEnetVersion) : room.players;
  const clean = {...room, players};
  if (!roomIdValid(room.versionsRoomId) || snapshot?.sala_id !== room.versionsRoomId
      || snapshot.disponible !== true || !Array.isArray(snapshot.jugadores) || !snapshotFresh(snapshot.consultado_en, now)) return clean;
  if (snapshot.endpoint && (snapshot.endpoint.direccion !== room.address || Number(snapshot.endpoint.puerto) !== Number(room.port))) return clean;
  return {...clean, players: mergeVersionPlayers(players, snapshot.jugadores, {observedAt: snapshot.consultado_en, now})};
}
export function createVersionsClient({fetcher = (...args) => fetch(...args), now = () => Date.now(), timeoutMs = 5000} = {}) {
  const entries = new Map();
  async function fetchRoom(id) {
    let entry = entries.get(id);
    if (!entry) { entry = {snapshot: null, nextFetch: 0, pending: null}; entries.set(id, entry); }
    if (entry.pending) return entry.pending;
    if (now() < entry.nextFetch) return;
    const controller = new AbortController(); entry.controller = controller;
    entry.nextFetch = now() + VERSION_POLL_MS;
    entry.pending = (async () => {
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetcher('/api/versiones-sala?id=' + encodeURIComponent(id), {cache:'no-store', signal:controller.signal});
        if (response.status === 404) { entry.snapshot = null; return; }
        if (!response.ok) throw Error('Versions API ' + response.status);
        const data = await response.json();
        entry.snapshot = data?.sala_id === id && data.disponible === true && Array.isArray(data.jugadores)
          && snapshotFresh(data.consultado_en, now()) ? data : null;
        if (entry.snapshot) entry.nextFetch = Math.min(entry.nextFetch, Date.parse(data.consultado_en) + VERSION_TTL_MS);
      } catch { /* A network failure retains only a still-fresh cached snapshot. */ }
      finally { clearTimeout(timeout); entry.pending = null; entry.controller = null; }
    })();
    return entry.pending;
  }
  return {
    async refresh(rooms) {
      const ids = [...new Set(rooms.filter(r => Array.isArray(r.players) && r.players.length && roomIdValid(r.versionsRoomId)).map(r => r.versionsRoomId))];
      await Promise.all(ids.map(fetchRoom));
    },
    decorate(room) { return applyRoomSnapshot(room, entries.get(room.versionsRoomId)?.snapshot, now()); },
    nextExpiry() {
      const times = [...entries.values()].filter(e => e.snapshot && snapshotFresh(e.snapshot.consultado_en, now()))
        .map(e => Date.parse(e.snapshot.consultado_en) + VERSION_TTL_MS);
      return times.length ? Math.min(...times) : null;
    },
    retain(rooms) {
      const ids = new Set(rooms.map(r => r.versionsRoomId));
      for (const [id, entry] of entries) if (!ids.has(id)) { entry.controller?.abort(); entries.delete(id); }
    },
    abort() { for (const entry of entries.values()) entry.controller?.abort(); }
  };
}
