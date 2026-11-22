import {test, mock} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {onRequestGet, onRequestPost} from '../functions/api/versiones-programadas.js';
import {onRequest} from '../functions/api/versiones-publicadas.js';
import {PREVIEW_HOST} from '../lib/enet-preview.js';

test('scheduled Preview lists eligible rooms, revalidates writes and publishes the newest snapshot', async t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => {mock.restoreAll(); db.close();});
  db.exec(readFileSync(new URL('../migrations/0002_enet_scheduled.sql', import.meta.url), 'utf8'));
  const ENET_PREVIEW_DB = {
    prepare(sql) {
      const statement = db.prepare(sql);
      return {first: () => statement.get(), bind: (...values) => ({
        first: () => statement.get(...values),
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
  const env = {ENET_PREVIEW_DB, ENET_SCHEDULED_ENABLED:'true', VERSIONES_API_KEY:'fixture-key', ENET_PREVIEW_API_KEY:'preview-fixture'};
  const context = (body, {key = 'preview-fixture', host = PREVIEW_HOST, preview = true} = {}) => ({
    env, request:new Request(`https://${host}/api/versiones-programadas`, {
      method:body ? 'POST' : 'GET',
      headers:{[preview ? 'X-ENet-Preview-Key' : 'X-API-Key']:key, 'Content-Type':'application/json'},
      body:body && JSON.stringify(body)
    })
  });
  const id = 'lobby-8-8-8-8-20668';
  assert.equal((await onRequestGet(context(null, {host:'example.test'}))).status, 404);
  assert.equal((await onRequestGet(context(null, {key:'invalid'}))).status, 401);
  assert.equal((await onRequestPost(context({sala_id:'unauthorized'}, {key:''}))).status, 401);
  assert.equal((await onRequestPost({ ...context({sala_id:'unauthorized'}),
    env:{...env, ENET_PREVIEW_API_KEY:undefined}})).status, 503);
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal(db.prepare('SELECT count(*) AS count FROM enet_scheduled_snapshots').get().count, 0);
  assert.equal((await onRequestGet(context(null))).status, 200);
  const preview = {preview:true, key:'preview-fixture'};
  assert.equal((await onRequestGet(context(null, {preview:false, key:'fixture-key'}))).status, 401);
  assert.equal((await onRequestGet({...context(null), env:{...env, CF_PAGES_BRANCH:'main'}})).status, 404);
  assert.equal((await onRequestGet({...context(null), env:{...env, ENET_SCHEDULED_ENABLED:undefined}})).status, 404);
  assert.equal((await onRequestGet({...context(null),
    env:{...env, ENET_PREVIEW_DB:undefined, DB:ENET_PREVIEW_DB}})).status, 503);
  assert.equal((await onRequestGet(context(null, {...preview, host:'eden-rooms.pages.dev'}))).status, 404);
  const listed = await onRequestGet(context(null, preview));
  assert.equal(listed.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(await listed.json(), {storage:'ENET_PREVIEW_DB', salas:[{id, direccion:room.address, puerto:room.port, hasPassword:false}]});

  const sample = {sala_id:id, consultado_en:new Date().toISOString(),
    jugadores:[{nombre:'Player', juego:'Game', virtual_ip:'10.0.0.2', version:'1.2.3'}]};
  const archived = 'lobby-9-9-9-9-20668';
  db.prepare('INSERT INTO enet_scheduled_snapshots VALUES (?, ?, ?)')
    .run(archived, '[]', '2000-01-01T00:00:00.000Z');
  room.hasPassword = true;
  assert.equal((await onRequestPost(context(sample))).status, 409);
  room.hasPassword = false;
  assert.equal((await onRequestPost(context(sample, preview))).status, 200);
  assert.ok(db.prepare('SELECT 1 FROM enet_scheduled_snapshots WHERE sala_id = ?').get(archived));
  const older = {...sample, consultado_en:new Date(Date.parse(sample.consultado_en)-1000).toISOString(), jugadores:[]};
  assert.equal((await onRequestPost(context(older))).status, 200);
  const readPublished = () => onRequest({
    env, request:new Request(`https://${PREVIEW_HOST}/api/versiones-publicadas?id=${id}`)
  });
  assert.deepEqual((await (await readPublished()).json()).jugadores, sample.jugadores);
  room.hasPassword = true;
  assert.equal((await (await readPublished()).json()).disponible, false);
  db.exec('DROP TABLE enet_scheduled_snapshots');
  assert.equal((await onRequestGet(context(null))).status, 503);
});
