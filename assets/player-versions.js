export const VERSION_TTL_MS = 120000;
export const SCHEDULED_VERSION_TTL_MS = 360000;
const VERSION_FIELDS = ['gameVersion','game_version','gameVer','game_ver','applicationVersion','application_version'];
const roomIdValid = id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(id);
export function snapshotFresh(timestamp, now = Date.now(), ttl = VERSION_TTL_MS) {
  const age = now - Date.parse(timestamp);
  return Number.isFinite(age) && age >= -30000 && age < ttl;
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
  delete result.gameVersionSource; delete result.gameVersionObservedAt; delete result.gameVersionMatch;
  return result;
}
export function playerGameVersion(player, now = Date.now()) {
  const source = player?.gameVersionSource;
  if (source === 'enet' && !snapshotFresh(player.gameVersionObservedAt, now)) return '';
  if (source === 'enet-scheduled' && !snapshotFresh(player.gameVersionObservedAt, now, SCHEDULED_VERSION_TTL_MS)) return '';
  for (const key of VERSION_FIELDS) {
    const value = player?.[key];
    if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
  }
  return '';
}
const UNKNOWN_VERSIONS = /^(?:n\/?a|(?:version )?(?:unknown|unavailable|not (?:available|queried)|sin consultar|no consultad[ao]|no informad[ao]|desconocid[ao]|no disponible|sin datos|sin version)|[-–—]+)$/i;
export function displayedPlayerVersion(player) {
  const version = playerGameVersion(player);
  const label = version.normalize('NFD').replace(/\p{M}/gu, '').replace(/\s+/g, ' ');
  return UNKNOWN_VERSIONS.test(label) ? '' : version;
}
export function playerGameLabel(player) {
  const game = String(player.gameName || '').trim(), version = game ? displayedPlayerVersion(player) : '';
  return game + (version ? ' · v' + version.replace(/^v/i, '') : '');
}
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function playerListMarkup(players) {
  return players.map(player => {
    const game = String(player.gameName || '').trim(), version = game ? displayedPlayerVersion(player) : '';
    return '<div class="player-row"><span class="player-name">👤 ' + escapeHTML(player.nickname || 'Sin nombre') + '</span><span class="player-details">'
      + (game ? '<span class="player-game">' + escapeHTML(game) + '</span>' : '')
      + (version ? '<span class="player-version">Versión ' + escapeHTML(version) + '</span>' : '') + '</span></div>';
  }).join('');
}
export function mergeVersionPlayers(players, observations, {observedAt, now = Date.now(), scheduled = false} = {}) {
  if (!Array.isArray(players) || !Array.isArray(observations)) return players;
  const clean = players.map(withoutEnetVersion);
  if (observedAt !== undefined && !snapshotFresh(observedAt, now, scheduled ? SCHEDULED_VERSION_TTL_MS : VERSION_TTL_MS)) return clean;
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
      ...(observedAt !== undefined ? {gameVersionSource: scheduled ? 'enet-scheduled' : 'enet', gameVersionObservedAt: observedAt} : {})};
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
// The public directory currently omits virtual IPs. A fallback requires a
// unique nickname on BOTH sides, exact game and an exact nonzero Title ID.
// Neither mode can detect a disconnect/reconnect between directory samples.
function directoryTitle(player) {
  try {
    if (typeof player.gameId === 'number' && !Number.isSafeInteger(player.gameId)) return null;
    if (!/^[0-9]+$/.test(String(player.gameId))) return null;
    const id = BigInt(player.gameId);
    return id > 0n && id <= 0xffffffffffffffffn ? id.toString(16).toUpperCase().padStart(16,'0') : null;
  } catch { return null; }
}
function identity(player) {
  const ip = virtualIp(player), title = directoryTitle(player);
  if (!player?.nickname || !player.gameName || ip === null) return null;
  if (ip) return JSON.stringify(['ip',player.nickname,ip,player.gameName,title]);
  return title ? JSON.stringify(['name-title',player.nickname,player.gameName,title]) : null;
}
function identities(players) {
  const list = players || [], keys = list.map(identity);
  return new Set(keys.filter((key,index) => key && keys.filter(k => k === key).length === 1
    && (virtualIp(list[index]) || list.filter(p => p.nickname === list[index].nickname).length === 1)));
}
function manualPlayers(room, entry) {
  const players = Array.isArray(room.players) ? room.players.map(withoutEnetVersion) : [];
  if (!entry?.snapshot || entry.address !== room.address || entry.port !== Number(room.port)) return players;
  const observations = entry.snapshot.jugadores;
  const manualBase = players.map(player => player.gameVersionSource === 'enet-scheduled'
    ? withoutEnetVersion({...player, gameVersionSource:'enet'}) : player);
  const merged = mergeVersionPlayers(manualBase, observations);
  return players.map((player,index) => {
    if (!entry.eligible.has(identity(player))) return player;
    const ip = virtualIp(player), title = directoryTitle(player);
    if (ip) {
      if (!observations.some(o => o?.nombre === player.nickname && virtualIp(o) === ip)) return player;
    } else {
      const matches = observations.filter(o => o?.nombre === player.nickname);
      if (!title || players.filter(p => p.nickname === player.nickname).length !== 1
        || matches.length !== 1 || virtualIp(matches[0]) === null
        || matches[0].title_id !== title) return player;
    }
    return merged[index]?.gameVersion && merged[index] !== manualBase[index] ? {...merged[index],
      gameVersionSource:'enet-card', gameVersionObservedAt:entry.snapshot.consultado_en,
      gameVersionMatch:ip?'name-ip':'name-title'} : player;
  });
}
function associationResult(room, entry) {
  const observations = entry.snapshot.jugadores;
  const versioned = observations.filter(o => String(o?.version || '').trim()).length;
  const players = manualPlayers(room,entry), matched = players.filter(p => p.gameVersionSource === 'enet-card').length;
  const fallback = players.some(p => p.gameVersionMatch === 'name-title');
  let result, detail;
  if (!observations.length) {result='empty';detail='La muestra publicada quedó vacía.';}
  else if (!versioned) {result='no_versions';detail='La muestra publicada contiene jugadores sin versión.';}
  else if (!matched) {result='association_error';detail='La muestra contiene '+versioned+' versiones, pero no se pudieron asociar con seguridad a los jugadores actuales. Se requiere nombre/IP virtual o apodo único, juego y Title ID exactos; no se reutilizan identidades que cambiaron.';}
  else {result=matched<versioned?'partial':'matched';detail='La muestra contiene '+versioned+' versiones; '+matched+' asociadas a jugadores actuales.';}
  if (fallback) detail+=' Coincidencia por apodo único, juego y Title ID; el directorio no informa IP virtual.';
  return {result,detail,received:observations.length,versioned,matched};
}
function queryTime(timestamp) {
  return new Intl.DateTimeFormat('es', {hour:'2-digit', minute:'2-digit', hourCycle:'h23'}).format(new Date(timestamp));
}
export function createVersionsClient({fetcher = (...args) => fetch(...args), now = () => Date.now(), timeoutMs = 5000, onChange = () => {}} = {}) {
  const entries = new Map();
  function entryFor(roomOrId) {
    if (typeof roomOrId === 'string') return entries.get(roomOrId);
    if (!roomOrId || roomOrId.hasPassword) return undefined;
    if (roomIdValid(roomOrId.versionsRoomId)) return entries.get(roomOrId.versionsRoomId);
    // A temporary D1/lobby metadata failure must not erase a card-owned result.
    return [...entries.values()].find(entry => entry.open && entry.address === roomOrId.address
      && entry.port === Number(roomOrId.port));
  }
  function cancel(entry) {
    entry.controller?.abort();
    entry.controller = null;
    entry.pending = null;
    if (entry.phase === 'loading') entry.phase = 'error';
  }
  async function readPublished(entry, controller) {
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetcher('/api/versiones-publicadas?id=' + encodeURIComponent(entry.id),
        {method:'GET', cache:'no-store', credentials:'omit', signal:controller.signal});
      if (!response.ok) throw Error('Versions API unavailable');
      const data = await response.json();
      if (entry.controller !== controller) return;
      if (controller.signal.aborted || data?.sala_id !== entry.id) throw Error('Invalid snapshot');
      if (data.disponible === false) {
        entry.phase = 'unavailable';
      } else {
        if (data.disponible !== true || !Array.isArray(data.jugadores)
          || !snapshotFresh(data.consultado_en, now(), Infinity)
          || data.endpoint?.direccion !== entry.address || Number(data.endpoint?.puerto) !== entry.port) {
          throw Error('Invalid snapshot');
        }
        entry.snapshot = data;
        entry.phase = 'ready';
      }
    } catch {
      if (entry.controller === controller) entry.phase = 'error';
    } finally {
      clearTimeout(timeout);
      if (entry.controller === controller) {
        entry.controller = null;
        entry.pending = null;
        onChange();
      }
    }
  }
  return {
    open(room) {
      const id = room?.versionsRoomId;
      if (room?.hasPassword || !roomIdValid(id)) return;
      let entry = entryFor(room);
      if (!entry || entry.address !== room.address || entry.port !== Number(room.port)) {
        if (entry) cancel(entry);
        entry = {id, address:room.address, port:Number(room.port), snapshot:null,
          pending:null, phase:'idle', eligible:new Set()};
        entries.set(id, entry);
      }
      entry.open = true;
    },
    query(room) {
      if (room?.hasPassword || !roomIdValid(room?.versionsRoomId)) return Promise.resolve();
      this.open(room);
      const entry = entryFor(room);
      if (entry.pending) return entry.pending;
      entry.controller = new AbortController();
      entry.phase = 'loading';
      entry.snapshot = null;
      entry.eligible = identities(room.players);
      const controller = entry.controller;
      entry.pending = Promise.resolve().then(() => {
        if (!controller.signal.aborted) return readPublished(entry, controller);
      });
      onChange();
      return entry.pending;
    },
    close(id) {
      for (const [key, entry] of entries) if (id === undefined || key === id) {
        entry.open = false;
        cancel(entry);
      }
    },
    decorate(room) {
      const entry = entryFor(room);
      return {...room,players:manualPlayers(room,entry)};
    },
    status(roomOrId) {
      const entry = entryFor(roomOrId);
      if (!entry?.open || entry.phase === 'idle') return null;
      if (entry.phase === 'ready') {
        const result = typeof roomOrId === 'object' ? associationResult(roomOrId,entry) : {};
        return {text:'Versiones consultadas a las ' + queryTime(entry.snapshot.consultado_en),
          consultedAt:entry.snapshot.consultado_en, ...result, retry:false};
      }
      if (entry.phase === 'unavailable') return {text:'Versión no disponible', result:'unavailable'};
      if (entry.phase === 'error') {
        return {text:'No se pudieron consultar las versiones. Pulsá Consultar versiones para reintentar.', result:'error'};
      }
      return {text:'Consultando versiones…'};
    },
    retain(rooms) {
      for (const [id, entry] of entries) {
        const sameRoom = rooms.some(room => !room.hasPassword && room.address === entry.address && Number(room.port) === entry.port
          && (!roomIdValid(room.versionsRoomId) || room.versionsRoomId === id));
        const current = rooms.find(room => room.address === entry.address && Number(room.port) === entry.port);
        if (current) {
          const present = identities(current.players);
          entry.eligible = new Set([...entry.eligible].filter(key => present.has(key)));
        }
        if (!sameRoom) { entry.open = false; cancel(entry); entries.delete(id); }
      }
    },
    abort() {
      for (const entry of entries.values()) if (entry.controller) cancel(entry);
    }
  };
}
