// Separate route: older deployments cannot silently turn validation into a write.
import { authorizeVersionRequest, handleVersionSnapshot } from '../../lib/version-snapshots.js';

// Authentication only: no D1 queries, writes, ENet connection or snapshot required.
export async function onRequestGet({request,env}) {
  const denied=authorizeVersionRequest(request,env);
  if(denied)return denied;
  return Response.json({
    ok:true,endpoint:'versiones-validar',contrato:1,modo:'autenticacion',
    autenticado:true,escritura:false,db_configurada:Boolean(env.DB)
  },{headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
}

// Full snapshot validation with read-only D1 checks, shared with the write route.
export async function onRequestPost(context) {
  return handleVersionSnapshot(context, { validateOnly: true });
}
