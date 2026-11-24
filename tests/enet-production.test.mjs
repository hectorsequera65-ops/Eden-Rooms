import {createVersionsClient} from '../assets/player-versions.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {onRequestGet, onRequestPost} from '../functions/api/versiones-programadas.js';
import {onRequestGet as rooms} from '../functions/api/rooms.js';
import {onRequestGet as chat} from '../functions/api/chat.js';
import {onRequest as published} from '../functions/api/versiones-publicadas.js';
import {PREVIEW_HOST, PRODUCTION_HOST} from '../lib/enet-preview.js';

function database(t) {
  const sqlite = new DatabaseSync(':memory:');
  t.after(() => sqlite.close());
  return {sqlite, binding: {prepare(sql) {
    const statement = sqlite.prepare(sql);
    const bound = (params = []) => ({
      bind: (...values) => bound(values),
      first: async () => statement.get(...params),
      all: async () => ({results:statement.all(...params)}),
      run: async () => ({meta:statement.run(...params)}),
    });
    return bound();
  }}};
}

test('production census uses its own D1, reserves a slot once and automatically enriches the lobby', async t => {
  const prod = database(t);
  const preview = database(t);
  const migration = path => readFileSync(new URL('../migrations/' + path, import.meta.url), 'utf8');
  const productionMigration = migration('production/0001_enet_production.sql');
  prod.sqlite.exec(readFileSync(new URL('./fixtures/versions-schema.sql', import.meta.url), 'utf8'));
  prod.sqlite.exec(`
    INSERT INTO salas_autorizadas VALUES ('registered', 'Legacy room', 1);
    INSERT INTO salas_endpoints VALUES ('registered', '8.8.8.8', 24872);
    INSERT INTO versiones_salas VALUES ('registered', 'Legacy room', '[]', '2000-01-01T00:00:00.000Z');
  `);
  preview.sqlite.exec(migration('0002_enet_scheduled.sql'));
  prod.sqlite.exec(migration('0002_enet_scheduled.sql'));
  const archived = 'lobby-1-1-1-1-24872';
  prod.sqlite.prepare('INSERT INTO enet_scheduled_snapshots VALUES (?,?,?)')
    .run(archived, '[]', new Date(0).toISOString());
  const env = {
    DB: prod.binding, ENET_PREVIEW_DB: preview.binding,
    ENET_PRODUCTION_ENABLED:'true', ENET_SCHEDULED_ENABLED:'true',
    ENET_PRODUCTION_API_KEY:'production-fixture', ENET_PREVIEW_API_KEY:'preview-fixture',
  };
  const slot = Math.floor(Date.now() / 300000) * 300000;
  const now = slot + 100000;
  let clock = now;
  t.mock.method(Date, 'now', () => clock);
  const room = {address:'8.8.8.8', port:24872, hasPassword:false,
    players:[{nickname:'Player', gameName:'Game', fakeIp:'10.0.0.2'}]};
  t.mock.method(globalThis, 'fetch', async () => Response.json({rooms:[room]}));
  function request({body, query = '', host = PRODUCTION_HOST, branch = 'main',
    key = {'X-ENet-Production-Key':'production-fixture'}, overrides} = {}) {
    return {env:{...env, CF_PAGES_BRANCH:branch, ...overrides},
      request:new Request(`https://${host}/api/versiones-programadas${query}`, {
        method:body ? 'POST' : 'GET', headers:{...key, 'Content-Type':'application/json'},
        body:body && JSON.stringify(body)
      })};
  }
  assert.equal((await onRequestGet(request())).status, 503, 'existing snapshots alone cannot authorize a database');
  assert.equal((await onRequestGet(request({branch:'test/enet-versions-sralcer'}))).status, 404);
  assert.equal((await onRequestGet(request({overrides:{ENET_PRODUCTION_ENABLED:'false'}}))).status, 404);
  assert.equal((await onRequestGet(request({key:{'X-ENet-Preview-Key':'preview-fixture'}}))).status, 401);
  assert.equal((await onRequestGet(request({host:PREVIEW_HOST, branch:'test/enet-versions-sralcer'}))).status, 401);
  assert.equal(fetch.mock.callCount(), 0);
  prod.sqlite.exec(productionMigration);
  preview.sqlite.exec(productionMigration);
  assert.equal((await onRequestGet(request({overrides:{DB:preview.binding}}))).status, 503);
  assert.equal((await (await onRequestGet(request())).json()).storage, 'DB');
  const id = 'lobby-8-8-8-8-24872';
  const sample = {slot, sala_id:id, consultado_en:new Date(now).toISOString(),
    jugadores:[{nombre:'Player', juego:'Game', virtual_ip:'10.0.0.2', version:'1.2.3'}]};
  const misboundPreview = request({body:sample, host:PREVIEW_HOST, branch:'test/enet-versions-sralcer',
    key:{'X-ENet-Preview-Key':'preview-fixture'}, overrides:{ENET_PREVIEW_DB:{...prod.binding}, DB:undefined}});
  const fetchesBeforeMisboundPost = fetch.mock.callCount();
  assert.equal((await onRequestPost(misboundPreview)).status, 503);
  assert.equal(fetch.mock.callCount(), fetchesBeforeMisboundPost);
  assert.deepEqual(prod.sqlite.prepare('SELECT sala_id FROM enet_scheduled_snapshots').all().map(row => row.sala_id),
    [archived]);

  const unreserved = await onRequestPost(request({body:sample}));
  assert.equal(unreserved.status, 409);
  assert.equal((await unreserved.json()).error, 'Turno sin reserva activa');
  const reserve = turn => onRequestPost(request({body:{slot:turn}, query:'?reserve'}));
  assert.deepEqual((await Promise.all([reserve(slot), reserve(slot)])).map(res => res.status).sort(), [200,409]);
  assert.equal((await reserve(slot - 900000)).status, 400);
  assert.equal((await reserve(slot + 300000)).status, 400);
  prod.sqlite.exec(productionMigration);
  assert.equal((await reserve(slot)).status, 409, 'reapplying the migration retains the reservation');
  // 80 seconds elapse before handoff, then the production runner waits 50 or 90.
  for (const delay of [50000, 90000]) {
    clock = now + 80000 + delay;
    assert.equal((await onRequestPost(request({body:sample}))).status, 200);
    assert.equal(prod.sqlite.prepare('SELECT actualizado_en FROM enet_production_snapshots').get().actualizado_en,
      sample.consultado_en);
  }
  const sampleAt = when => ({...sample, consultado_en:new Date(when).toISOString()});
  for (const when of [slot - 1, clock + 1, slot + 300000]) {
    const rejected = await onRequestPost(request({body:sampleAt(when)}));
    assert.equal(rejected.status, 400);
    assert.equal((await rejected.json()).error, 'Datos vencidos');
  }
  clock = slot + 299999;
  assert.equal((await onRequestPost(request({body:sampleAt(slot)}))).status, 200);
  clock++;
  assert.equal((await onRequestPost(request({body:sample}))).status, 400);
  assert.equal((await reserve(slot)).status, 400);
  assert.equal((await reserve(clock)).status, 200);
  assert.equal((await onRequestPost(request({body:{...sample, slot:clock}}))).status, 400);
  // Restore the original reservation for the lobby and legacy visibility checks.
  prod.sqlite.prepare("UPDATE enet_scheduled_target SET latest_slot = ? WHERE target = 'production'").run(slot);
  clock = now;
  const older = {...sample, consultado_en:new Date(now-1000).toISOString(), jugadores:[]};
  assert.equal((await onRequestPost(request({body:older}))).status, 200);
  assert.equal(preview.sqlite.prepare('SELECT COUNT(*) AS n FROM enet_scheduled_snapshots').get().n, 0);
  assert.equal(prod.sqlite.prepare('SELECT COUNT(*) AS n FROM enet_scheduled_snapshots').get().n, 1);
  assert.equal(prod.sqlite.prepare('SELECT COUNT(*) AS n FROM enet_production_snapshots').get().n, 1);
  const lobby = await (await rooms(request())).json();
  assert.equal(lobby.rooms[0].versionsRoomId, 'registered');
  assert.equal(lobby.rooms[0].scheduledVersionsAt, sample.consultado_en);
  assert.equal(lobby.rooms[0].players[0].gameVersion, '1.2.3');
  assert.equal(lobby.rooms[0].players[0].gameVersionSource, 'enet-scheduled');
  assert.equal(lobby.rooms[0].enetVersionsRoomId, id);
  const client = createVersionsClient({fetcher: async path => {
    const {pathname, search} = new URL(path, 'http://localhost');
    assert.equal(pathname, '/api/versiones-publicadas');
    return published(request({query:search, key:{}}));
  }});
  await client.query(lobby.rooms[0]);
  assert.equal(client.status(lobby.rooms[0]).consultedAt, sample.consultado_en);
  assert.equal(client.decorate(lobby.rooms[0]).players[0].gameVersionSource, 'enet-card');

  const legacyAt = new Date(now - 10000).toISOString();
  const snapshotAt = new Date(now - 240000).toISOString();
  const legacy = {...sample.jugadores[0], version:'2.0'};
  const companion = {nombre:'Other', juego:'Game', virtual_ip:'10.0.0.3', version:'1.0'};
  room.players.push({nickname:'Other', gameName:'Game', fakeIp:'10.0.0.3'});
  const updateLegacy = prod.sqlite.prepare('UPDATE versiones_salas SET jugadores_json = ?, actualizado_en = ?');
  const updateScheduled = prod.sqlite.prepare('UPDATE enet_production_snapshots SET jugadores_json = ?, actualizado_en = ?');
  const scheduledPlayers = [{...sample.jugadores[0], version:'1.0'}, companion];
  updateLegacy.run(JSON.stringify([legacy]), legacyAt);
  updateScheduled.run(JSON.stringify(scheduledPlayers), snapshotAt);
  const readRoom = async () => (await (await rooms(request())).json()).rooms[0];
  const mixed = await readRoom();
  assert.equal(mixed.scheduledVersionsAt, snapshotAt);
  assert.deepEqual(mixed.players.map(p => [p.gameVersion, p.gameVersionSource, p.gameVersionObservedAt]),
    [['2.0', 'enet', legacyAt], ['1.0', 'enet-scheduled', snapshotAt]]);

  updateScheduled.run(JSON.stringify(scheduledPlayers), sample.consultado_en);
  const newer = await readRoom();
  assert.equal(newer.players[0].gameVersion, '1.0');
  assert.equal(newer.players[0].gameVersionSource, 'enet-scheduled');

  updateScheduled.run(JSON.stringify([{...sample.jugadores[0], version:'unknown'}]), sample.consultado_en);
  const unknown = await readRoom();
  assert.equal(unknown.scheduledVersionsAt, null);
  assert.equal(unknown.players[0].gameVersion, '2.0');
  assert.equal((await (await published(request({query:'?id='+id}))).json()).disponible, false);
  updateLegacy.run('[]', new Date(0).toISOString());
  updateScheduled.run(JSON.stringify(sample.jugadores), sample.consultado_en);

  const retained = new Date(now-360001).toISOString();
  prod.sqlite.prepare('UPDATE enet_production_snapshots SET actualizado_en = ?').run(retained);
  prod.sqlite.exec(productionMigration);
  const stale = (await (await rooms(request())).json()).rooms[0];
  assert.equal(stale.scheduledVersionsAt, retained);
  assert.equal(stale.players[0].gameVersion, undefined);
  await client.query(stale);
  assert.equal(client.decorate(stale).players[0].gameVersion, undefined);
  assert.deepEqual(client.status(stale),
    {text:'Muestra ENet antigua', consultedAt:retained, result:'stale'});
  assert.equal((await (await rooms(request({overrides:{ENET_PRODUCTION_ENABLED:'false'}}))).json())
    .rooms[0].scheduledVersionsAt, undefined);
  assert.equal(prod.sqlite.prepare('SELECT jugadores_json FROM versiones_salas WHERE sala_id = ?').get('registered').jugadores_json, '[]');
  room.hasPassword = true;
  const protectedRoom = (await (await rooms(request())).json()).rooms[0];
  assert.equal(protectedRoom.versionsRoomId, 'registered');
  assert.equal(protectedRoom.enetVersionsRoomId, null);
  const unavailable = await onRequestPost(request({body:sample}));
  assert.equal(unavailable.status, 409);
  assert.equal((await unavailable.json()).error, 'Sala pública no disponible');
  assert.equal((await (await published(request({query:'?id='+id}))).json()).disponible, false);
});

