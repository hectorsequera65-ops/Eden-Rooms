import {respond} from './enet-preview.js';

function validKey(received,expected){
  const a=new TextEncoder().encode(received),b=new TextEncoder().encode(expected);
  let mismatch=a.length^b.length;
  for(let i=0;i<Math.max(a.length,b.length);i++)mismatch|=(a[i]||0)^(b[i]||0);
  return Boolean(received)&&mismatch===0;
}
export function authorizePreviewSnapshot(request, env) {
  if (!env.ENET_PREVIEW_API_KEY) return respond({error:'Servicio no configurado'}, 503);
  if (request.headers.has('X-API-Key') ||
      !validKey(request.headers.get('X-ENet-Preview-Key') || '', env.ENET_PREVIEW_API_KEY)) {
    return respond({error:'No autorizado'}, 401);
  }
  return null;
}

export function normalizeVersionSnapshot(data,env,now=Date.now()){
  const id=data?.sala_id;
  if(typeof id!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(id)||id==='eden-rooms-test')return {error:respond({error:'ID invalido o reservado'},400)};
  if(!Array.isArray(data.jugadores)||data.jugadores.length>32)return {error:respond({error:'Jugadores invalidos'},400)};
  const when=Date.parse(data.consultado_en);
  if(!Number.isFinite(when)||Math.abs(now-when)>120000)return {error:respond({error:'Datos vencidos'},400)};
  if(data.jugadores.some(p=>!p||typeof p!=='object'||Array.isArray(p)))return {error:respond({error:'Jugador invalido'},400)};
  if(data.jugadores.some(p=>p.title_id!==undefined&&(typeof p.title_id!=='string'||!/^[0-9a-fA-F]{16}$/.test(p.title_id))))return {error:respond({error:'Title ID invalido'},400)};
  if(data.jugadores.some(p=>p.virtual_ip!==undefined&&(typeof p.virtual_ip!=='string'||!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(p.virtual_ip)||p.virtual_ip.split('.').some(n=>Number(n)>255))))return {error:respond({error:'IP virtual invalida'},400)};
  const players=data.jugadores.map(p=>({
    nombre:String(p.nombre||'').slice(0,80),
    juego:String(p.juego||'').slice(0,160),
    version:String(p.version||'').slice(0,40),
    ...(p.virtual_ip?{virtual_ip:p.virtual_ip}:{}),
    ...(p.title_id?{title_id:p.title_id.toUpperCase()}:{})
  })).filter(p=>p.nombre&&p.nombre!==(env.EDEN_ENET_NICKNAME||'sralcer'));
  return {id,when,players};
}
