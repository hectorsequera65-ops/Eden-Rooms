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
      return {first: () => statement.get(), bind: (...values) => ({
        all: () => ({results:statement.all(...values)}),
        run: () => statement.run(...values)
      })};
    }
  };
  const room = {address:'8.8.8.8', port:20668, hasPassword:false,
    players:[{nickname:'Player', gameName:'Game', fakeIp:'10.0.0.2'}]};
  const lobby = [room, {...room, address:'9.9.9.9', hasPassword:true},
    {...room, address:'1.1.1.1'}, {...room, address:'1.1.1.1', hasPassword:true},
    {...room, address:'8.8.4.4', hasPassword:undefined}, {...room, address:'127.0.0.1'}];
  mock.method(globalThis, 'fetch', async () => Response.json({rooms:lobby}));
  const env = {ENET_PREVIEW_DB:DB, ENET_JOBS_ENABLED:'true', ENET_SCHEDULED_ENABLED:'true', VERSIONES_API_KEY:'fixture-key', ENET_PREVIEW_API_KEY:'preview-fixture'};
  const context = (body, {key = 'fixture-key', host = PREVIEW_HOST, preview = false} = {}) => ({
    env, request:new Request(`https://${host}/api/versiones-programadas`, {
      method:body ? 'POST' : 'GET',
      headers:{[preview ? 'X-ENet-Preview-Key' : 'X-API-Key']:key, 'Content-Type':'application/json'},
      body:body && JSON.stringify(body)
    })
  });
  const id = 'lobby-8-8-8-8-20668';
  assert.equal((await onRequestGet(context(null, {host:'example.test'}))).status, 404);
  assert.equal((await onRequestGet(context(null, {key:'invalid'}))).status, 401);
  assert.equal((await onRequestGet(context(null))).status, 401);
  const preview = {preview:true, key:'preview-fixture'};
  assert.equal((await onRequestGet(context(null, {preview:true}))).status, 401);
  assert.equal((await onRequestGet(context(null, {...preview, host:'eden-rooms.pages.dev'}))).status, 404);
  const listed = await onRequestGet(context(null, preview));
  assert.equal(listed.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(await listed.json(), {storage:'ENET_PREVIEW_DB', salas:[{id, direccion:room.address, puerto:room.port, hasPassword:false}]});

  const sample = {sala_id:id, consultado_en:new Date().toISOString(),
    jugadores:[{nombre:'Player', juego:'Game', virtual_ip:'10.0.0.2', version:'1.2.3'}]};
  const archived = 'lobby-9-9-9-9-20668';
  db.prepare('INSERT INTO enet_scheduled_snapshots VALUES (?, ?, ?)').run(archived, '[]', '2000-01-01T00:00:00.000Z');
  room.hasPassword = true;
  assert.equal((await onRequestPost(context(sample, preview))).status, 409);
  room.hasPassword = false;
  assert.equal((await onRequestPost(context(sample, preview))).status, 200);
  assert.ok(db.prepare('SELECT 1 FROM enet_scheduled_snapshots WHERE sala_id = ?').get(archived));
  const older = {...sample, consultado_en:new Date(Date.parse(sample.consultado_en)-1000).toISOString(), jugadores:[]};
  assert.equal((await onRequestPost(context(older, preview))).status, 200);
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
