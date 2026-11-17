import {isLobbyRoomId} from './public-lobby.js';

// Read the snapshot and its job/endpoint guard in the same D1 statement.
export function readEnetSnapshot(db, id, address, port) {
  if (isLobbyRoomId(id)) {
    return db.prepare(`SELECT v.nombre_sala,v.jugadores_json,v.actualizado_en
      FROM versiones_salas v JOIN enet_version_jobs j ON j.sala_id=v.sala_id
      WHERE v.sala_id=? AND j.direccion=? AND j.puerto=? AND j.status='done'`)
      .bind(id,address,port).first();
  }
  return db.prepare(`SELECT v.nombre_sala,v.jugadores_json,v.actualizado_en
    FROM versiones_salas v
    JOIN salas_autorizadas a ON a.sala_id=v.sala_id AND a.autorizada=1
    JOIN salas_endpoints e ON e.sala_id=v.sala_id
    LEFT JOIN enet_version_jobs j ON j.sala_id=v.sala_id
    WHERE v.sala_id=? AND e.direccion=? AND e.puerto=?
      AND (j.sala_id IS NULL OR (j.status='done' AND j.direccion=e.direccion AND j.puerto=e.puerto))`)
    .bind(id,address,port).first();
}
