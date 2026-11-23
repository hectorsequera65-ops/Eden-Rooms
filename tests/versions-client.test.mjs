import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {applyRoomSnapshot, createVersionsClient, mergeVersionPlayers, playerGameVersion, playerListMarkup} from '../assets/player-versions.js';
import {parseLobbyJSON} from '../lib/lobby-json.js';
const now=Date.now();
const player={nickname:'Eden',gameName:'Mario Kart 8 Deluxe'};
const observation={nombre:'Eden',juego:'Mario Kart 8 Deluxe',title_id:'0100152000022000',version:'4.0.1',virtual_ip:'10.166.1.1'};
const room={address:'room.test',port:20668,versionsRoomId:'sala-prueba-20668',players:[player]};
const snapshot={disponible:true,sala_id:room.versionsRoomId,consultado_en:new Date(now).toISOString(),endpoint:{direccion:room.address,puerto:room.port},jugadores:[observation]};
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


test('one GET per click, with no reads on reopening or roster updates',async()=>{
  let calls=0,clock=now;
  const current={...room,players:[{...player,virtual_ip:observation.virtual_ip}]};
  const client=createVersionsClient({now:()=>clock,fetcher:async(url,options)=>{
    calls++;
    assert.equal(url, '/api/versiones-publicadas?id=' + room.versionsRoomId);
    assert.equal(options.method, 'GET');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.headers, undefined);
    return Response.json(snapshot);
  }});
  client.open(current);assert.equal(calls,0);
  await Promise.all([client.query(current),client.query(current)]);assert.equal(calls,1);
  assert.equal(client.decorate(current).players[0].gameVersion,'4.0.1');
  clock+=8*3600000;client.retain([current]);
  assert.ok(playerListMarkup(client.decorate(current).players).includes('Versión 4.0.1'));
  assert.equal(client.status(current).consultedAt,snapshot.consultado_en);
  client.close();client.open(current);assert.equal(calls,1);
  assert.equal(client.decorate(current).players[0].gameVersion,'4.0.1');
  await client.query(current);assert.equal(calls,2);
  assert.equal(client.status(current).consultedAt,snapshot.consultado_en);
});
test('directory roster remains live without manual queries',async()=>{
  let calls=0;const client=createVersionsClient({fetcher:async()=>{calls++;throw Error();}});
  client.open(room);
  const next={...room,players:[{nickname:'New',gameName:'Game'}]};
  client.retain([next]);
  assert.deepEqual(client.decorate(next).players,next.players);assert.equal(calls,0);
  const markup = playerListMarkup(next.players);
  assert.match(markup, /New/);
  assert.match(markup, /Game/);
  assert.doesNotMatch(markup, /player-version|Versión/);
});
test('version placeholders stay out of player rows without changing player data',()=>{
  for (const gameVersion of [null, ' ', 'Versión sin consultar', 'No disponible', 'Desconocida', 'Unknown', 'N/A']) {
    const player = {nickname:'Ana', gameName:'Game', gameVersion};
    const markup = playerListMarkup([player]);
    assert.match(markup, /Ana/);
    assert.match(markup, /Game/);
    assert.doesNotMatch(markup, /player-version|Versión/);
    assert.equal(player.gameVersion, gameVersion);
  }
  assert.match(playerListMarkup([{nickname:'Ana', gameName:'Game', gameVersion:'beta-1'}]), /Versión beta-1/);
});
test('versions require unique name/IP, current game/title and uninterrupted presence',async()=>{
  const current={...room,players:[{...player,virtual_ip:observation.virtual_ip}]};
  const client=createVersionsClient({now:()=>now,fetcher:async(url,options)=>Response.json(snapshot)});
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
test('late closed read cannot overwrite a manually retried result',async()=>{
  const deferred=[];
  const client=createVersionsClient({now:()=>now,fetcher:()=>new Promise(resolve=>deferred.push(resolve))});
  const first=client.query(room);
  await Promise.resolve();
  client.close();
  const second=client.query(room);
  await Promise.resolve();
  deferred[1](Response.json(snapshot));
  await second;
  deferred[0](Response.json({disponible:false,sala_id:room.versionsRoomId}));
  await first;
  assert.equal(client.status(room).consultedAt,snapshot.consultado_en);
});
test('future, cross-room and wrong endpoint responses cannot be accepted',async()=>{
  for(const invalid of [{...snapshot,consultado_en:new Date(now+31000).toISOString()},
    {...snapshot,sala_id:'other'},{...snapshot,endpoint:{direccion:'other.test',puerto:20668}}]){
    const client=createVersionsClient({now:()=>now,fetcher:async(url,options)=>Response.json(invalid)});
    await client.query(room);assert.match(client.status(room).text,/No se pudieron/);
    assert.equal(client.decorate(room).players[0].gameVersion,undefined);
  }
});
test('unregistered rooms cannot query, including temporary missing registration metadata',async()=>{
  let calls=0;const client=createVersionsClient({fetcher:async()=>{calls++;return Response.json({estado:'pendiente',espera_ms:45000});}});
  await client.query({...room,versionsRoomId:undefined});assert.equal(calls,0);
  await client.query(room);await client.query({...room,versionsRoomId:undefined});assert.equal(calls,1);
});

test('aborted read does not restart on reopening',async()=>{
  let reads=0;
  const client=createVersionsClient({fetcher:(url,options)=>{
    reads++;return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new DOMException('paused','AbortError'))));
  }});
  const pending=client.query(room);await Promise.resolve();client.abort();await pending;
  client.close();client.open(room);assert.equal(reads,1);
});
test('missing or ambiguous snapshot IP cannot be assigned even to a unique lobby name',async()=>{
  const current={...room,players:[{...player,virtual_ip:observation.virtual_ip}]};
  for(const jugadores of [[{...observation,virtual_ip:undefined}], [observation,{...observation,virtual_ip:'invalid'}]]){
    const client=createVersionsClient({now:()=>now,fetcher:async(url,options)=>Response.json({...snapshot,jugadores})});
    await client.query(current);assert.equal(client.decorate(current).players[0].gameVersion,undefined);
  }
});

