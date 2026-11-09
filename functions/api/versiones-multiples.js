const json=(body,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
function validKey(received,expected){
  const a=new TextEncoder().encode(received),b=new TextEncoder().encode(expected);
  let mismatch=a.length^b.length;
  for(let i=0;i<Math.max(a.length,b.length);i++)mismatch|=(a[i]||0)^(b[i]||0);
  return Boolean(received)&&mismatch===0;
}
export async function onRequestPost({request,env}){
  if(!env.DB||!env.VERSIONES_API_KEY)return json({error:'Servicio no configurado'},503);
  if(!validKey(request.headers.get('X-API-Key')||'',env.VERSIONES_API_KEY))return json({error:'No autorizado'},401);
  if((request.headers.get('content-type')||'').split(';')[0].trim()!=='application/json')return json({error:'Se requiere application/json'},415);
  const raw=await request.text();
  if(raw.length>20000)return json({error:'Datos demasiado grandes'},413);
  let data;try{data=JSON.parse(raw)}catch{return json({error:'JSON invalido'},400)}
  const id=data?.sala_id;
  if(typeof id!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(id)||id==='eden-rooms-test')return json({error:'ID invalido o reservado'},400);
  if(!Array.isArray(data.jugadores)||data.jugadores.length>32)return json({error:'Jugadores invalidos'},400);
  const when=Date.parse(data.consultado_en);
  if(!Number.isFinite(when)||Math.abs(Date.now()-when)>120000)return json({error:'Datos vencidos'},400);
  if(data.jugadores.some(p=>!p||typeof p!=='object'||Array.isArray(p)))return json({error:'Jugador invalido'},400);
  const players=data.jugadores.map(p=>({
    nombre:String(p.nombre||'').slice(0,80),
    juego:String(p.juego||'').slice(0,160),
    version:String(p.version||'').slice(0,40)
  })).filter(p=>p.nombre&&p.nombre!=='EdenRoomsConsulta');
  try{
    const sala=await env.DB.prepare(
      'SELECT a.nombre FROM salas_autorizadas a INNER JOIN salas_endpoints e ON e.sala_id=a.sala_id WHERE a.sala_id=? AND a.autorizada=1 AND e.direccion IS NOT NULL AND e.puerto BETWEEN 1 AND 65535'
    ).bind(id).first();
    if(!sala)return json({error:'Sala publica no autorizada o sin endpoint registrado'},403);
    await env.DB.prepare(
      'INSERT INTO versiones_salas (sala_id,nombre_sala,jugadores_json,actualizado_en) VALUES (?,?,?,?) ON CONFLICT(sala_id) DO UPDATE SET nombre_sala=excluded.nombre_sala,jugadores_json=excluded.jugadores_json,actualizado_en=excluded.actualizado_en'
    ).bind(id,String(sala.nombre),JSON.stringify(players),new Date(when).toISOString()).run();
    return json({ok:true,sala_id:id,jugadores:players.length});
  }catch{return json({error:'No se pudieron guardar las versiones'},503)}
}
