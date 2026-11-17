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
  const matches = (await readLobby({fresh:true})).filter(room => endpointId(room) === id);
  if (matches.length !== 1 || lobbyRoomId(matches[0]) !== id) return null;
  const room = matches[0];
  return {nombre:String(room.name || 'Sala sin nombre').slice(0, 160), direccion:room.address, puerto:Number(room.port)};
}
