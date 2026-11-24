-- PREVIEW ONLY: execute exclusively against eden-rooms-test-db.
CREATE TABLE IF NOT EXISTS enet_version_jobs (
  job_id TEXT PRIMARY KEY,
  sala_id TEXT NOT NULL UNIQUE,
  direccion TEXT NOT NULL,
  puerto INTEGER NOT NULL CHECK (puerto BETWEEN 1 AND 65535),
  status TEXT NOT NULL CHECK (status IN ('pending','running','done','error')),
  created_at INTEGER NOT NULL,
  deadline_at INTEGER NOT NULL,
  lease_token TEXT,
  lease_until INTEGER,
  claimed_at INTEGER,
  retry_after INTEGER NOT NULL DEFAULT 0,
  error_code TEXT
);
CREATE INDEX IF NOT EXISTS enet_jobs_status_created ON enet_version_jobs(status,created_at);
CREATE TABLE IF NOT EXISTS enet_request_limits (
  bucket TEXT PRIMARY KEY,
  requests INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
