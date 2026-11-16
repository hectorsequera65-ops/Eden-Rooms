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
  if (!['enet','enet-card'].includes(player.gameVersionSource)) return player;
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
      + (version ? '<span class="player-version">Versión ' + escapeHTML(version) + '</span>' : '<span class="player-version-unknown">Versión sin consultar</span>') + '</span></div>';
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
// Identity is scoped to a room and uninterrupted presence in directory samples.
// Names alone cannot establish continuity across independent ENet observations.
function identity(player) {
  const ip = virtualIp(player);
  return player?.nickname && ip ? JSON.stringify([player.nickname, ip, player.gameName, String(player.gameId ?? '')]) : null;
}
function identities(players) {
  const keys = (players || []).map(identity).filter(Boolean);
  return new Set(keys.filter(key => keys.filter(k => k === key).length === 1));
}
function queryTime(timestamp) {
  return new Intl.DateTimeFormat('es', {hour:'2-digit', minute:'2-digit', hourCycle:'h23'}).format(new Date(timestamp));
}
export function createVersionsClient({fetcher = (...args) => fetch(...args), now = () => Date.now(), timeoutMs = 5000, onChange = () => {}} = {}) {
  const entries = new Map();
  function entryFor(roomOrId) {
    if (typeof roomOrId === 'string') return entries.get(roomOrId);
    if (!roomOrId) return undefined;
    if (roomIdValid(roomOrId.versionsRoomId)) return entries.get(roomOrId.versionsRoomId);
    // A temporary D1/lobby metadata failure must not erase a card-owned result.
    return [...entries.values()].find(entry => entry.open && entry.address === roomOrId.address
      && entry.port === Number(roomOrId.port));
  }
  function update(entry, patch) {
    const changed = Object.keys(patch).some(key => ['snapshot','phase','deadline'].includes(key) && entry[key] !== patch[key]);
    Object.assign(entry, patch);
    if (changed && entry.open && entries.get(entry.id) === entry) onChange();
  }
  function failed(entry) {
    update(entry, {phase:'error', jobActive:false, deadline:null, nextFetch:Infinity});
  }
  async function fetchRoom(id) {
    const entry = entries.get(id);
    if (!entry?.open) return;
    if (entry.pending) return entry.pending;
    if (entry.started && !entry.jobActive) return; // An opening can enqueue only once.
    if (entry.jobActive && entry.deadline !== null && now() >= entry.deadline) { failed(entry); return; }
    if (now() < entry.nextFetch) return;
    const enqueue = !entry.started;
    entry.started = true; // Latch before yielding, including lost/aborted POST responses.
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
          && snapshotFresh(data.consultado_en, now())
          && (!data.endpoint || data.endpoint.direccion === entry.address && Number(data.endpoint.puerto) === entry.port) ? data : null;
        if (!entry.open || entries.get(id) !== entry) return false;
        if (snapshot) {
          update(entry, {snapshot, phase:'ready', jobActive:false, deadline:null, nextFetch:Infinity});
          return true;
        }
        return false;
      }
      async function queueState(response) {
        const data = await response.json();
        if (!entry.open || entries.get(id) !== entry) return;
        if ((!response.ok && response.status !== 429) || data?.sala_id && data.sala_id !== id) throw Error('Queue unavailable');
        if (data.estado === 'listo') {
          entry.jobActive = true;
          if (!await readSnapshot()) throw Error('No fresh result');
        } else if (data.estado === 'pendiente' || data.estado === 'consultando') {
          const wait = Math.min(45000, Number(data.espera_ms));
          if (!Number.isFinite(wait) || wait <= 0) { failed(entry); return; }
          const deadline = Math.min(entry.deadline ?? Infinity, now() + wait);
          update(entry, {phase:'loading', jobActive:true, deadline, nextFetch:now() + VERSION_POLL_MS});
        } else if (data.estado === 'error' || response.status === 429) failed(entry);
        else throw Error('Invalid job status');
      }
      try {
        if (enqueue) {
          await queueState(await fetcher('/api/versiones-consultar', {...options, method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({sala_id:id})}));
        } else if (entry.jobActive) {
          await queueState(await fetcher('/api/versiones-consultar?id=' + encodeURIComponent(id), options));
        }
      } catch {
        if (!entry.paused || timedOut) failed(entry);
      } finally { clearTimeout(timeout); entry.pending = null; entry.controller = null; }
    })();
    return entry.pending;
  }
  return {
    open(room) {
      const id = room?.versionsRoomId;
      if (!roomIdValid(id)) return;
      let entry = entryFor(room);
      if (!entry || entry.address !== room.address || entry.port !== Number(room.port)) {
        entry = {id, address:room.address, port:Number(room.port), started:true, snapshot:null,
          nextFetch:Infinity, pending:null, phase:'idle', jobActive:false, deadline:null, eligible:new Set()};
        entries.set(id, entry);
      }
      entry.open = true;
    },
    query(room) {
      if (!roomIdValid(room?.versionsRoomId)) return Promise.resolve();
      this.open(room);
      const previous = entryFor(room);
      if (!previous?.open) return Promise.resolve();
      if (previous.pending || previous.jobActive && now() < previous.deadline) return previous.pending || Promise.resolve();
      // Only a manual click can reset the POST latch; concurrent clicks share it.
      previous.controller?.abort();
      entries.set(previous.id, {...previous, started:false, pending:null, controller:null,
        phase:'idle', snapshot:null, jobActive:false, deadline:null, nextFetch:0, eligible:identities(room.players)});
      return fetchRoom(previous.id);
    },
    close(id) {
      for (const [key, entry] of entries) if (id === undefined || key === id) {
        entry.open = false; entry.paused = true; entry.controller?.abort();
        if (entry.jobActive || entry.pending) failed(entry);
        entry.pending = null;
      }
    },
    async refresh(rooms) {
      const ids = [...new Set(rooms.map(r => entryFor(r)).filter(entry => entry?.open).map(entry => entry.id))];
      await Promise.all(ids.map(fetchRoom));
    },
    decorate(room) {
      const entry = entryFor(room);
      const clean = applyRoomSnapshot(room, null, now());
      if (!entry?.snapshot || entry.address !== room.address || entry.port !== Number(room.port)) return clean;
      // Filter by uninterrupted directory identity before matching the historical sample.
      const observations = entry.snapshot.jugadores;
      const mergedPlayers = mergeVersionPlayers(clean.players || [], observations);
      return {...clean, players:(clean.players || []).map((player, index) => {
        if (!entry.eligible.has(identity(player)) || !observations.some(o => o?.nombre === player.nickname
          && virtualIp(o) && virtualIp(o) === virtualIp(player))) return player;
        const merged = mergedPlayers[index];
        return merged?.gameVersion && merged !== player
          ? {...merged, gameVersionSource:'enet-card', gameVersionObservedAt:entry.snapshot.consultado_en} : player;
      })};
    },
    status(roomOrId) {
      const entry = entryFor(roomOrId);
      if (!entry?.open || entry.phase === 'idle') return null;
      if (entry.phase === 'ready') return {text:'Versiones consultadas a las ' + queryTime(entry.snapshot.consultado_en), consultedAt:entry.snapshot.consultado_en, retry:false};
      if (entry.phase === 'error' || entry.jobActive && entry.deadline !== null && now() >= entry.deadline) return {text:'No se pudieron consultar las versiones. Pulsá Consultar versiones para reintentar.', retry:false};
      return {text:'Consultando versiones…', retry:false};
    },
    nextExpiry() {
      const times = [];
      for (const entry of entries.values()) {
        if (entry.open && entry.jobActive && entry.deadline > now()) times.push(entry.deadline);
      }
      return times.length ? Math.min(...times) : null;
    },
    retain(rooms) {
      for (const [id, entry] of entries) {
        const sameRoom = rooms.some(room => room.address === entry.address && Number(room.port) === entry.port
          && (!roomIdValid(room.versionsRoomId) || room.versionsRoomId === id));
        const current = rooms.find(room => room.address === entry.address && Number(room.port) === entry.port);
        if (current) {
          const present = identities(current.players);
          entry.eligible = new Set([...entry.eligible].filter(key => present.has(key)));
        }
        if (!sameRoom) { entry.open = false; entry.paused = true; entry.controller?.abort(); entries.delete(id); }
      }
    },
    abort() {
      for (const entry of entries.values()) if (entry.controller) {
        entry.paused = true; entry.nextFetch = 0; entry.controller.abort();
        if (!entry.jobActive) failed(entry); // An uncertain POST must not be sent twice in this opening.
      }
    }
  };
}
