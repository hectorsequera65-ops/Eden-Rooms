import { isEnetPreview } from './enet-preview.js';

const json=(body,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
function validKey(received,expected){
  const a=new TextEncoder().encode(received),b=new TextEncoder().encode(expected);
  let mismatch=a.length^b.length;
  for(let i=0;i<Math.max(a.length,b.length);i++)mismatch|=(a[i]||0)^(b[i]||0);
  return Boolean(received)&&mismatch===0;
}
// Shared authentication for the no-write probe and snapshot handlers.
export function authorizeProductionSnapshot(request, env) {
  if (!env.ENET_PRODUCTION_API_KEY) return json({error:'Servicio no configurado'},503);
  if (request.headers.has('X-API-Key') || request.headers.has('X-ENet-Preview-Key') ||
      !validKey(request.headers.get('X-ENet-Production-Key') || '', env.ENET_PRODUCTION_API_KEY)) {
    return json({error:'No autorizado'},401);
  }
  return null;
}

export function authorizePreviewSnapshot(request, env) {
  if (!isEnetPreview(request, env) || (request.headers.has('X-API-Key') || request.headers.has('X-ENet-Production-Key'))) {
    return json({error:'No autorizado'},401);
  }
  if (!env.ENET_PREVIEW_API_KEY) return json({error:'Servicio no configurado'},503);
  if (!validKey(request.headers.get('X-ENet-Preview-Key') || '', env.ENET_PREVIEW_API_KEY)) {
    return json({error:'No autorizado'},401);
  }
  return null;
}

export function authorizeVersionRequest(request,env,{allowPreview=false}={}){
  if(allowPreview && request.headers.has('X-ENet-Preview-Key')){
    return authorizePreviewSnapshot(request,env);
  }
  if(!env.VERSIONES_API_KEY)return json({error:'Servicio no configurado'},503);
  if(!validKey(request.headers.get('X-API-Key')||'',env.VERSIONES_API_KEY))return json({error:'No autorizado'},401);
  return null;
}

export function normalizeVersionSnapshot(data,env,now=Date.now(),{productionSlot}={}){
  const id=data?.sala_id;
  if(typeof id!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(id)||id==='eden-rooms-test')return {error:json({error:'ID invalido o reservado'},400)};
  if(!Array.isArray(data.jugadores)||data.jugadores.length>32)return {error:json({error:'Jugadores invalidos'},400)};
  const when=Date.parse(data.consultado_en);
  // The scheduled production handler has already checked that now is inside the slot.
  const fresh = productionSlot === undefined ? Math.abs(now - when) <= 120000
    : when >= productionSlot && when <= now;
  if(!fresh)return {error:json({error:'Datos vencidos'},400)};
  if(data.jugadores.some(p=>!p||typeof p!=='object'||Array.isArray(p)))return {error:json({error:'Jugador invalido'},400)};
  if(data.jugadores.some(p=>p.title_id!==undefined&&(typeof p.title_id!=='string'||!/^[0-9a-fA-F]{16}$/.test(p.title_id))))return {error:json({error:'Title ID invalido'},400)};
  if(data.jugadores.some(p=>p.virtual_ip!==undefined&&(typeof p.virtual_ip!=='string'||!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(p.virtual_ip)||p.virtual_ip.split('.').some(n=>Number(n)>255))))return {error:json({error:'IP virtual invalida'},400)};
  const players=data.jugadores.map(p=>({
    nombre:String(p.nombre||'').slice(0,80),
    juego:String(p.juego||'').slice(0,160),
    version:String(p.version||'').slice(0,40),
    ...(p.virtual_ip?{virtual_ip:p.virtual_ip}:{}),
    ...(p.title_id?{title_id:p.title_id.toUpperCase()}:{})
  })).filter(p=>p.nombre&&p.nombre!=='EdenRoomsConsulta'&&p.nombre!==(env.EDEN_ENET_NICKNAME||'sralcer'));
  return {id,when,players};
}

export async function handleVersionSnapshot({request,env},{validateOnly=false}={}){
  if(!env.DB||!env.VERSIONES_API_KEY)return json({error:'Servicio no configurado'},503);
  const denied=authorizeVersionRequest(request,env);
  if(denied)return denied;
  if((request.headers.get('content-type')||'').split(';')[0].trim()!=='application/json')return json({error:'Se requiere application/json'},415);
  const raw=await request.text();
  if(raw.length>20000)return json({error:'Datos demasiado grandes'},413);
  let data;try{data=JSON.parse(raw)}catch{return json({error:'JSON invalido'},400)}
  const normalized=normalizeVersionSnapshot(data,env);
  if(normalized.error)return normalized.error;
  const {id,when,players}=normalized;
  try{
    const sala=await env.DB.prepare(
      'SELECT a.nombre FROM salas_autorizadas a INNER JOIN salas_endpoints e ON e.sala_id=a.sala_id WHERE a.sala_id=? AND a.autorizada=1 AND e.direccion IS NOT NULL AND e.puerto BETWEEN 1 AND 65535'
    ).bind(id).first();
    if(!sala)return json({error:'Sala publica no autorizada o sin endpoint registrado'},403);
    if(validateOnly){
      await env.DB.prepare(
        'SELECT sala_id,nombre_sala,jugadores_json,actualizado_en FROM versiones_salas LIMIT 0'
      ).all();
      return json({ok:true,validado:true,escritura:false,sala_id:id,jugadores:players.length});
    }
    await env.DB.prepare(
      'INSERT INTO versiones_salas (sala_id,nombre_sala,jugadores_json,actualizado_en) VALUES (?,?,?,?) ON CONFLICT(sala_id) DO UPDATE SET nombre_sala=excluded.nombre_sala,jugadores_json=excluded.jugadores_json,actualizado_en=excluded.actualizado_en WHERE excluded.actualizado_en >= versiones_salas.actualizado_en'
    ).bind(id,String(sala.nombre),JSON.stringify(players),new Date(when).toISOString()).run();
    return json({ok:true,sala_id:id,jugadores:players.length});
  }catch{return json({error:validateOnly?'No se pudo validar la configuracion de versiones':'No se pudieron guardar las versiones'},503)}
}
