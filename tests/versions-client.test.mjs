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
    const html=playerListMarkup([p]);assert.ok(html.includes('Mario Kart 8 Deluxe'));assert.ok(!html.includes('class="player-version"'));
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


test('opening, refreshing, closing and reopening never enqueue; manual click does',async()=>{
  let calls=0,clock=now;
  const current={...room,players:[{...player,virtual_ip:observation.virtual_ip}]};
  const client=createVersionsClient({now:()=>clock,fetcher:async(url,options)=>{
    calls++;return Response.json(options.method==='POST'?{estado:'listo'}:{...snapshot,consultado_en:new Date(clock).toISOString()});
  }});
  client.open(current);await client.refresh([current]);assert.equal(calls,0);
  await Promise.all([client.query(current),client.query(current)]);assert.equal(calls,2);
  assert.equal(client.decorate(current).players[0].gameVersion,'4.0.1');
  clock+=8*3600000;client.retain([current]);await client.refresh([current]);
  assert.ok(playerListMarkup(client.decorate(current).players).includes('Versión 4.0.1'));
  assert.equal(client.status(current).consultedAt,snapshot.consultado_en);
  client.close();client.open(current);await client.refresh([current]);assert.equal(calls,2);
  assert.equal(client.decorate(current).players[0].gameVersion,'4.0.1');
  await client.query(current);assert.equal(calls,4);
  assert.equal(client.status(current).consultedAt,new Date(clock).toISOString());
});
test('directory roster remains live without manual queries',async()=>{
  let calls=0;const client=createVersionsClient({fetcher:async()=>{calls++;throw Error();}});
  client.open(room);
  const next={...room,players:[{nickname:'New',gameName:'Game'}]};
  client.retain([next]);await client.refresh([next]);
  assert.deepEqual(client.decorate(next).players,next.players);assert.equal(calls,0);
  assert.match(playerListMarkup(next.players),/Versión sin consultar/);
});
test('versions require unique name/IP, current game/title and uninterrupted presence',async()=>{
  const current={...room,players:[{...player,virtual_ip:observation.virtual_ip}]};
  const client=createVersionsClient({now:()=>now,fetcher:async(url,options)=>Response.json(options.method==='POST'?{estado:'listo'}:snapshot)});
  await client.query(current);
  for(const changed of [{...player}, {...player,virtual_ip:'10.166.1.2'},
    {...current.players[0],gameName:'Other'}, {...current.players[0],gameId:'1'}]){
    assert.equal(client.decorate({...room,players:[changed]}).players[0].gameVersion,undefined);
  }
  assert.ok(client.decorate({...current,players:[current.players[0],current.players[0]]}).players.every(p=>!p.gameVersion));
  const next={...current,players:[...current.players,{nickname:'New',gameName:player.gameName,virtual_ip:'10.166.1.2'}]};
  client.retain([next]);assert.equal(client.decorate(next).players.length,2);
  assert.equal(client.decorate(next).players[0].gameVersion,'4.0.1');
  assert.equal(client.decorate(next).players[1].gameVersion,undefined);
  client.retain([{...current,players:[]}]);assert.equal(client.decorate({...current,players:[]}).players.length,0);
  client.retain([current]);assert.equal(client.decorate(current).players[0].gameVersion,undefined,'returning identity needs manual refresh');
  assert.equal(client.decorate({...current,versionsRoomId:'other'}).players[0].gameVersion,undefined);
  await client.query(current);assert.equal(client.decorate(current).players[0].gameVersion,'4.0.1');
});
test('pending status GETs never enqueue, duplicate clicks share work, timeout allows manual retry',async()=>{
  let clock=now,posts=0,gets=0;
  const client=createVersionsClient({now:()=>clock,fetcher:async(url,options)=>{
    if(options.method==='POST')posts++;else gets++;
    return Response.json({estado:'pendiente',espera_ms:45000});
  }});
  await client.query(room);await client.query(room);assert.equal(posts,1);
  clock+=2000;await client.refresh([room]);assert.equal(gets,1);
  clock+=45000;await client.refresh([room]);assert.match(client.status(room).text,/Pulsá Consultar/);
  clock+=600000;await client.refresh([room]);assert.equal(posts,1);
  await client.query(room);assert.equal(posts,2);
});
test('late closed query cannot overwrite a manually retried result',async()=>{
  const deferred=[];let snapshotReads=0;
  const client=createVersionsClient({now:()=>now,fetcher:(url,options)=>{
    if(options.method==='POST')return new Promise(resolve=>deferred.push(resolve));
    snapshotReads++;return Promise.resolve(Response.json(snapshot));
  }});
  const first=client.query(room);client.close();client.open(room);
  const second=client.query(room);
  deferred[1](Response.json({estado:'pendiente',espera_ms:45000}));await second;
  deferred[0](Response.json({estado:'listo'}));await first;
  assert.equal(snapshotReads,0);assert.equal(client.status(room).text,'Consultando versiones…');
});
test('expired, cross-room and wrong endpoint responses cannot be accepted',async()=>{
  for(const invalid of [{...snapshot,consultado_en:new Date(now-120000).toISOString()},
    {...snapshot,sala_id:'other'},{...snapshot,endpoint:{direccion:'other.test',puerto:20668}}]){
    const client=createVersionsClient({now:()=>now,fetcher:async(url,options)=>Response.json(options.method==='POST'?{estado:'listo'}:invalid)});
    await client.query(room);assert.match(client.status(room).text,/No se pudieron/);
    assert.equal(client.decorate(room).players[0].gameVersion,undefined);
  }
});
test('unregistered rooms cannot query, including temporary missing registration metadata',async()=>{
  let calls=0;const client=createVersionsClient({fetcher:async()=>{calls++;return Response.json({estado:'pendiente',espera_ms:45000});}});
  await client.query({...room,versionsRoomId:undefined});assert.equal(calls,0);
  await client.query(room);await client.query({...room,versionsRoomId:undefined});assert.equal(calls,1);
});

test('lost POST acknowledgement never retries automatically, including card reopen',async()=>{
  let posts=0;
  const client=createVersionsClient({fetcher:(url,options)=>{
    posts++;return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new DOMException('paused','AbortError'))));
  }});
  const pending=client.query(room);client.abort();await pending;
  client.close();client.open(room);await client.refresh([room]);assert.equal(posts,1);
});
test('missing or ambiguous snapshot IP cannot be assigned even to a unique lobby name',async()=>{
  const current={...room,players:[{...player,virtual_ip:observation.virtual_ip}]};
  for(const jugadores of [[{...observation,virtual_ip:undefined}], [observation,{...observation,virtual_ip:'invalid'}]]){
    const client=createVersionsClient({now:()=>now,fetcher:async(url,options)=>Response.json(options.method==='POST'?{estado:'listo'}:{...snapshot,jugadores})});
    await client.query(current);assert.equal(client.decorate(current).players[0].gameVersion,undefined);
  }
});
