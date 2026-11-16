export const VERSION_TTL_MS = 120000;
export const VERSION_POLL_MS = 2000;
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
export function createVersionsClient({fetcher = (...args) => fetch(...args), now = () => Date.now(), timeoutMs = 5000, onChange = () => {}} = {}) {
  const entries = new Map();
  function update(entry, patch) {
    const changed = Object.keys(patch).some(key => ['snapshot','phase','deadline','retryAt'].includes(key) && entry[key] !== patch[key]);
    Object.assign(entry, patch);
    if (changed) onChange();
  }
  function failed(entry, delay = 15000) {
    update(entry, {phase:'error', jobActive:false, deadline:null, retryAt:now() + Math.max(0, Math.min(60000, delay)), nextFetch:Infinity});
  }
  async function fetchRoom(id) {
    let entry = entries.get(id);
    if (!entry) { entry = {snapshot:null, nextFetch:0, pending:null, phase:'idle', jobActive:false, deadline:null, retryAt:0}; entries.set(id, entry); }
    if (entry.pending) return entry.pending;
    if (entry.jobActive && now() >= entry.deadline) { failed(entry); return; }
    if (now() < entry.nextFetch) return;
    const controller = new AbortController(); entry.controller = controller; entry.paused = false;
    if (!entry.jobActive) update(entry, {phase:'loading'});
    entry.pending = (async () => {
      let timedOut = false;
      const timeout = setTimeout(() => {timedOut = true; controller.abort();}, timeoutMs);
      const options = {cache:'no-store', signal:controller.signal};
      async function readSnapshot() {
        const response = await fetcher('/api/versiones-sala?id=' + encodeURIComponent(id), options);
        if (!response.ok) throw Error('Versions API unavailable');
        const data = await response.json();
        const snapshot = data?.sala_id === id && data.disponible === true && Array.isArray(data.jugadores)
          && snapshotFresh(data.consultado_en, now()) ? data : null;
        update(entry, {snapshot});
        if (snapshot) {
          update(entry, {phase:'ready', jobActive:false, deadline:null, nextFetch:Date.parse(snapshot.consultado_en) + VERSION_TTL_MS});
          return true;
        }
        return false;
      }
      async function queueState(response) {
        const data = await response.json();
        if ((!response.ok && response.status !== 429) || data?.sala_id && data.sala_id !== id) throw Error('Queue unavailable');
        if (data.estado === 'listo') {
          if (!await readSnapshot()) throw Error('No fresh result');
        } else if (data.estado === 'pendiente' || data.estado === 'consultando') {
          const wait = Math.min(45000, Number(data.espera_ms));
          if (!Number.isFinite(wait) || wait <= 0) { failed(entry); return; }
          const deadline = Math.min(entry.deadline ?? Infinity, now() + wait);
          update(entry, {phase:'loading', jobActive:true, deadline, nextFetch:now() + VERSION_POLL_MS});
        } else if (data.estado === 'error' || response.status === 429) failed(entry, Number(data.reintentar_en_ms) || 15000);
        else throw Error('Invalid job status');
      }
      try {
        if (entry.jobActive) {
          await queueState(await fetcher('/api/versiones-consultar?id=' + encodeURIComponent(id), options));
        } else if (!await readSnapshot()) {
          await queueState(await fetcher('/api/versiones-consultar', {...options, method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({sala_id:id})}));
        }
      } catch {
        if (!entry.paused || timedOut) failed(entry);
      } finally { clearTimeout(timeout); entry.pending = null; entry.controller = null; }
    })();
    return entry.pending;
  }
  return {
    async refresh(rooms) {
      const ids = [...new Set(rooms.filter(r => Array.isArray(r.players) && r.players.length && roomIdValid(r.versionsRoomId)).map(r => r.versionsRoomId))];
      await Promise.all(ids.map(fetchRoom));
    },
    decorate(room) { return applyRoomSnapshot(room, entries.get(room.versionsRoomId)?.snapshot, now()); },
    status(id) {
      const entry = entries.get(id);
      if (!entry || entry.phase === 'ready' || entry.phase === 'idle') return null;
      if (entry.phase === 'error' || entry.jobActive && now() >= entry.deadline) return {text:'No se pudieron consultar las versiones.', retry:true, canRetry:now() >= entry.retryAt};
      return {text:'Consultando versiones…', retry:false};
    },
    retry(id) {
      const entry = entries.get(id);
      if (entry && entry.phase === 'error' && now() >= entry.retryAt) {
        update(entry, {phase:'idle', jobActive:false, deadline:null, nextFetch:0});
      }
    },
    nextExpiry() {
      const times = [];
      for (const entry of entries.values()) {
        if (entry.snapshot && snapshotFresh(entry.snapshot.consultado_en, now())) times.push(Date.parse(entry.snapshot.consultado_en) + VERSION_TTL_MS);
        if (entry.jobActive && entry.deadline > now()) times.push(entry.deadline);
        if (entry.phase === 'error' && entry.retryAt > now()) times.push(entry.retryAt);
      }
      return times.length ? Math.min(...times) : null;
    },
    retain(rooms) {
      const ids = new Set(rooms.map(r => r.versionsRoomId));
      for (const [id, entry] of entries) if (!ids.has(id)) { entry.paused = true; entry.controller?.abort(); entries.delete(id); }
    },
    abort() { for (const entry of entries.values()) if (entry.controller) {entry.paused = true; entry.nextFetch = 0; entry.controller.abort();} }
  };
}