test('Preview accepts identical bindings until their D1 has the production marker', async t => {
  const {sqlite, binding} = database(t);
  const migration = path => readFileSync(new URL('../migrations/' + path, import.meta.url), 'utf8');
  sqlite.exec(migration('0002_enet_scheduled.sql'));
  const room = {address:'8.8.8.8', port:24872, hasPassword:false};
  t.mock.method(globalThis, 'fetch', async () => Response.json({rooms:[room]}));
  const env = {
    DB:binding, ENET_PREVIEW_DB:binding, ENET_SCHEDULED_ENABLED:'true',
    ENET_PREVIEW_API_KEY:'preview-fixture',
  };
  const id = 'lobby-8-8-8-8-24872';
  const player = {nombre:'Player', juego:'Game', version:'1.2.3'};
  const now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const sample = {sala_id:id, consultado_en:new Date(now - 120000).toISOString(),
    jugadores:[player, {...player, nombre:'sralcer'}]};
  const request = body => ({env, request:new Request(`https://${PREVIEW_HOST}/api/versiones-programadas`, {
    method:body ? 'POST' : 'GET',
    headers:{'X-ENet-Preview-Key':'preview-fixture', 'Content-Type':'application/json'},
    body:body && JSON.stringify(body),
  })});

  const targets = await onRequestGet(request());
  assert.equal(targets.status, 200);
  assert.deepEqual(await targets.json(), {storage:'ENET_PREVIEW_DB',
    salas:[{id, direccion:room.address, puerto:room.port, hasPassword:false}]});
  assert.equal((await onRequestPost(request(sample))).status, 200);
  const expired = {...sample, slot:Math.floor(now / 300000) * 300000,
    consultado_en:new Date(now - 120001).toISOString()};
  assert.equal((await onRequestPost(request(expired))).status, 400);
  const saved = sqlite.prepare('SELECT * FROM enet_scheduled_snapshots').all();
  assert.equal(saved.length, 1);
  assert.deepEqual(JSON.parse(saved[0].jugadores_json), [player]);

  sqlite.exec(migration('production/0001_enet_production.sql'));
  const lobbyReads = fetch.mock.callCount();
  assert.equal((await onRequestGet(request())).status, 503);
  assert.equal((await onRequestPost(request(sample))).status, 503);
  assert.equal(fetch.mock.callCount(), lobbyReads);
  assert.deepEqual(sqlite.prepare('SELECT * FROM enet_scheduled_snapshots').all(), saved);
});

test('chat initialization preserves messages in databases without a historical reset marker', async t => {
  const {sqlite, binding} = database(t);
  sqlite.exec('CREATE TABLE chat_messages (id INTEGER PRIMARY KEY, nickname TEXT, message TEXT, created_at INTEGER, sender_hash TEXT)');
  sqlite.prepare('INSERT INTO chat_messages VALUES (1,?,?,?,?)').run('Player', 'Existing message', Date.now(), 'fixture');
  const response = await chat({env:{DB:binding}});
  assert.equal(response.status, 200);
  assert.equal((await response.json()).messages[0].message, 'Existing message');
});