// Public directory field layout captured from /lobby; player names and versions are fixtures.
const directoryRoom=parseLobbyJSON(readFileSync(new URL('./fixtures/lobby-smash-no-ip.json',import.meta.url),'utf8')).rooms[0];
const smashObservations=directoryRoom.players.map((p,i)=>({nombre:p.nickname,juego:p.gameName,title_id:'01006A800016E000',virtual_ip:'10.166.1.'+(i+1),version:i?'13.0.5':'13.0.2'}));
function fixtureClient(jugadores=smashObservations){
  let clock=now,reads=0;
  const client=createVersionsClient({now:()=>clock,fetcher:async(url,options)=>{
    reads++;
    return Response.json({disponible:true,sala_id:directoryRoom.versionsRoomId,consultado_en:new Date(now).toISOString(),endpoint:{direccion:directoryRoom.address,puerto:directoryRoom.port},jugadores});
  }});
  return {client,advance:()=>clock+=8*3600000,reads:()=>reads};
}
test('real directory schema without IP matches unique nickname/game/exact Title ID and keeps live roster',async()=>{
  const {client,advance,reads}=fixtureClient();
  assert.equal(directoryRoom.players[0].gameId,'72174692027785216');
  client.open(directoryRoom);assert.equal(reads(),0);
  await client.query(directoryRoom);
  assert.deepEqual(client.decorate(directoryRoom).players.map(p=>p.gameVersion),['13.0.2','13.0.5']);
  assert.equal(client.status(directoryRoom).result,'matched');assert.match(client.status(directoryRoom).detail,/apodo único/);
  advance();client.retain([directoryRoom]);
  assert.equal(client.decorate(directoryRoom).players[0].gameVersion,'13.0.2');assert.equal(reads(),1);
  const next={...directoryRoom,players:[directoryRoom.players[1],{...directoryRoom.players[0],nickname:'NewPlayer'}]};
  client.retain([next]);
  assert.deepEqual(client.decorate(next).players.map(p=>p.gameVersion),['13.0.5',undefined]);
  client.retain([directoryRoom]);assert.equal(client.decorate(directoryRoom).players[0].gameVersion,undefined);
  assert.equal(client.status(directoryRoom).result,'partial');
  await client.query(directoryRoom);assert.equal(client.decorate(directoryRoom).players[0].gameVersion,'13.0.2');
});
test('no-IP fallback rejects homonyms on either side, missing/unsafe IDs, wrong game or conflicting IP',async()=>{
  const original=directoryRoom.players[0];
  for(const players of [[original,original],[original,{...original,gameName:'Other'}],
    [{...original,gameId:undefined}],[{...original,gameId:0}],[{...original,gameId:Number(original.gameId)}],
    [{...original,gameId:'1'}],[{...original,gameName:'Other'}],[{...original,fakeIp:'10.1.2.3'}]]){
    const {client}=fixtureClient();const r={...directoryRoom,players};await client.query(r);
    assert.ok(client.decorate(r).players.every(p=>!p.gameVersion));
    assert.equal(client.status(r).result,'association_error');
  }
  const {client}=fixtureClient([smashObservations[0],{...smashObservations[0],juego:'Other',virtual_ip:'10.166.1.9'}]);
  await client.query(directoryRoom);assert.ok(client.decorate(directoryRoom).players.every(p=>!p.gameVersion));
});
test('missing publication shows Versión no disponible and service errors allow manual retry',async()=>{
  const current={...room,players:[{...player,virtual_ip:observation.virtual_ip}]};
  const responses=[Response.json(snapshot), Response.json({disponible:false,sala_id:room.versionsRoomId,jugadores:[]}),
    new Response('gateway',{status:503}), Response.json(snapshot)];
  const client=createVersionsClient({now:()=>now,fetcher:async()=>responses.shift()});
  await client.query(current);
  assert.equal(client.decorate(current).players[0].gameVersion,'4.0.1');
  await client.query(current);
  assert.equal(client.status(current).text,'Versión no disponible');
  assert.equal(client.decorate(current).players[0].gameVersion,undefined);
  await client.query(current);
  assert.match(client.status(current).text,/Pulsá Consultar versiones/);
  await client.query(current);
  assert.equal(client.decorate(current).players[0].gameVersion,'4.0.1');
});

test('Mario Kart also associates without directory IP using exact title',async()=>{
  const current={...room,players:[{...player,gameId:BigInt('0x'+observation.title_id).toString()}]};
  const client=createVersionsClient({now:()=>now,fetcher:async(url,options)=>Response.json(snapshot)});
  await client.query(current);assert.equal(client.decorate(current).players[0].gameVersion,'4.0.1');
  assert.equal(client.decorate(current).players[0].gameTitleId,observation.title_id);
});
