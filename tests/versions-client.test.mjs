import {test} from 'node:test';
import assert from 'node:assert/strict';
import {applyRoomSnapshot, createVersionsClient, mergeVersionPlayers, playerGameVersion, playerListMarkup} from '../assets/player-versions.js';
import {parseLobbyJSON} from '../lib/lobby-json.js';
const now=Date.now();
const player={nickname:'Eden',gameName:'Mario Kart 8 Deluxe'};
const observation={nombre:'Eden',juego:'Mario Kart 8 Deluxe',title_id:'0100152000022000',version:'4.0.1',virtual_ip:'10.166.1.1'};
const room={address:'room.test',port:20668,versionsRoomId:'sala-prueba-20668',players:[player]};
const snapshot={disponible:true,sala_id:room.versionsRoomId,consultado_en:new Date(now).toISOString(),jugadores:[observation]};
test('maps exact registered room and displays version using existing player-row classes',()=>{
  const enriched=applyRoomSnapshot(room,snapshot,now);
  const html=playerListMarkup(enriched.players);
  assert.ok(html.includes('👤 Eden'));assert.ok(html.includes('Mario Kart 8 Deluxe'));
  assert.ok(html.includes('<span class="player-version">Versión 4.0.1</span>'));
  assert.equal(room.players[0].gameVersion,undefined);
  assert.equal(enriched.players[0].gameTitleId,'0100152000022000');
});
test('unavailable, cross-room, endpoint mismatch, stale and boundary timestamps show only game',()=>{
  for(const data of [null,{...snapshot,disponible:false},{...snapshot,sala_id:'different'},
    {...snapshot,endpoint:{direccion:'other.test',puerto:20668}},
    {...snapshot,consultado_en:new Date(now-120000).toISOString()},
    {...snapshot,consultado_en:new Date(now+31000).toISOString()}]){
    const p=applyRoomSnapshot(room,data,now).players[0];assert.equal(p.gameVersion,undefined);
    const html=playerListMarkup([p]);assert.ok(html.includes('Mario Kart 8 Deluxe'));assert.ok(!html.includes('player-version'));
  }
});
test('homonyms match by name plus virtual IP; uncertain or conflicting matches are omitted',()=>{
  const players=[{...player,fakeIp:[10,166,1,1]},{...player,virtual_ip:'10.166.1.2'}];
  const observed=[observation,{...observation,virtual_ip:'10.166.1.2',version:'4.0.2'}];
  assert.deepEqual(mergeVersionPlayers(players,observed).map(p=>p.gameVersion),['4.0.1','4.0.2']);
  assert.ok(mergeVersionPlayers([player,player],observed).every(p=>!p.gameVersion));
  assert.equal(mergeVersionPlayers([{...player,fakeIp:'10.166.1.3'}],[observation])[0].gameVersion,undefined);
  assert.equal(mergeVersionPlayers(players,[...observed,observation])[0].gameVersion,undefined);
  assert.equal(mergeVersionPlayers([player],[{...observation,juego:'Different'}])[0].gameVersion,undefined);
});
test('HTML is escaped; stale ENet fields cannot resurrect from the rooms response',()=>{
  const stale={...player,gameVersion:'old',gameVersionSource:'enet',gameVersionObservedAt:new Date(now-120000).toISOString()};
  assert.equal(playerGameVersion(stale,now),'');
  assert.equal(applyRoomSnapshot({...room,players:[stale]},null,now).players[0].gameVersion,undefined);
  const html=playerListMarkup([{nickname:'<img src=x onerror=alert(1)>',gameName:'Game <script>',gameVersion:'<b>4</b>'}]);
  assert.ok(!html.includes('<script>'));assert.ok(!html.includes('<img'));assert.ok(html.includes('&lt;b&gt;'));
});
test('upstream numeric 64-bit IDs remain exact before matching',()=>{
  const text='{"rooms":[{"players":[{"nickname":"Eden","gameName":"Mario Kart 8 Deluxe","gameId":72080839745069056}],"port":20668}],"label":"12345678901234567890 \\\"gameId\\\":999999999999999999","decimal":1.5}';
  const data=parseLobbyJSON(text);
  assert.equal(data.rooms[0].players[0].gameId,'72080839745069056');assert.equal(data.rooms[0].port,20668);
  assert.equal(data.decimal,1.5);assert.ok(data.label.includes('12345678901234567890'));
  const numeric=BigInt('0x'+observation.title_id).toString();
  const p=parseLobbyJSON(`{"nickname":"Eden","gameName":"Mario Kart 8 Deluxe","gameId":${numeric}}`);
  assert.equal(mergeVersionPlayers([p],[observation])[0].gameVersion,'4.0.1');
  assert.throws(()=>parseLobbyJSON('{"invalid":}'));
});


