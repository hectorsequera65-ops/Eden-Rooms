import {test} from 'node:test';
import assert from 'node:assert/strict';
import {onRequestPost} from '../functions/api/versiones-multiples.js';
function setup(players) {
  let stored;
  const env={VERSIONES_API_KEY:'test-secret',DB:{prepare(sql){return {bind(...values){return {
    first:async()=>({nombre:'Room'}),run:async()=>{stored=JSON.parse(values[2])}
  }}}}}};
  const request=new Request('https://example.test/api/versiones-multiples',{method:'POST',headers:{'Content-Type':'application/json','X-API-Key':'test-secret'},body:JSON.stringify({sala_id:'room',consultado_en:new Date().toISOString(),jugadores:players})});
  return {env,request,getStored:()=>stored};
}
test('ingestion preserves titles, IPs and homonyms; excludes collector',async()=>{
  const player={nombre:'Ana',juego:'Game',version:'1.0',title_id:'0100770008dd8000',virtual_ip:'10.0.0.1'};
  const context=setup([player,{...player,version:'2.0',virtual_ip:'10.0.0.2'},{...player,nombre:'sralcer'}]);
  assert.equal((await onRequestPost(context)).status,200);
  const saved=context.getStored();assert.equal(saved.length,2);
  assert.equal(saved[0].title_id,'0100770008DD8000');assert.equal(saved[1].version,'2.0');
});
test('rejects malformed identifiers and unauthorized ingestion',async()=>{
  for(const player of [{title_id:'bad'},{virtual_ip:'999.0.0.1'}]){
    assert.equal((await onRequestPost(setup([player]))).status,400);
  }
  const context=setup([]);context.request.headers.set('X-API-Key','wrong');
  assert.equal((await onRequestPost(context)).status,401);
});

test('ingestion uses configured collector nickname',async()=>{
  const context=setup([{nombre:'custom_probe'},{nombre:'sralcer',juego:'Game',version:'1.0'}]);
  context.env.EDEN_ENET_NICKNAME='custom_probe';
  assert.equal((await onRequestPost(context)).status,200);
  assert.deepEqual(context.getStored().map(p=>p.nombre),['sralcer']);
});
