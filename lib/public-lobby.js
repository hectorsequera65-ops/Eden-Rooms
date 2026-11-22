import {parseLobbyJSON} from './lobby-json.js';

import {endpointId, lobbyRoomId} from '../assets/lobby-room-id.js';
export {isLobbyRoomId, lobbyRoomId, publicIPv4} from '../assets/lobby-room-id.js';

export async function readLobby({fresh = false} = {}) {
  const response = await fetch('https://api.ynet-fun.xyz/lobby', {
    headers: {'Accept':'application/json', 'User-Agent':'EdenRooms/1.0'},
    ...(fresh ? {cache:'no-store', signal:AbortSignal.timeout(3000)} : {cf:{cacheTtl:5, cacheEverything:true}})
  });
  if (!response.ok) throw Error('API de Eden no disponible');
  const data = parseLobbyJSON(await response.text());
  if (!Array.isArray(data?.rooms)) throw Error('Formato inesperado');
  return data.rooms;
}

export async function findLobbyRoom(id) {
  const room = listEligibleLobbyRooms(await readLobby({fresh:true})).get(id);
  if (!room) return null;
  return {nombre:String(room.name || 'Sala sin nombre').slice(0, 160), direccion:room.address, puerto:Number(room.port)};
}

export function listEligibleLobbyRooms(rooms) {
  const eligible = new Map();
  const seen = new Set();
  for (const room of rooms) {
    if (!room || typeof room !== 'object') continue;
    const id = endpointId(room);
    if (seen.has(id)) {
      eligible.delete(id);
    } else {
      seen.add(id);
      if (lobbyRoomId(room) === id) eligible.set(id, room);
    }
  }
  return eligible;
}
