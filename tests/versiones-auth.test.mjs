import {test} from 'node:test';
import assert from 'node:assert/strict';
import { PREVIEW_HOST } from '../lib/enet-preview.js';
import {onRequestPost as publish} from '../functions/api/versiones-multiples.js';
import {onRequestGet,onRequestPost as validate} from '../functions/api/versiones-validar.js';
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

test('Preview credential authenticates only the Preview GET probe without accessing D1', async () => {
  const env = {
    CF_PAGES_BRANCH:'test/enet-versions-sralcer',
    ENET_PREVIEW_API_KEY:'preview-fixture',
    VERSIONES_API_KEY:'legacy-fixture',
    DB:new Proxy({}, {get(){throw new Error('D1 must never be touched');}})
  };
  const headers = {'X-ENet-Preview-Key':'preview-fixture'};
  const check = (host, overrides={}, extraHeaders={}) => onRequestGet({
    env:{...env, ...overrides}, request:new Request(`https://${host}/api/versiones-validar`, {
      headers:{...headers, ...extraHeaders}
    })
  });
  const response = await check(PREVIEW_HOST, {VERSIONES_API_KEY:undefined});
  assert.equal(response.status, 200);
  assert.equal((await response.json()).escritura, false);
  assert.equal((await check('eden-rooms.pages.dev')).status, 401);
  assert.equal((await check(PREVIEW_HOST, {CF_PAGES_BRANCH:'main'})).status, 401);
  assert.equal((await check(PREVIEW_HOST, {ENET_PREVIEW_API_KEY:undefined})).status, 503);
  assert.equal((await check(PREVIEW_HOST, {}, {'X-ENet-Preview-Key':'legacy-fixture'})).status, 401);
  assert.equal((await check(PREVIEW_HOST, {}, {'X-API-Key':'legacy-fixture'})).status, 401);
  for (const [handler, path] of [[validate, 'versiones-validar'], [publish, 'versiones-multiples']]) {
    const request = new Request(`https://${PREVIEW_HOST}/api/${path}`, {method:'POST', headers});
    assert.equal((await handler({env, request})).status, 401);
  }
});
