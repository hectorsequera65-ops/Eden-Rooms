import {test, mock} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {onRequestGet, onRequestPost} from '../functions/api/versiones-programadas.js';
import {onRequestGet as publicRooms} from '../functions/api/rooms.js';
import {PREVIEW_HOST} from '../lib/enet-jobs.js';
import {playerGameVersion, createVersionsClient} from '../assets/player-versions.js';

test('scheduled Preview lists eligible rooms, revalidates writes and displays fresh versions', async t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => {mock.restoreAll(); db.close();});
  db.exec(readFileSync(new URL('../migrations/0002_enet_scheduled.sql', import.meta.url), 'utf8'));
  const DB = {
    prepare(sql) {
      const statement = db.prepare(sql);
      return {bind: (...values) => ({
        all: () => ({results:statement.all(...values)}),
        run: () => statement.run(...values)
      })};
    },
    async batch(statements) { return statements.map(statement => statement.run()); }
  };
  const room = {address:'8.8.8.8', port:20668, hasPassword:false,
    players:[{nickname:'Player', gameName:'Game', fakeIp:'10.0.0.2'}]};
  const lobby = [room, {...room, address:'9.9.9.9', hasPassword:true},
    {...room, address:'1.1.1.1'}, {...room, address:'1.1.1.1', hasPassword:true},
    {...room, address:'8.8.4.4', hasPassword:undefined}, {...room, address:'127.0.0.1'}];
  mock.method(globalThis, 'fetch', async () => Response.json({rooms:lobby}));
  const env = {DB, ENET_JOBS_ENABLED:'true', ENET_SCHEDULED_ENABLED:'true', VERSIONES_API_KEY:'fixture-key'};
  const context = (body, {key = 'fixture-key', host = PREVIEW_HOST} = {}) => ({
    env, request:new Request(`https://${host}/api/versiones-programadas`, {
      method:body ? 'POST' : 'GET',
      headers:{'X-API-Key':key, 'Content-Type':'application/json'},
      body:body && JSON.stringify(body)
    })
  });
  const id = 'lobby-8-8-8-8-20668';
  assert.equal((await onRequestGet(context(null, {host:'example.test'}))).status, 404);
  assert.equal((await onRequestGet(context(null, {key:'invalid'}))).status, 401);
  const listed = await onRequestGet(context(null));
  assert.equal(listed.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(await listed.json(), {salas:[{id, direccion:room.address, puerto:room.port, hasPassword:false}]});

  const sample = {sala_id:id, consultado_en:new Date().toISOString(),
    jugadores:[{nombre:'Player', juego:'Game', virtual_ip:'10.0.0.2', version:'1.2.3'}]};
  room.hasPassword = true;
  assert.equal((await onRequestPost(context(sample))).status, 409);
  room.hasPassword = false;
  assert.equal((await onRequestPost(context(sample))).status, 200);
  const older = {...sample, consultado_en:new Date(Date.parse(sample.consultado_en)-1000).toISOString(), jugadores:[]};
  assert.equal((await onRequestPost(context(older))).status, 200);
  const readRooms = async () => (await (await publicRooms(context())).json()).rooms;
  const rooms = await readRooms();
  const player = createVersionsClient().decorate(rooms[0]).players[0];
  assert.equal(playerGameVersion(player, Date.parse(sample.consultado_en)+300000), '1.2.3');
  assert.equal(playerGameVersion(player, Date.parse(sample.consultado_en)+360000), '');
  assert.equal(rooms[1].players[0].gameVersion, undefined);
  room.hasPassword = true;
  assert.equal((await readRooms())[0].players[0].gameVersion, undefined);
  room.hasPassword = false;
  db.prepare('UPDATE enet_scheduled_snapshots SET actualizado_en=?')
    .run(new Date(Date.now()-361000).toISOString());
  assert.equal((await readRooms())[0].players[0].gameVersion, undefined);
});
