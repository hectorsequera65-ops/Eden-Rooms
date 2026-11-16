import {test} from 'node:test';
import assert from 'node:assert/strict';
import {onRequestGet} from '../functions/api/autorizaciones.js';
function setup(expected,received){
  let queries=0;
  const env={DB:{prepare(){queries++;return {all:async()=>({results:[{sala_id:'room',nombre:'Room',direccion:'127.0.0.1',puerto:6007}]})}}}};
  if(expected!==undefined)env.AUTORIZACIONES_API_KEY=expected;
  const request=new Request('https://example.test/api/autorizaciones',{headers:received?{'X-Collector-Key':received}:{}});
  return {env,request,queries:()=>queries};
}
test('optional read key preserves public access when unconfigured',async()=>{
  const context=setup();const response=await onRequestGet(context);
  assert.equal(response.status,200);assert.equal((await response.json()).salas.length,1);
});
test('configured read key denies missing, wrong and write-only keys before querying DB',async()=>{
  for(const received of [undefined,'wrong','write-secret']){
    const context=setup('read-secret',received);context.env.VERSIONES_API_KEY='write-secret';
    const response=await onRequestGet(context);
    assert.equal(response.status,401);assert.equal(context.queries(),0);
    assert.equal(response.headers.get('Cache-Control'),'no-store');
  }
});
test('correct read key allows existing response and does not expose keys',async()=>{
  const context=setup('read-secret','read-secret');
  const response=await onRequestGet(context);assert.equal(response.status,200);
  const text=await response.text();assert.ok(text.includes('127.0.0.1'));assert.ok(!text.includes('read-secret'));
});
