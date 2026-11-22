export function publicIPv4(address){
  if(typeof address!=='string'||!/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(address))return false;
  const p=address.split('.').map(Number);
  if(p.some(n=>n>255))return false;
  const [a,b,c]=p;
  return !(a===0||a===10||a===127||a>=224||(a===100&&b>=64&&b<=127)
    ||(a===169&&b===254)||(a===172&&b>=16&&b<=31)||(a===192&&b===168)
    ||(a===192&&b===0&&(c===0||c===2))||(a===192&&b===88&&c===99)
    ||(a===198&&(b===18||b===19))||(a===198&&b===51&&c===100)||(a===203&&b===0&&c===113));
}

export const isLobbyRoomId = id => id.startsWith('lobby-');
export const endpointId = ({address, port}) => 'lobby-' + String(address).replaceAll('.', '-') + '-' + Number(port);

export function lobbyRoomId(room) {
  const port = Number(room.port);
  if (room.hasPassword !== false || !publicIPv4(room.address)
      || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return endpointId(room);
}
