-- Preview D1 storage for scheduled observations.
CREATE TABLE IF NOT EXISTS enet_scheduled_snapshots (
  sala_id TEXT PRIMARY KEY,
  jugadores_json TEXT NOT NULL,
  actualizado_en TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS enet_scheduled_age ON enet_scheduled_snapshots(actualizado_en);
