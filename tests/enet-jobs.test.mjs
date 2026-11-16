import {test} from 'node:test';
import assert from 'node:assert/strict';
import {jobsDB} from './helpers/jobs-db.mjs';
import {PREVIEW_HOST,publicJobRequest,privateJobRequest,publicIPv4} from '../lib/enet-jobs.js';
import {onRequestGet as versions} from '../functions/api/versiones-sala.js';
const base='https://'+PREVIEW_HOST;
function setup(){
  const data=jobsDB();data.room();
  const env={DB:data.DB,ENET_JOBS_ENABLED:'true',CF_PAGES_BRANCH:'test/enet-versions-sralcer',COLLECTOR_API_KEY:'collector-secret',VERSIONES_API_KEY:'write-secret'};
  const request=(path,body,headers={})=>new Request(base+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',Origin:base,'CF-Connecting-IP':'8.8.8.8',...headers},body:body===undefined?undefined:JSON.stringify(body)});
  const ask=(id='smash',now=Date.now())=>publicJobRequest({env,request:request('/api/versiones-consultar',{sala_id:id})},now);
  const poll=(data,now=Date.now(),key='collector-secret')=>privateJobRequest({env,request:request('/api/collector/jobs',data,{'X-Collector-Key':key})},now);
  return {...data,env,request,ask,poll};
}
const snapshot=(now,id='smash')=>({sala_id:id,consultado_en:new Date(now).toISOString(),jugadores:[{nombre:'Eden',juego:'Super Smash Bros. Ultimate',title_id:'01006A800016E000',version:'13.0.5',virtual_ip:'10.166.1.1'}]});
test('queue is disabled outside explicit Preview and private access uses a separate key',async()=>{
  const c=setup();try{
    c.env.ENET_JOBS_ENABLED='false';assert.equal((await c.ask()).status,404);
    c.env.ENET_JOBS_ENABLED='true';
    assert.equal((await publicJobRequest({env:c.env,request:new Request('https://eden-rooms.pages.dev/api/versiones-consultar?id=smash')})).status,404);
    c.env.CF_PAGES_BRANCH='main';assert.equal((await c.ask()).status,404);
    c.env.CF_PAGES_BRANCH='test/enet-versions-sralcer';
    for(const key of ['','wrong','write-secret'])assert.equal((await c.poll({action:'claim'},Date.now(),key)).status,401);
    assert.equal((await c.poll({action:'claim'})).status,200);
  }finally{c.sqlite.close();}
});
test('visitors cannot send endpoints, cross-site requests, unknown IDs or non-public destinations',async()=>{
  const c=setup();try{
    const extra=await publicJobRequest({env:c.env,request:c.request('/api/versiones-consultar',{sala_id:'smash',direccion:'8.8.8.8',puerto:1})});assert.equal(extra.status,400);
    assert.equal((await publicJobRequest({env:c.env,request:c.request('/api/versiones-consultar',{sala_id:'smash'},{Origin:'https://evil.test'})})).status,403);
    assert.equal((await c.ask('unknown')).status,403);
    for(const [index,address] of ['127.0.0.1','10.0.0.1','172.16.0.1','192.168.1.1','169.254.169.254','100.64.0.1','0.0.0.0','224.0.0.1','255.255.255.255','::1','localhost','room.example.com','2130706433','0x7f000001','192.0.2.1','198.51.100.1','203.0.113.1'].entries()){
      c.room('blocked'+index,address);assert.equal((await c.ask('blocked'+index)).status,403,address);
    }
    assert.equal(publicIPv4('69.24.117.72'),true);assert.equal(publicIPv4('069.24.117.72'),false);
    assert.equal(c.sqlite.prepare('SELECT count(*) AS n FROM enet_version_jobs').get().n,0);
  }finally{c.sqlite.close();}
});
test('concurrent visitors create one job and public responses never expose lease or destination',async()=>{
  const c=setup();try{
    const now=Date.now();const results=await Promise.all(Array.from({length:10},()=>c.ask('smash',now)));
    for(const response of results){assert.equal(response.status,202);const text=await response.text();assert.ok(!text.includes('lease_token'));assert.ok(!text.includes('69.24.117.72'));assert.ok(text.includes('pendiente'));}
    assert.equal(c.sqlite.prepare('SELECT count(*) AS n FROM enet_version_jobs').get().n,1);
  }finally{c.sqlite.close();}
});
test('global atomic leases cap concurrency at two; completion stores compatible snapshots once',async()=>{
  const c=setup();try{
    const now=Date.now();c.room('second');c.room('third');
    await c.ask('smash',now);await c.ask('second',now);await c.ask('third',now);
    const claimed=await Promise.all(Array.from({length:3},()=>c.poll({action:'claim'},now)));
    const jobs=await Promise.all(claimed.map(r=>r.json()));
    assert.equal(jobs.filter(j=>j.trabajo).length,2);assert.equal(new Set(jobs.filter(j=>j.trabajo).map(j=>j.trabajo.job_id)).size,2);
    const job=jobs.find(j=>j.trabajo).trabajo;
    const completed={action:'complete',job_id:job.job_id,lease_token:job.lease_token,snapshot:snapshot(now,job.sala_id)};
    assert.equal((await c.poll(completed,now+1000)).status,200);
    assert.equal((await c.poll(completed,now+1000)).status,409);
    const stored=JSON.parse(c.sqlite.prepare('SELECT jugadores_json FROM versiones_salas WHERE sala_id=?').get(job.sala_id).jugadores_json);
    assert.equal(stored[0].version,'13.0.5');assert.equal(stored[0].title_id,'01006A800016E000');
    const data=await (await versions({env:c.env,request:c.request('/api/versiones-sala?id='+job.sala_id)})).json();assert.equal(data.disponible,true);
    assert.equal((await (await publicJobRequest({env:c.env,request:c.request('/api/versiones-consultar?id='+job.sala_id)},now+1000)).json()).estado,'listo');
    assert.ok((await (await c.poll({action:'claim'},now+1000)).json()).trabajo);
  }finally{c.sqlite.close();}
});
test('expired leases are fenced, bounded waits become retryable errors and old tokens cannot write',async()=>{
  const c=setup();try{
    const now=Date.now();await c.ask('smash',now);
    const job=(await (await c.poll({action:'claim'},now)).json()).trabajo;
    const completed={action:'complete',job_id:job.job_id,lease_token:job.lease_token,snapshot:snapshot(now)};
    assert.equal((await c.poll(completed,now+31000)).status,409);
    assert.equal(c.sqlite.prepare('SELECT count(*) AS n FROM versiones_salas').get().n,0);
    assert.equal((await c.ask('smash',now+31000)).status,429);
    assert.equal((await c.ask('smash',now+47000)).status,202);
    assert.equal((await c.poll(completed,now+47000)).status,409);
    const other=(await (await c.poll({action:'claim'},now+47000)).json()).trabajo;assert.notEqual(other.job_id,job.job_id);
    const status=await publicJobRequest({env:c.env,request:c.request('/api/versiones-consultar?id=smash')},now+93000);
    assert.equal((await status.json()).estado,'error');
  }finally{c.sqlite.close();}
});
test('fresh 120-second data does not suppress opening requests or hide a pending job',async()=>{
  const c=setup();try{
    const now=Date.now();c.sqlite.prepare('INSERT INTO versiones_salas VALUES (?,?,?,?)').run('smash','Smash','[]',new Date(now).toISOString());
    assert.equal((await c.ask('smash',now+1000)).status,202);
    assert.equal(c.sqlite.prepare('SELECT count(*) AS n FROM enet_version_jobs').get().n,1);
    const state=await publicJobRequest({env:c.env,request:c.request('/api/versiones-consultar?id=smash')},now+1001);
    assert.equal((await state.json()).estado,'pendiente');
    const job=(await (await c.poll({action:'claim'},now+1001)).json()).trabajo;
    c.sqlite.prepare('UPDATE salas_endpoints SET direccion=? WHERE sala_id=?').run('8.8.8.8','smash');
    const completed={action:'complete',job_id:job.job_id,lease_token:job.lease_token,snapshot:snapshot(now+1001)};
    assert.equal((await c.poll(completed,now+2000)).status,409);
    c.sqlite.prepare('UPDATE salas_autorizadas SET autorizada=0').run();assert.equal((await c.ask('smash',now+2000)).status,403);
  }finally{c.sqlite.close();}
});
test('reopening after completion creates a new job; status GETs alone never restart expired data',async()=>{
  const c=setup();try{
    const now=Date.now();await c.ask('smash',now);
    const first=(await (await c.poll({action:'claim'},now)).json()).trabajo;
    assert.equal((await c.poll({action:'complete',job_id:first.job_id,lease_token:first.lease_token,snapshot:snapshot(now)},now+1)).status,200);
    assert.equal((await c.ask('smash',now+1000)).status,202);
    const second=(await (await c.poll({action:'claim'},now+1000)).json()).trabajo;
    assert.notEqual(second.job_id,first.job_id);
    assert.equal((await c.ask('smash',now+1001)).status,202);
    assert.equal(c.sqlite.prepare('SELECT job_id FROM enet_version_jobs').get().job_id,second.job_id);
    assert.equal((await c.poll({action:'complete',job_id:second.job_id,lease_token:second.lease_token,snapshot:snapshot(now+1001)},now+1002)).status,200);
    for(const elapsed of [1003,120000,240000,600000]){
      await publicJobRequest({env:c.env,request:c.request('/api/versiones-consultar?id=smash')},now+elapsed);
      assert.equal(c.sqlite.prepare('SELECT status FROM enet_version_jobs').get().status,'done');
      assert.equal((await (await c.poll({action:'claim'},now+elapsed)).json()).trabajo,null);
    }
  }finally{c.sqlite.close();}
});
test('per-IP rate limits and global queue capacity bound abuse',async()=>{
  const c=setup();try{
    const now=Date.now();for(let i=0;i<11;i++)c.room('room'+i);
    for(let i=0;i<10;i++)assert.equal((await c.ask('room'+i,now)).status,202);
    assert.equal((await c.ask('room10',now)).status,429);
    assert.equal((await c.ask('room10',now+61000)).status,202);
    c.sqlite.prepare('DELETE FROM enet_version_jobs').run();
    for(let i=0;i<50;i++)c.sqlite.prepare('INSERT INTO enet_version_jobs(job_id,sala_id,direccion,puerto,status,created_at,deadline_at) VALUES (?,?,?,?,?,?,?)').run('job'+i,'full'+i,'69.24.117.72',20668,'pending',now,now+45000);
    assert.equal((await c.ask('smash',now+1000)).status,429);
    assert.equal(c.sqlite.prepare('SELECT count(*) AS n FROM enet_version_jobs').get().n,50);
  }finally{c.sqlite.close();}
});
test('transaction guards reject a lease lost after initial validation without inserting a snapshot',async()=>{
  const c=setup();try{
    const now=Date.now();await c.ask('smash',now);const job=(await (await c.poll({action:'claim'},now)).json()).trabajo;
    const batch=c.env.DB.batch.bind(c.env.DB);
    c.env.DB.batch=async statements=>{c.sqlite.prepare("UPDATE enet_version_jobs SET status='error',lease_token=NULL").run();return batch(statements);};
    const result=await c.poll({action:'complete',job_id:job.job_id,lease_token:job.lease_token,snapshot:snapshot(now)},now+1);
    assert.equal(result.status,409);assert.equal(c.sqlite.prepare('SELECT count(*) AS n FROM versiones_salas').get().n,0);
  }finally{c.sqlite.close();}
});

test('public JSON bodies are byte-bounded and collector failures release only their own lease',async()=>{
  const c=setup();try{
    const oversized=c.request('/api/versiones-consultar',{sala_id:'smash',padding:'x'.repeat(1000)});
    assert.equal((await publicJobRequest({env:c.env,request:oversized})).status,413);
    const wrongType=c.request('/api/versiones-consultar',{sala_id:'smash'},{'Content-Type':'text/plain'});
    assert.equal((await publicJobRequest({env:c.env,request:wrongType})).status,415);
    const now=Date.now();await c.ask('smash',now);const job=(await (await c.poll({action:'claim'},now)).json()).trabajo;
    const fail={action:'fail',job_id:job.job_id,lease_token:crypto.randomUUID()};
    assert.equal((await c.poll(fail,now)).status,409);
    assert.equal(c.sqlite.prepare('SELECT status FROM enet_version_jobs').get().status,'running');
    fail.lease_token=job.lease_token;assert.equal((await c.poll(fail,now)).status,200);
    const status=await (await publicJobRequest({env:c.env,request:c.request('/api/versiones-consultar?id=smash')},now)).json();
    assert.equal(status.estado,'error');assert.equal(status.reintentar_en_ms,15000);
    assert.equal(c.sqlite.prepare('SELECT count(*) AS n FROM versiones_salas').get().n,0);
  }finally{c.sqlite.close();}
});

test('endpoint changes cannot relabel a previous completed snapshot as current',async()=>{
  const c=setup();try{
    const now=Date.now();await c.ask('smash',now);const job=(await (await c.poll({action:'claim'},now)).json()).trabajo;
    assert.equal((await c.poll({action:'complete',job_id:job.job_id,lease_token:job.lease_token,snapshot:snapshot(now)},now)).status,200);
    c.sqlite.prepare("UPDATE salas_endpoints SET direccion='8.8.8.8' WHERE sala_id='smash'").run();
    const data=await (await versions({env:c.env,request:c.request('/api/versiones-sala?id=smash')})).json();
    assert.equal(data.disponible,false);
    assert.equal((await c.ask('smash',now+1)).status,202);
  }finally{c.sqlite.close();}
});

test('public job states distinguish collector failure and timeout from completed empty snapshot',async()=>{
  const c=setup();try{
    const now=Date.now();await c.ask('smash',now);
    let job=(await (await c.poll({action:'claim'},now)).json()).trabajo;
    await c.poll({action:'fail',job_id:job.job_id,lease_token:job.lease_token},now+1000);
    let state=await (await publicJobRequest({env:c.env,request:c.request('/api/versiones-consultar?id=smash')},now+1001)).json();
    assert.equal(state.estado,'error');assert.equal(state.motivo,'collector');
    await c.ask('smash',now+17000);
    job=(await (await c.poll({action:'claim'},now+17000)).json()).trabajo;
    await c.poll({action:'complete',job_id:job.job_id,lease_token:job.lease_token,snapshot:{...snapshot(now+17000),jugadores:[]}},now+18000);
    state=await (await publicJobRequest({env:c.env,request:c.request('/api/versiones-consultar?id=smash')},now+18001)).json();
    assert.equal(state.estado,'listo');assert.equal(state.motivo,undefined);
    const result=await (await versions({env:c.env,request:c.request('/api/versiones-sala?id=smash')})).json();
    assert.equal(result.disponible,true);assert.deepEqual(result.jugadores,[]);
    const stale=await (await publicJobRequest({env:c.env,request:c.request('/api/versiones-consultar?id=smash')},now+150000)).json();
    assert.equal(stale.motivo,'snapshot','a completed expired result is not a collector timeout');
    await c.ask('smash',now+19000);
    state=await (await publicJobRequest({env:c.env,request:c.request('/api/versiones-consultar?id=smash')},now+65000)).json();
    assert.equal(state.estado,'error');assert.equal(state.motivo,'timeout');
  }finally{c.sqlite.close();}
});
