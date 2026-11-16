// A registered endpoint change must not make a previous job's data look current.
// Only used when the Preview queue feature is explicitly enabled.
export async function snapshotMatchesJob(db,id,address,port){
  const job=await db.prepare('SELECT status,direccion,puerto FROM enet_version_jobs WHERE sala_id=?').bind(id).first();
  return !job || job.status==='done' && job.direccion===address && Number(job.puerto)===Number(port);
}
