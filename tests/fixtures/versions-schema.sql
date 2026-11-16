-- In-memory test schema inferred from queries. NOT a migration for production.
CREATE TABLE salas_autorizadas (
  sala_id TEXT PRIMARY KEY,
  nombre TEXT NOT NULL,
  autorizada INTEGER NOT NULL DEFAULT 0 CHECK (autorizada IN (0, 1))
);
CREATE TABLE salas_endpoints (
  sala_id TEXT PRIMARY KEY,
  direccion TEXT NOT NULL,
  puerto INTEGER NOT NULL CHECK (puerto BETWEEN 1 AND 65535)
);
CREATE TABLE versiones_salas (
  sala_id TEXT PRIMARY KEY,
  nombre_sala TEXT NOT NULL,
  jugadores_json TEXT NOT NULL,
  actualizado_en TEXT NOT NULL
);
