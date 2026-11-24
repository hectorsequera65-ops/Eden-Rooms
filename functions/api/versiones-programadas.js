import {scheduledPreview, isScheduledProduction, productionStorage, previewStorage, PREVIEW_SNAPSHOTS, PRODUCTION_SNAPSHOTS, respond} from '../../lib/enet-preview.js';
import {findLobbyRoom, listEligibleLobbyRooms, readLobby} from '../../lib/public-lobby.js';
import {authorizePreviewSnapshot, authorizeProductionSnapshot, normalizeVersionSnapshot} from '../../lib/version-snapshots.js';

async function storage(request, env) {
  const production = isScheduledProduction(request, env);
  if (!production && !scheduledPreview(request, env)) {
    return {denied:respond({error:'No disponible'}, 404)};
  }
  const denied = production ? authorizeProductionSnapshot(request, env) : authorizePreviewSnapshot(request, env);
  if (denied) return {denied};
  const db = production ? await productionStorage(env) : await previewStorage(env);
  if (!db) return {denied:respond({error:'Base de datos no configurada'}, 503)};
  return {db, production, table:production ? PRODUCTION_SNAPSHOTS : PREVIEW_SNAPSHOTS};
}

export async function onRequestGet({request, env}) {
  const {db, production, table, denied} = await storage(request, env);
  if (denied) return denied;
  try {
    await db.prepare(
      `SELECT sala_id, jugadores_json, actualizado_en FROM ${table} LIMIT 0`
    ).first();
  } catch {
    return respond({error:'Esquema de versiones no disponible'}, 503);
  }
  try {
    const lobby = await readLobby({fresh:true});
    return respond({storage:production ? 'DB' : 'ENET_PREVIEW_DB', salas:[...listEligibleLobbyRooms(lobby)].map(([id, room]) => ({
      id, direccion:room.address, puerto:Number(room.port), hasPassword:false
    }))});
  } catch {
    return respond({error:'Lobby no disponible'}, 503);
  }
}

const SLOT_MS = 300000;

function currentSlot(slot, now) {
  return Number.isSafeInteger(slot) && slot > 0 && slot % SLOT_MS === 0 &&
    slot <= now && now - slot < SLOT_MS;
}

export async function onRequestPost({request, env}) {
  const {db, production, table, denied} = await storage(request, env);
  if (denied) return denied;
  if ((request.headers.get('content-type') || '').split(';')[0].trim() !== 'application/json') {
    return respond({error:'Se requiere JSON'}, 415);
  }
  const raw = await request.text();
  if (raw.length > 20000) return respond({error:'Datos demasiado grandes'}, 413);
  let data;
  try { data = JSON.parse(raw); }
  catch { return respond({error:'JSON inválido'}, 400); }
  const now = Date.now();
  if (production && new URL(request.url).search === '?reserve') {
    const slot = data?.slot;
    if (!currentSlot(slot, now)) {
      return respond({error:'Turno inválido o vencido'}, 400);
    }
    try {
      const {meta} = await db.prepare(
        "UPDATE enet_scheduled_target SET latest_slot = ? WHERE target = 'production' AND latest_slot < ?"
      ).bind(slot, slot).run();
      return meta.changes === 1 ? respond({ok:true,reserved:true}) : respond({error:'Turno ya reservado'}, 409);
    } catch {
      return respond({error:'No se pudo reservar el turno'}, 503);
    }
  }
  const slot = data?.slot;
  if (production && !currentSlot(slot, now)) {
    return respond({error:'Turno requerido'}, 400);
  }
  const normalized = normalizeVersionSnapshot(data, env, now, production ? {productionSlot:slot} : undefined);
  if (normalized.error) return normalized.error;
  const {id, when, players} = normalized;
  if (!/^lobby-(?:\d{1,3}-){4}\d{1,5}$/.test(id) || when > now + 30000) {
    return respond({error:'Identidad o fecha inválida'}, 400);
  }
  try {
    if (!await findLobbyRoom(id)) return respond({error:'Sala pública no disponible'}, 409);
    const result = await db.prepare(`INSERT INTO ${table}(sala_id,jugadores_json,actualizado_en)
        SELECT ?,?,? ${production ? "WHERE EXISTS (SELECT 1 FROM enet_scheduled_target WHERE target = 'production' AND latest_slot = ?)" : 'WHERE TRUE'}
        ON CONFLICT(sala_id) DO UPDATE SET
        jugadores_json=excluded.jugadores_json,actualizado_en=excluded.actualizado_en
        WHERE excluded.actualizado_en >= ${table}.actualizado_en`)
        .bind(id, JSON.stringify(players), new Date(when).toISOString(), ...(production ? [slot] : [])).run();
    if (production && result.meta.changes === 0) {
      const active = await db.prepare(
        "SELECT latest_slot FROM enet_scheduled_target WHERE target = 'production' AND latest_slot = ?"
      ).bind(slot).first();
      if (!active) return respond({error:'Turno sin reserva activa'}, 409);
    }
    return respond({ok:true});
  } catch {
    return respond({error:'No se pudo guardar la muestra'}, 503);
  }
}
