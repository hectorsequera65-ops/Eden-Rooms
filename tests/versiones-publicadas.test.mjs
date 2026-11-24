import {test, mock} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {onRequest} from '../functions/api/versiones-publicadas.js';
import {PREVIEW_HOST} from '../lib/enet-preview.js';

test('public Preview endpoint reads only published versions for an eligible room', async t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => {mock.restoreAll(); db.close();});
  db.exec(readFileSync(new URL('../migrations/0002_enet_scheduled.sql', import.meta.url), 'utf8'));
  const reads = [];
  const env = {ENET_SCHEDULED_ENABLED:'true', ENET_PREVIEW_DB:{
    prepare(sql) {
      reads.push(sql);
      assert.match(sql, /^SELECT /);
      return {first: () => db.prepare(sql).get(), bind: id => ({first: () => db.prepare(sql).get(id)})};
    }
  }};
  const room = {address:'8.8.8.8', port:20668, hasPassword:false};
  let lobby = [room];
  mock.method(globalThis, 'fetch', async url => {
    assert.equal(url, 'https://api.ynet-fun.xyz/lobby');
    return Response.json({rooms:lobby});
  });
  const id = 'lobby-8-8-8-8-20668';
  const read = ({query = '?id=' + id, method = 'GET', host = PREVIEW_HOST, branch} = {}) =>
    onRequest({request:new Request(`https://${host}/api/versiones-publicadas${query}`, {method}),
      env:{...env, CF_PAGES_BRANCH:branch}});

  assert.equal((await read({host:'eden-rooms.pages.dev'})).status, 404);
  assert.equal((await read({branch:'main'})).status, 404);
  const denied = await read({method:'POST'});
  assert.equal(denied.status, 405);
  assert.equal(denied.headers.get('Allow'), 'GET');
  assert.equal((await read({query:''})).status, 400);
  assert.equal((await read({query:'?id=arbitrary'})).status, 400);
  assert.equal(reads.length, 0);
  assert.equal(fetch.mock.callCount(), 0);

  const unavailable = {disponible:false, sala_id:id, jugadores:[]};
  assert.deepEqual(await (await read()).json(), unavailable);
  const player = {nombre:'Player', juego:'Game', version:'1.2.3', virtual_ip:'10.0.0.2', title_id:'01006A800016E000'};
  const timestamp = new Date(Date.now() - 3600000).toISOString();
  const store = db.prepare('INSERT OR REPLACE INTO enet_scheduled_snapshots VALUES (?,?,?)');
  store.run(id, JSON.stringify([{...player, api_key:'private fixture', collector_log:'private fixture'}]), timestamp);
  const response = await read();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.deepEqual(await response.json(), {disponible:true,sala_id:id,consultado_en:timestamp,
    endpoint:{direccion:room.address,puerto:room.port},jugadores:[player]});

  const countBefore = reads.length;
  for (const ineligible of [[], [{...room,hasPassword:true}], [room, {...room}]]) {
    lobby = ineligible;
    assert.deepEqual(await (await read()).json(), unavailable);
  }
  assert.equal(reads.length, countBefore + 3);
  lobby = [room];
  for (const players of [[], [{...player,version:''}]]) {
    store.run(id, JSON.stringify(players), timestamp);
    assert.deepEqual(await (await read()).json(), unavailable);
  }
  store.run(id, JSON.stringify([player]), new Date(Date.now() - 86401000).toISOString());
  assert.equal((await (await read()).json()).disponible, true);
  store.run(id, 'invalid JSON', timestamp);
  const failure = await read();
  assert.equal(failure.status, 503);
  assert.deepEqual(await failure.json(), {error:'No se pudieron consultar las versiones'});
});
