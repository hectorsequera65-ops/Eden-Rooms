import {test} from 'node:test';
import assert from 'node:assert/strict';
import {onRequestGet} from '../functions/api/versiones-validar.js';
function context(secret,received,DB){
  return {env:{VERSIONES_API_KEY:secret,DB},request:new Request('https://example.test/api/versiones-validar',{headers:received?{'X-API-Key':received}:{}})};
}
test('GET validates write key without touching D1 and confirms endpoint contract',async()=>{
  const DB=new Proxy({},{get(){throw new Error('D1 must never be touched')}});
  const response=await onRequestGet(context('write-secret','write-secret',DB));
  assert.equal(response.status,200);
  assert.equal(response.headers.get('Cache-Control'),'no-store');
  assert.ok(response.headers.get('Content-Type').includes('application/json'));
  assert.deepEqual(await response.json(),{ok:true,endpoint:'versiones-validar',contrato:1,modo:'autenticacion',autenticado:true,escritura:false,db_configurada:true});
});
test('GET checks authentication even without DB, reporting binding separately',async()=>{
  const response=await onRequestGet(context('write-secret','write-secret'));
  assert.equal(response.status,200);assert.equal((await response.json()).db_configurada,false);
  for(const received of [undefined,'wrong','read-secret']){
    const result=await onRequestGet(context('write-secret',received));
    assert.equal(result.status,401);assert.equal((await result.json()).error,'No autorizado');
  }
});
test('GET does not accept keys in URLs and never reflects secrets',async()=>{
  const result=context('write-secret',undefined);
  result.request=new Request('https://example.test/api/versiones-validar?key=write-secret');
  const response=await onRequestGet(result);
  assert.equal(response.status,401);assert.ok(!(await response.text()).includes('write-secret'));
  assert.equal((await onRequestGet(context(undefined,'write-secret'))).status,503);
});
