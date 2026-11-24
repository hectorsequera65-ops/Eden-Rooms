import {findLobbyRoom, isLobbyRoomId, lobbyRoomId, publicIPv4} from './public-lobby.js';
export {publicIPv4} from './public-lobby.js';
import {readEnetSnapshot} from './enet-snapshot.js';
import {normalizeVersionSnapshot} from './version-snapshots.js';
import {snapshotFresh} from '../assets/player-versions.js';
import { isEnetPreview } from './enet-preview.js';
export { PREVIEW_HOST } from './enet-preview.js';
export const JOB_WAIT_MS=45000, LEASE_MS=30000, MAX_RUNNING=2;
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const validId=id=>typeof id==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(id);
export const respond=(data,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
export function previewOnly(request,env){
  return env?.ENET_JOBS_ENABLED==='true' && isEnetPreview(request,env);
}
function endpointAllowed(row){return row&&publicIPv4(row.direccion)&&Number.isInteger(Number(row.puerto))&&Number(row.puerto)>=1&&Number(row.puerto)<=65535;}
export async function allowedRoom(db,id){
  if(isLobbyRoomId(id))return findLobbyRoom(id);
  const row=await db.prepare(`SELECT a.sala_id,a.nombre,e.direccion,e.puerto FROM salas_autorizadas a
    INNER JOIN salas_endpoints e ON e.sala_id=a.sala_id WHERE a.sala_id=? AND a.autorizada=1`).bind(id).first();
  if(!endpointAllowed(row))return null;
  const lobbyId=lobbyRoomId({address:row.direccion,port:row.puerto,hasPassword:false});
  return await findLobbyRoom(lobbyId)?row:null;
}
async function expireJobs(db,now){
  await db.prepare(`UPDATE enet_version_jobs SET status='error',error_code='timeout',lease_token=NULL,lease_until=NULL,retry_after=MIN(deadline_at,COALESCE(lease_until,deadline_at))+15000
    WHERE status IN ('pending','running') AND (deadline_at<=? OR (status='running' AND lease_until<=?))`).bind(now,now).run();
  await db.prepare(`UPDATE enet_version_jobs SET status='error',error_code='endpoint',lease_token=NULL,lease_until=NULL,retry_after=0
    WHERE status IN ('pending','running') AND sala_id NOT GLOB 'lobby-*' AND NOT EXISTS (
      SELECT 1 FROM salas_autorizadas a JOIN salas_endpoints e ON e.sala_id=a.sala_id
      WHERE a.sala_id=enet_version_jobs.sala_id AND a.autorizada=1
        AND e.direccion=enet_version_jobs.direccion AND e.puerto=enet_version_jobs.puerto
    )`).run();
}
async function fresh(db,id,now,room){
  const row=await readEnetSnapshot(db,id,room.direccion,room.puerto);
  if(!row||!snapshotFresh(row.actualizado_en,now))return false;
  try{return Array.isArray(JSON.parse(row.jugadores_json))}catch{return false}
}
function publicState(row,now){
  if(!row)return {estado:'sin_solicitud'};
  if(row.status==='done')return {estado:'error',motivo:'snapshot',reintentar_en_ms:0}; // A done job without fresh data cannot be displayed as current.
  if(row.status==='error'||row.deadline_at<=now)return {estado:'error',motivo:['collector','timeout','blocked','endpoint'].includes(row.error_code)?row.error_code:(row.deadline_at<=now?'timeout':'job'),reintentar_en_ms:Math.max(0,row.retry_after-now)};
  const running=row.status==='running';
  const expires=running ? Math.min(row.deadline_at,row.lease_until) : row.deadline_at;
  return {estado:running?'consultando':'pendiente',espera_ms:Math.max(0,expires-now)};
}
async function readJSON(request,limit){
  if((request.headers.get('Content-Type')||'').split(';')[0].trim()!=='application/json')return {error:respond({error:'Se requiere JSON'},415)};
  if(Number(request.headers.get('Content-Length'))>limit)return {error:respond({error:'Datos demasiado grandes'},413)};
  const reader=request.body?.getReader();
  if(!reader)return {error:respond({error:'JSON invalido'},400)};
  const chunks=[];let size=0;
  while(true){
    const {done,value}=await reader.read();if(done)break;
    size+=value.byteLength;
    if(size>limit){await reader.cancel();return {error:respond({error:'Datos demasiado grandes'},413)}}
    chunks.push(value);
  }
  const bytes=new Uint8Array(size);let offset=0;
  for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  try{return {data:JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))}}
  catch{return {error:respond({error:'JSON invalido'},400)}}
}
export async function publicJobRequest({request,env},now=Date.now()){
  if(!previewOnly(request,env))return respond({error:'Consulta no disponible'},404);
  if(!env.DB||!env.COLLECTOR_API_KEY)return respond({error:'Consulta no disponible'},503);
  let id;
  if(request.method==='POST'){
    const origin=request.headers.get('Origin');
    if(origin!==new URL(request.url).origin||request.headers.get('Sec-Fetch-Site')==='cross-site')return respond({error:'Origen no autorizado'},403);
    const body=await readJSON(request,512);if(body.error)return body.error;
    if(!body.data||Array.isArray(body.data)||Object.keys(body.data).some(k=>k!=='sala_id'))return respond({error:'Solo se admite sala_id'},400);
    id=body.data.sala_id;
  }else if(request.method==='GET')id=new URL(request.url).searchParams.get('id');
  else return respond({error:'Metodo no permitido'},405);
  if(!validId(id))return respond({error:'ID de sala invalido'},400);
  try{
    const room=request.method==='GET' && isLobbyRoomId(id)
      ? await env.DB.prepare('SELECT direccion,puerto FROM enet_version_jobs WHERE sala_id=?').bind(id).first()
      : await allowedRoom(env.DB,id);
    if(!room)return respond({sala_id:id,estado:'error',motivo:'endpoint',reintentar_en_ms:0},403);
    await expireJobs(env.DB,now);
    let row=await env.DB.prepare('SELECT * FROM enet_version_jobs WHERE sala_id=?').bind(id).first();
    if(request.method==='GET'){
      if(row?.status==='done'&&await fresh(env.DB,id,now,room))return respond({sala_id:id,estado:'listo'});
      return respond({sala_id:id,...publicState(row,now)});
    }
    // Every manual click requests work, even with a fresh stored snapshot.
    // Only an existing pending/running job is shared; GET never creates work.
    if(row&&((row.status==='pending'||row.status==='running')&&row.deadline_at>now))return respond({sala_id:id,...publicState(row,now)},202);
    if(row&&row.retry_after>now)return respond({sala_id:id,...publicState(row,now)},429);
    const ip=request.headers.get('CF-Connecting-IP')||'unknown';
    const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(ip+'|'+Math.floor(now/60000)));
    const bucket=Array.from(new Uint8Array(digest),x=>x.toString(16).padStart(2,'0')).join('');
    await env.DB.prepare('DELETE FROM enet_request_limits WHERE expires_at<?').bind(now).run();
    const rate=await env.DB.prepare(`INSERT INTO enet_request_limits(bucket,requests,expires_at) VALUES (?,1,?)
      ON CONFLICT(bucket) DO UPDATE SET requests=requests+1 WHERE requests<10 RETURNING requests`).bind(bucket,now+120000).first();
    if(!rate)return respond({error:'Demasiadas solicitudes',reintentar_en_ms:60000},429);
    const jobId=crypto.randomUUID();
    row=await env.DB.prepare(`INSERT INTO enet_version_jobs(job_id,sala_id,direccion,puerto,status,created_at,deadline_at,retry_after)
      SELECT ?,?,?,?,'pending',?,?,0 WHERE (SELECT count(*) FROM enet_version_jobs WHERE status IN ('pending','running') AND deadline_at>?)<50
      ON CONFLICT(sala_id) DO UPDATE SET job_id=excluded.job_id,direccion=excluded.direccion,puerto=excluded.puerto,status='pending',
      created_at=excluded.created_at,deadline_at=excluded.deadline_at,lease_token=NULL,lease_until=NULL,claimed_at=NULL,retry_after=0,error_code=NULL
      WHERE enet_version_jobs.status IN ('done','error') AND enet_version_jobs.retry_after<=? RETURNING *`)
      .bind(jobId,id,room.direccion,Number(room.puerto),now,now+JOB_WAIT_MS,now,now).first();
    if(!row)row=await env.DB.prepare('SELECT * FROM enet_version_jobs WHERE sala_id=?').bind(id).first();
    if(!row)return respond({error:'Cola ocupada',reintentar_en_ms:15000},429);
    return respond({sala_id:id,...publicState(row,now)},202);
  }catch{return respond({error:'Consulta temporalmente no disponible'},503)}
}
function keyMatches(received,expected){
  if(!expected||!received)return false;
  const a=new TextEncoder().encode(received),b=new TextEncoder().encode(expected);
  let mismatch=a.length^b.length;
  for(let i=0;i<Math.max(a.length,b.length);i++)mismatch|=(a[i]||0)^(b[i]||0);
  return mismatch===0;
}
export async function privateJobRequest({request,env},now=Date.now()){
  if(!previewOnly(request,env))return respond({error:'No disponible'},404);
  if(!env.DB||!env.COLLECTOR_API_KEY)return respond({error:'Servicio no configurado'},503);
  if(!keyMatches(request.headers.get('X-Collector-Key'),env.COLLECTOR_API_KEY))return respond({error:'No autorizado'},401);
  if(request.method!=='POST')return respond({error:'Metodo no permitido'},405);
  const body=await readJSON(request,24000);if(body.error)return body.error;
  const data=body.data;if(!data||typeof data!=='object'||Array.isArray(data))return respond({error:'Solicitud invalida'},400);
  try{
    await expireJobs(env.DB,now);
    if(data.action==='claim'){
      const token=crypto.randomUUID();
      const job=await env.DB.prepare(`UPDATE enet_version_jobs SET status='running',lease_token=?,lease_until=MIN(deadline_at,?),claimed_at=?
        WHERE job_id=(SELECT j.job_id FROM enet_version_jobs j
          LEFT JOIN salas_autorizadas a ON a.sala_id=j.sala_id AND a.autorizada=1
          LEFT JOIN salas_endpoints e ON e.sala_id=a.sala_id AND e.direccion=j.direccion AND e.puerto=j.puerto
          WHERE j.status='pending' AND j.deadline_at>? AND (j.sala_id GLOB 'lobby-*' OR e.sala_id IS NOT NULL) ORDER BY j.created_at LIMIT 1)
        AND (SELECT count(*) FROM enet_version_jobs WHERE status='running' AND lease_until>? AND deadline_at>?)<? RETURNING *`)
        .bind(token,now+LEASE_MS,now,now+10000,now,now,MAX_RUNNING).first();
      if(!job)return respond({trabajo:null});
      let room;
      try{room=await allowedRoom(env.DB,job.sala_id)}catch{room=null}
      if(!endpointAllowed(room)||room.direccion!==job.direccion||Number(room.puerto)!==Number(job.puerto)){
        await env.DB.prepare("UPDATE enet_version_jobs SET status='error',lease_token=NULL,lease_until=NULL,error_code='endpoint',retry_after=? WHERE job_id=? AND lease_token=?").bind(now+15000,job.job_id,token).run();
        return respond({trabajo:null});
      }
      return respond({trabajo:{job_id:job.job_id,sala_id:job.sala_id,direccion:job.direccion,puerto:job.puerto,lease_token:token,vence_en:new Date(job.lease_until).toISOString()}});
    }
    if(!uuid.test(data.job_id||'')||!uuid.test(data.lease_token||''))return respond({error:'Trabajo invalido'},400);
    const job=await env.DB.prepare("SELECT * FROM enet_version_jobs WHERE job_id=? AND lease_token=? AND status='running' AND lease_until>? AND deadline_at>?")
      .bind(data.job_id,data.lease_token,now,now).first();
    if(!job)return respond({error:'Trabajo vencido o no asignado'},409);
    if(data.action==='fail'){
      const failureTime=Math.max(now,Date.now());
      const result=await env.DB.prepare("UPDATE enet_version_jobs SET status='error',error_code='collector',lease_token=NULL,lease_until=NULL,retry_after=? WHERE job_id=? AND lease_token=? AND lease_until>? AND deadline_at>?")
        .bind(failureTime+15000,job.job_id,job.lease_token,failureTime,failureTime).run();
      return result.meta.changes ? respond({ok:true}) : respond({error:'Trabajo vencido'},409);
    }
    if(data.action!=='complete')return respond({error:'Accion invalida'},400);
    const room=await allowedRoom(env.DB,job.sala_id);
    if(!room||room.direccion!==job.direccion||Number(room.puerto)!==Number(job.puerto))return respond({error:'Destino ya no autorizado'},409);
    if(data.snapshot?.sala_id!==job.sala_id)return respond({error:'Sala incorrecta'},400);
    const normalized=normalizeVersionSnapshot(data.snapshot,env,now);if(normalized.error)return normalized.error;
    const {id,when,players}=normalized;
    if(when<job.created_at-30000||when>now+30000)return respond({error:'Muestra fuera del trabajo'},400);
    // Both statements run in one D1 transaction, guarded by the same live lease
    // and current room endpoint. Late workers cannot write after reassignment.
    const guard=`job_id=? AND lease_token=? AND status='running' AND lease_until>? AND deadline_at>?
      AND (sala_id GLOB 'lobby-*' OR EXISTS (SELECT 1 FROM salas_autorizadas a INNER JOIN salas_endpoints e ON e.sala_id=a.sala_id
        WHERE a.sala_id=enet_version_jobs.sala_id AND a.autorizada=1 AND e.direccion=enet_version_jobs.direccion AND e.puerto=enet_version_jobs.puerto))`;
    const writeNow=Math.max(now,Date.now());
    const result=await env.DB.batch([
      env.DB.prepare(`INSERT INTO versiones_salas(sala_id,nombre_sala,jugadores_json,actualizado_en)
        SELECT ?,?,?,? FROM enet_version_jobs WHERE ${guard}
        ON CONFLICT(sala_id) DO UPDATE SET nombre_sala=excluded.nombre_sala,jugadores_json=excluded.jugadores_json,actualizado_en=excluded.actualizado_en`)
        .bind(id,room.nombre,JSON.stringify(players),new Date(Math.min(when,writeNow)).toISOString(),job.job_id,job.lease_token,writeNow,writeNow),
      env.DB.prepare(`UPDATE enet_version_jobs SET status='done',lease_token=NULL,lease_until=NULL,error_code=NULL WHERE ${guard}`)
        .bind(job.job_id,job.lease_token,writeNow,writeNow)
    ]);
    if(!result[1]?.meta?.changes)return respond({error:'Trabajo vencido'},409);
    return respond({ok:true,sala_id:id,jugadores:players.length});
  }catch{return respond({error:'No se pudo procesar el trabajo'},503)}
}
