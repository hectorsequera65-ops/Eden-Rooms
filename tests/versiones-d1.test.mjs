// Real SQLite SQL execution with an adapter for the D1 prepare/bind interface.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {onRequestPost as ingest} from '../functions/api/versiones-multiples.js';
import {onRequestPost as validate} from '../functions/api/versiones-validar.js';
import {onRequestGet as roomsAPI} from '../functions/api/rooms.js';
import {onRequestGet as roomVersions} from '../functions/api/versiones-sala.js';
function setup(){
  const sqlite=new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('./fixtures/versions-schema.sql',import.meta.url),'utf8'));
  sqlite.prepare('INSERT INTO salas_autorizadas VALUES (?,?,?)').run('eu-official','EU Official',1);
  sqlite.prepare('INSERT INTO salas_endpoints VALUES (?,?,?)').run('eu-official','room.example.test',6007);
  const DB={prepare(sql){const statement=sqlite.prepare(sql);const bound=(values=[])=>({
    bind:(...params)=>bound(params),first:async()=>statement.get(...values)??null,
    all:async()=>({results:statement.all(...values)}),run:async()=>({meta:statement.run(...values)})
  });return bound();}};
  const env={DB,VERSIONES_API_KEY:'write-test-key'};
  const player=name=>({nombre:name,juego:'Mario Kart 8 Deluxe',title_id:'0100152000022000',version:'4.0.1'});
  const payload={sala_id:'eu-official',consultado_en:new Date().toISOString(),jugadores:[player('Eden'),player('SataHT')]};
  function context(data=payload,key='write-test-key',path='versiones-multiples'){
    return {env,request:new Request('https://example.test/api/'+path,{method:'POST',headers:{'Content-Type':'application/json','X-API-Key':key},body:JSON.stringify(data)})};
  }
  return {sqlite,env,payload,context};
}
test('validation runs authentication and schema checks without inserting or replacing a snapshot',async()=>{
  const {sqlite,payload,context}=setup();
  try{
    let response=await validate(context());
    assert.equal(response.status,200);assert.deepEqual(await response.json(),{ok:true,validado:true,escritura:false,sala_id:'eu-official',jugadores:2});
    assert.equal(sqlite.prepare('SELECT count(*) AS n FROM versiones_salas').get().n,0);
    await ingest(context());
    const before=sqlite.prepare('SELECT * FROM versiones_salas').get();
    response=await validate(context({...payload,jugadores:[]}));assert.equal(response.status,200);
    assert.deepEqual(sqlite.prepare('SELECT * FROM versiones_salas').get(),before);
    assert.equal((await validate(context(payload,'wrong'))).status,401);
    assert.equal((await validate(context({...payload,sala_id:'unknown'}))).status,403);
    sqlite.exec('DROP TABLE versiones_salas');
    assert.equal((await validate(context())).status,503);
  }finally{sqlite.close();}
});
test('real SQL stores title and version and rooms API enriches exact current players',async(t)=>{
  const {sqlite,env,context}=setup();
  try{
    assert.equal((await ingest(context())).status,200);
    const stored=JSON.parse(sqlite.prepare('SELECT jugadores_json FROM versiones_salas').get().jugadores_json);
    assert.equal(stored[1].title_id,'0100152000022000');assert.equal(stored[1].version,'4.0.1');
    const players=['Eden','SataHT'].map(nickname=>({nickname,gameName:'Mario Kart 8 Deluxe',gameId:BigInt('0x0100152000022000').toString()}));
    t.mock.method(globalThis,'fetch',async()=>Response.json({rooms:[{address:'room.example.test',port:6007,players}]}));
    let response=await roomsAPI({env});let body=await response.json();
    assert.deepEqual(body.rooms[0].players.map(p=>p.gameVersion),['4.0.1','4.0.1']);
    assert.equal(body.rooms[0].players[0].gameTitleId,'0100152000022000');
    response=await roomVersions({env,request:new Request('https://example.test/api/versiones-sala?id=eu-official')});
    assert.equal((await response.json()).disponible,true);
    sqlite.prepare('UPDATE versiones_salas SET actualizado_en=?').run(new Date(Date.now()-121000).toISOString());
    body=await (await roomsAPI({env})).json();assert.equal(body.rooms[0].players[0].gameVersion,undefined);
  }finally{sqlite.close();}
});
test('upsert does not replace newer snapshots; stale data and missing bindings/keys are rejected',async()=>{
  const {sqlite,env,payload,context}=setup();
  try{
    await ingest(context());
    const prior=sqlite.prepare('SELECT * FROM versiones_salas').get();
    const earlier={...payload,consultado_en:new Date(Date.now()-60000).toISOString(),jugadores:[]};
    assert.equal((await ingest(context(earlier))).status,200);
    assert.deepEqual(sqlite.prepare('SELECT * FROM versiones_salas').get(),prior);
    assert.equal((await ingest(context({...earlier,consultado_en:new Date(Date.now()-121000).toISOString()}))).status,400);
    const missing=context();missing.env={VERSIONES_API_KEY:env.VERSIONES_API_KEY};assert.equal((await validate(missing)).status,503);
    const missingKey=context();missingKey.env={DB:env.DB};assert.equal((await validate(missingKey)).status,503);
  }finally{sqlite.close();}
});

test('registered rooms expose their stable version ID even before a snapshot exists',async(t)=>{
  const {sqlite,env}=setup();
  try{
    t.mock.method(globalThis,'fetch',async()=>Response.json({rooms:[{address:'room.example.test',port:6007,players:[{nickname:'Eden',gameName:'Mario Kart 8 Deluxe'}]}]}));
    const body=await (await roomsAPI({env})).json();
    assert.equal(body.rooms[0].versionsRoomId,'eu-official');
    assert.equal(body.rooms[0].players[0].gameVersion,undefined);
    const result=await roomVersions({env,request:new Request('https://example.test/api/versiones-sala?id=eu-official')});
    assert.deepEqual(await result.json(),{disponible:false,sala_id:'eu-official',jugadores:[]});
  }finally{sqlite.close();}
});

test('SQL and rooms preserve numeric Title IDs and resolve homonyms with virtual IPs',async(t)=>{
  const {sqlite,env,payload,context}=setup();
  try{
    const title='01006A800016E000',game='Super Smash Bros. Ultimate';
    const players=[{nombre:'Eden',juego:game,version:'13.0.2',title_id:title,virtual_ip:'10.166.1.1'},
      {nombre:'Eden',juego:game,version:'13.0.5',title_id:title,virtual_ip:'10.166.1.2'}];
    assert.equal((await ingest(context({...payload,jugadores:players}))).status,200);
    const id=BigInt('0x'+title).toString();
    t.mock.method(globalThis,'fetch',async()=>new Response(`{"rooms":[{"address":"room.example.test","port":6007,"players":[{"nickname":"Eden","gameName":"${game}","gameId":${id},"fakeIp":[10,166,1,1]},{"nickname":"Eden","gameName":"${game}","gameId":${id},"fakeIp":"10.166.1.2"}]}]}`));
    const body=await (await roomsAPI({env})).json();
    assert.deepEqual(body.rooms[0].players.map(p=>p.gameVersion),['13.0.2','13.0.5']);
    assert.equal(body.rooms[0].players[0].gameId,id);
    const data=await (await roomVersions({env,request:new Request('https://example.test/api/versiones-sala?id=eu-official')})).json();
    assert.deepEqual(data.endpoint,{direccion:'room.example.test',puerto:6007});
    assert.equal(Date.parse(data.expira_en)-Date.parse(data.consultado_en),120000);
  }finally{sqlite.close();}
});
