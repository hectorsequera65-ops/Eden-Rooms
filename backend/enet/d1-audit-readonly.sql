-- READ ONLY. Run against the intended database, never as a schema migration.
SELECT name, sql FROM sqlite_master
WHERE type IN ('table','index')
  AND tbl_name IN ('salas_autorizadas','salas_endpoints','versiones_salas')
ORDER BY tbl_name, type, name;
PRAGMA table_info(salas_autorizadas);
PRAGMA table_info(salas_endpoints);
PRAGMA table_info(versiones_salas);
PRAGMA index_list(versiones_salas);
SELECT a.sala_id, a.nombre, a.autorizada, e.direccion, e.puerto
FROM salas_autorizadas a
LEFT JOIN salas_endpoints e ON e.sala_id = a.sala_id
WHERE a.nombre = 'EU Official';
SELECT direccion, puerto, COUNT(*) AS registros
FROM salas_endpoints GROUP BY direccion, puerto HAVING COUNT(*) > 1;
SELECT sala_id, actualizado_en, json_valid(jugadores_json) AS json_valido
FROM versiones_salas LIMIT 20;
