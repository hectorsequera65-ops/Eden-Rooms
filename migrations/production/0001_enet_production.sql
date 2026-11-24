-- Run only on eden-rooms-db after verifying the production binding UUID.
CREATE TABLE IF NOT EXISTS enet_production_snapshots (
  sala_id TEXT PRIMARY KEY,
  jugadores_json TEXT NOT NULL,
  actualizado_en TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS enet_production_age ON enet_production_snapshots(actualizado_en);

CREATE TABLE IF NOT EXISTS enet_scheduled_target (
  target TEXT PRIMARY KEY CHECK (target = 'production'),
  latest_slot INTEGER NOT NULL DEFAULT 0
);
INSERT INTO enet_scheduled_target (target) VALUES ('production')
ON CONFLICT(target) DO NOTHING;
