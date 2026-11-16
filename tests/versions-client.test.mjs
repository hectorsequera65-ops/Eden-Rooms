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
test('browser reuses the full 120s TTL, deduplicates inflight requests and drops expired data on errors',async()=>{
  let clock=now,calls=0,fail=false,release;
  const client=createVersionsClient({now:()=>clock,fetcher:async(url)=>{
    calls++;assert.equal(url,'/api/versiones-sala?id=sala-prueba-20668');
    if(release!==null)await new Promise(resolve=>{release=resolve});
    if(fail)throw Error('offline');
    return Response.json(snapshot);
  }});
  const first=client.refresh([room]);const second=client.refresh([room]);
  assert.equal(calls,1);release();release=null;await Promise.all([first,second]);
  assert.equal(client.decorate(room).players[0].gameVersion,'4.0.1');
  clock+=29999;await client.refresh([room]);assert.equal(calls,1);
  clock+=1;await client.refresh([room]);assert.equal(calls,1);
  assert.equal(client.decorate(room).players[0].gameVersion,'4.0.1');
  clock=now+120000;fail=true;await client.refresh([room]);assert.equal(calls,2);
  assert.equal(client.decorate(room).players[0].gameVersion,undefined);
  assert.equal(client.status(room.versionsRoomId).retry,true);
});
test('only registered occupied rooms are fetched; unavailable results are cached without retry storms',async()=>{
  let calls=0;
  const client=createVersionsClient({now:()=>now,fetcher:async()=>{calls++;return Response.json({disponible:false,sala_id:room.versionsRoomId,jugadores:[]});}});
  await client.refresh([{...room,players:[]},{...room,versionsRoomId:undefined}]);assert.equal(calls,0);
  await client.refresh([room,room]);await client.refresh([room]);assert.equal(calls,2);
  assert.equal(client.decorate(room).players[0].gameVersion,undefined);
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

test('on-demand request sends only ID, polls the public status, then reads fresh versions',async()=>{
  let clock=now,ready=false;const requests=[];
  const client=createVersionsClient({now:()=>clock,fetcher:async(url,options)=>{
    requests.push({url,options});
    if(url.startsWith('/api/versiones-sala'))return Response.json(ready?snapshot:{disponible:false,sala_id:room.versionsRoomId,jugadores:[]});
    if(options.method==='POST'){
      assert.deepEqual(JSON.parse(options.body),{sala_id:room.versionsRoomId});
      assert.equal(options.headers['X-API-Key'],undefined);assert.equal(options.headers['X-Collector-Key'],undefined);
      return Response.json({sala_id:room.versionsRoomId,estado:'pendiente',espera_ms:45000},{status:202});
    }
    ready=true;return Response.json({sala_id:room.versionsRoomId,estado:'listo'});
  }});
  await Promise.all([client.refresh([room]),client.refresh([room])]);
  assert.equal(requests.length,2);assert.equal(client.status(room.versionsRoomId).text,'Consultando versiones…');
  clock+=1999;await client.refresh([room]);assert.equal(requests.length,2);
  clock+=1;await client.refresh([room]);assert.equal(requests.length,4);
  assert.equal(client.status(room.versionsRoomId),null);assert.equal(client.decorate(room).players[0].gameVersion,'4.0.1');
  assert.ok(requests.every(r=>!r.url.startsWith('/api/collector')));
});
test('offline Ubuntu times out at 45s, offers retry and never silently re-enqueues',async()=>{
  let clock=now,calls=0;
  const client=createVersionsClient({now:()=>clock,fetcher:async(url,options)=>{
    calls++;
    if(url.startsWith('/api/versiones-sala'))return Response.json({disponible:false,sala_id:room.versionsRoomId});
    return Response.json({sala_id:room.versionsRoomId,estado:'pendiente',espera_ms:45000});
  }});
  await client.refresh([room]);assert.equal(calls,2);
  clock+=45000;await client.refresh([room]);assert.equal(calls,2);
  assert.equal(client.status(room.versionsRoomId).retry,true);
  assert.equal(client.decorate(room).players[0].gameVersion,undefined);
  await client.refresh([room]);assert.equal(calls,2);
  clock+=15000;client.retry(room.versionsRoomId);await client.refresh([room]);assert.equal(calls,4);
});
