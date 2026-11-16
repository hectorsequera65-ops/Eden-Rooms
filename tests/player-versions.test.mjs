import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enrichPlayers, enrichRooms } from '../lib/player-versions.js';
const player = {nickname:'Ana',gameName:'Mario Kart'};
const observation = {nombre:'Ana',juego:'Mario Kart',version:'3.0.0'};
test('enriches unique current game without mutating lobby', () => {
  assert.equal(enrichPlayers([player],[observation])[0].gameVersion,'3.0.0');
  assert.equal(player.gameVersion,undefined);
});
test('ignores ambiguous names, changed games and explicit versions', () => {
  assert.deepEqual(enrichPlayers([player,player],[observation]),[player,player]);
  assert.deepEqual(enrichPlayers([player],[observation,observation]),[player]);
  assert.deepEqual(enrichPlayers([player],[{...observation,juego:'Otro juego'}]),[player]);
  const explicit={...player,gameVersion:'4.0.0'};
  assert.deepEqual(enrichPlayers([explicit],[observation]),[explicit]);
});
test('enriches only fresh matching endpoints and tolerates database failure', async () => {
  const now=Date.now(), rooms=[{address:'example.test',port:6007,players:[player]}];
  const row={sala_id:'example-room',direccion:'example.test',puerto:6007,jugadores_json:JSON.stringify([observation]),actualizado_en:new Date(now).toISOString()};
  const db={prepare:()=>({all:async()=>({results:[row]})})};
  assert.equal((await enrichRooms(rooms,db,now))[0].players[0].gameVersion,'3.0.0');
  row.actualizado_en=new Date(now-120001).toISOString();
  assert.deepEqual(await enrichRooms(rooms,db,now),[{...rooms[0],versionsRoomId:'example-room'}]);
  row.actualizado_en=new Date(now).toISOString();row.direccion='another.test';
  assert.deepEqual(await enrichRooms(rooms,db,now),rooms);
  assert.deepEqual(await enrichRooms(rooms,{prepare(){throw Error('unavailable')}}),rooms);
});

test('rejects homonyms even in different games and preserves title IDs', () => {
  const title='0100770008DD8000';
  const sample={...observation,title_id:title};
  assert.deepEqual(enrichPlayers([player,{...player,gameName:'Other'}],[sample]),[player,{...player,gameName:'Other'}]);
  assert.deepEqual(enrichPlayers([player],[sample,{...sample,juego:'Other'}]),[player]);
  assert.equal(enrichPlayers([player],[sample])[0].gameTitleId,title);
  assert.deepEqual(enrichPlayers([{...player,gameId:'1'}],[sample]),[{...player,gameId:'1'}]);
  const matching={...player,gameId:BigInt('0x'+title).toString()};
  assert.equal(enrichPlayers([matching],[sample])[0].gameVersion,'3.0.0');
});