test('only an explicit opening enqueues once; TTL and repeated refreshes never repeat work',async()=>{
  let clock=now;const requests=[];
  const client=createVersionsClient({now:()=>clock,fetcher:async(url,options)=>{
    requests.push({url,options});
    return Response.json(options.method==='POST'?{sala_id:room.versionsRoomId,estado:'listo'}:snapshot);
  }});
  await client.refresh([room]);assert.equal(requests.length,0);
  await Promise.all([client.open(room),client.open(room)]);
  assert.equal(requests.filter(r=>r.options.method==='POST').length,1);
  assert.equal(client.decorate(room).players[0].gameVersion,'4.0.1');
  for(let i=1;i<=10;i++){
    clock=now+i*60000;await client.refresh([room]);await client.open(room);client.retain([room]);
  }
  client.abort();await client.refresh([room]);
  assert.equal(requests.length,2,'only opening POST and final snapshot GET are allowed');
  assert.equal(client.decorate(room).players[0].gameVersion,undefined);
  assert.ok(client.status(room.versionsRoomId).text.includes('vencieron'));
});
test('closing and reopening enqueues again even with a snapshot younger than 120s',async()=>{
  let clock=now,posts=0;
  const client=createVersionsClient({now:()=>clock,fetcher:async(url,options)=>{
    if(options.method==='POST'){posts++;return Response.json({sala_id:room.versionsRoomId,estado:'listo'});}
    return Response.json(snapshot);
  }});
  await client.open(room);assert.equal(posts,1);
  clock+=1000;client.close(room.versionsRoomId);await client.refresh([room]);assert.equal(posts,1);
  await client.open(room);assert.equal(posts,2);
  await client.refresh([room]);assert.equal(posts,2);
});
test('pending status GETs never enqueue; completion stops all version polling',async()=>{
  let clock=now,ready=false;const requests=[];
  const client=createVersionsClient({now:()=>clock,fetcher:async(url,options)=>{
    requests.push({url,options});
    if(options.method==='POST'){
      assert.deepEqual(JSON.parse(options.body),{sala_id:room.versionsRoomId});
      assert.equal(options.headers['X-API-Key'],undefined);assert.equal(options.headers['X-Collector-Key'],undefined);
      return Response.json({sala_id:room.versionsRoomId,estado:'pendiente',espera_ms:45000},{status:202});
    }
    if(url.startsWith('/api/versiones-sala'))return Response.json(snapshot);
    return Response.json({sala_id:room.versionsRoomId,estado:ready?'listo':'consultando',espera_ms:43000});
  }});
  await client.open(room);await client.refresh([room]);assert.equal(requests.length,1);
  clock+=2000;await client.refresh([room]);assert.equal(requests.length,2);
  ready=true;clock+=2000;await client.refresh([room]);assert.equal(requests.length,4);
  assert.equal(client.status(room.versionsRoomId),null);
  for(let i=0;i<10;i++){clock+=60000;await client.refresh([room]);}
  assert.equal(requests.length,4);assert.equal(requests.filter(r=>r.options.method==='POST').length,1);
  assert.ok(requests.every(r=>!r.url.startsWith('/api/collector')));
});
test('offline timeout requires closing and reopening, not automatic retries while open',async()=>{
  let clock=now,posts=0;
  const client=createVersionsClient({now:()=>clock,fetcher:async()=>{posts++;return Response.json({sala_id:room.versionsRoomId,estado:'pendiente',espera_ms:45000});}});
  await client.open(room);assert.equal(posts,1);
  clock+=45000;await client.refresh([room]);assert.equal(posts,1);
  assert.ok(client.status(room.versionsRoomId).text.includes('Cerrá y volvé a abrir'));
  clock+=300000;await client.refresh([room]);await client.open(room);assert.equal(posts,1);
  client.close();await client.open(room);assert.equal(posts,2);
});
test('a late response from a closed opening cannot overwrite the reopened card',async()=>{
  const deferred=[];let calls=0;
  const client=createVersionsClient({now:()=>now,fetcher:(url,options)=>{
    calls++;assert.equal(options.method,'POST');
    return new Promise(resolve=>deferred.push(resolve));
  }});
  const first=client.open(room);client.close();const second=client.open(room);
  deferred[1](Response.json({sala_id:room.versionsRoomId,estado:'pendiente',espera_ms:45000}));await second;
  deferred[0](Response.json({sala_id:room.versionsRoomId,estado:'listo'}));await first;
  assert.equal(calls,2);assert.equal(client.status(room.versionsRoomId).text,'Consultando versiones…');
  await client.refresh([room]);assert.equal(calls,2);
});
test('lost POST acknowledgement or tab pause never causes a second POST in that opening',async()=>{
  let posts=0;
  const client=createVersionsClient({now:()=>now,fetcher:(url,options)=>{
    posts++;
    return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new DOMException('paused','AbortError'))));
  }});
  const pending=client.open(room);client.abort();await pending;
  await client.refresh([room]);await client.open(room);assert.equal(posts,1);
  assert.ok(client.status(room.versionsRoomId).text.includes('Cerrá y volvé a abrir'));
});
test('unregistered rooms never enqueue; registered empty rooms still query once on opening',async()=>{
  let calls=0;
  const client=createVersionsClient({now:()=>now,fetcher:async()=>{calls++;return Response.json({sala_id:room.versionsRoomId,estado:'pendiente',espera_ms:45000});}});
  await client.open({...room,versionsRoomId:undefined});assert.equal(calls,0);
  await client.open({...room,players:[]});await client.refresh([room]);assert.equal(calls,1);
});
