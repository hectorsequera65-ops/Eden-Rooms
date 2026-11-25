// Optional real Chromium regression; network API responses are local fixtures only.
// EDEN_PLAYWRIGHT_MODULE=/absolute/path/to/@playwright/test/index.mjs node --test tests/preview-ui.test.mjs
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PREVIEW_HOST, PRODUCTION_HOST} from '../lib/enet-preview.js';
import {execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {createServer as createHttpServer} from 'node:http';
import {createServer as createHttpsServer} from 'node:https';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const root=new URL('../',import.meta.url);
const hosts=[[PRODUCTION_HOST,''],[PREVIEW_HOST,'/preview']];
const devices=[['desktop',1280,900],['mobile',390,844]];
const cases=hosts.flatMap(([host,suffix])=>devices.map(device=>[host,suffix,...device]));

async function assertDialogFits(dialog, label, bridgeOpen=false){
  const problems=await dialog.evaluate((modal, bridgeOpen)=>{
    const problems=[];
    const viewport=document.documentElement;
    const bounds=modal.getBoundingClientRect();
    if(viewport.scrollWidth>window.innerWidth)problems.push('document overflows horizontally');
    if(bounds.left<0||bounds.top<0||bounds.right>viewport.clientWidth||bounds.bottom>viewport.clientHeight){
      problems.push('dialog extends outside the viewport');
    }
    const panel=modal.querySelector('.bridge-options[open]');
    if(bridgeOpen&&!panel)problems.push('Bridge panel is closed');
    for(const region of [modal,panel].filter(Boolean)){
      if(region.scrollWidth>region.clientWidth)problems.push(region.className+' overflows horizontally');
      const overflowY=getComputedStyle(region).overflowY;
      if(region.scrollHeight>region.clientHeight&&!['auto','scroll'].includes(overflowY)){
        problems.push(region.className+' clips content vertically');
      }
    }
    return problems;
  },bridgeOpen);
  assert.deepEqual(problems,[],label);

  const controls=await dialog.locator('button, input, summary, a[href]').filter({visible:true}).all();
  for(const control of controls){
    await control.scrollIntoViewIfNeeded();
    const clippedBy=await control.evaluate(element=>{
      const bounds=element.getBoundingClientRect();
      for(let region=element.parentElement;region;region=region.parentElement){
        if(!region.matches('dialog, .bridge-options'))continue;
        const box=region.getBoundingClientRect();
        const left=box.left+region.clientLeft;
        const top=box.top+region.clientTop;
        // Client dimensions are rounded to whole pixels.
        if(bounds.left<left-1||bounds.right>left+region.clientWidth+1||
          bounds.top<top-1||bounds.bottom>top+region.clientHeight+1){
          return region.id||region.className;
        }
      }
      return null;
    });
    assert.equal(clippedBy,null,`${label}: control ${await control.evaluate(element=>element.id||element.textContent.trim())} is clipped`);
  }
}

async function listenLocally(server){
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  return server.address().port;
}

for(const [host,suffix,device,width,height] of cases){
  test(`UI (${host}, ${device}): versions, sharing, chat and PS5`,{skip:!process.env.EDEN_PLAYWRIGHT_MODULE},async()=>{
    const {chromium,expect}=await import(process.env.EDEN_PLAYWRIGHT_MODULE);
    const origin='https://'+host;
    const bridgeOrigin='http://192.0.2.10:24879';
    const token='b'.repeat(32);
    let bridgeRequest, retry=false;
    const receives=[];
    const redirects=[];
    const files=new Map([
      ['/', 'index.html'],
      ['/ps5/', 'ps5/index.html'],
      ['/assets/player-versions.js', 'assets/player-versions.js'],
      ['/assets/bridge-status.js', 'assets/bridge-status.js'],
    ]);
    // Serve the real page over loopback while preserving its production and Preview origins.
    const tlsDir=await mkdtemp(join(tmpdir(),'eden-ui-tls-'));
    let tls;
    try{
      const keyPath=join(tlsDir,'loopback.key');
      const cert=execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1',
        '-subj','/CN='+host,'-keyout',keyPath],{stdio:['ignore','pipe','pipe']});
      tls={key:await readFile(keyPath),cert};
    }finally{
      await rm(tlsDir,{recursive:true,force:true});
    }
    const site=createHttpsServer(tls,async(request,response)=>{
      const file=files.get(new URL(request.url,origin).pathname);
      if(!file){
        response.writeHead(404).end();
        return;
      }
      response.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':'text/html; charset=utf-8');
      response.end(await readFile(new URL(file,root)));
    });
    const returnToSite=(response,phase)=>{
      const intent=bridgeRequest.searchParams.get('intent');
      const location=origin+'/#eden-bridge-'+phase+'='+intent+'.'+token;
      redirects.push(location);
      response.writeHead(302,{Location:location}).end();
    };
    // This proxy answers only the simulated Bridge and never forwards requests.
    const bridge=createHttpServer((request,response)=>{
      const url=new URL(request.url,bridgeOrigin);
      if(url.origin===bridgeOrigin){
        if(url.pathname==='/v1/transfer'+suffix){
          bridgeRequest=url;
          if(retry) returnToSite(response,'challenge');
          else response.writeHead(204).end();
          return;
        }
        if(url.pathname==='/v1/receive'+suffix){
          receives.push(url);
          response.writeHead(200,{'Content-Type':'text/html'}).end(
            '<form method="post" action="/confirm"><button>Confirmar en el Bridge simulado</button></form>');
          return;
        }
        if(request.method==='POST'&&url.pathname==='/confirm'&&receives.length===1){
          returnToSite(response,'saved');
          return;
        }
      }
      response.writeHead(404).end();
    });
    let browser;
    try{
      const sitePort=await listenLocally(site);
      const bridgePort=await listenLocally(bridge);
      browser=await chromium.launch({headless:true,executablePath:process.env.EDEN_CHROMIUM,args:[
        '--no-sandbox','--disable-dev-shm-usage',
        '--host-resolver-rules=MAP '+host+' 127.0.0.1:'+sitePort+',EXCLUDE 127.0.0.1,MAP * ~NOTFOUND',
        '--proxy-server=http=http://127.0.0.1:'+bridgePort,
      ]});
      const page=await browser.newPage({viewport:{width,height},timezoneId:'America/Montevideo',
        ignoreHTTPSErrors:true});
      await page.route('http://127.0.0.1:24879/v1/connection',route=>route.abort());
      const chatMessages=[];
      const now=Date.parse('2026-11-16T17:14:00Z'),errors=[],requests=[],unexpectedRequests=[];
      page.on('pageerror',error=>errors.push(error.message));
      await page.clock.install({time:new Date(now)});
      const mario='Mario Kart 8 Deluxe',smash='Super Smash Bros. Ultimate';
      const players=[{nickname:'Eden',gameName:mario,fakeIp:'10.0.0.10'},{nickname:'SataHT',gameName:smash,fakeIp:'10.0.0.11'},
        {nickname:'SinVersion',gameName:mario},{nickname:'Repetido',gameName:smash,fakeIp:'10.0.0.1'},
        {nickname:'Repetido',gameName:smash,fakeIp:'10.0.0.2'}];
      const rooms=[{name:'Sala Preview 20668 & Pokémon 🏁',password:'no-compartir',token:'no-compartir',address:'8.8.8.8',port:20668,maxPlayers:32,preferredGameName:smash,players,versionsRoomId:'legacy-20668',enetVersionsRoomId:'lobby-8-8-8-8-20668',scheduledVersionsAt:null},
        {name:'Otra sala',address:'9.9.9.9',port:6007,maxPlayers:32,preferredGameName:mario,players:[{...players[0],gameVersion:'Versión desconocida'}],versionsRoomId:'lobby-9-9-9-9-6007',enetVersionsRoomId:'lobby-9-9-9-9-6007'}];
      let snapshot={disponible:true,sala_id:'lobby-8-8-8-8-20668',consultado_en:new Date(now).toISOString(),endpoint:{direccion:"8.8.8.8",puerto:20668},jugadores:[
        {nombre:'Eden',juego:mario,virtual_ip:'10.0.0.10',version:'4.0.1',title_id:'0100152000022000'},
        {nombre:'SataHT',juego:smash,virtual_ip:'10.0.0.11',version:'13.0.5',title_id:'01006A800016E000'},
        {nombre:'SinVersion',juego:mario,version:''},
        {nombre:'Repetido',juego:smash,virtual_ip:'10.0.0.1',version:'13.0.2'},
        {nombre:'Repetido',juego:smash,virtual_ip:'10.0.0.2',version:'13.0.3'}]};
      let releaseFirstQuery, publicationUnavailable=false;
      const firstQuery = new Promise(resolve => { releaseFirstQuery = resolve; });
      await page.route(origin+'/api/**',async route=>{
        const url=new URL(route.request().url());
        if(url.pathname==='/api/rooms')return route.fulfill({json:{rooms}});
        if(url.pathname==='/api/versiones-publicadas'){
          assert.equal(route.request().method(),'GET');
          assert.equal(route.request().headers()['x-api-key'],undefined);
          assert.equal(route.request().headers()['x-enet-preview-key'],undefined);
          const id=url.searchParams.get('id');requests.push(id);
          if(requests.length===1)await firstQuery;
          if(publicationUnavailable)return route.fulfill({status:503,body:''});
          return route.fulfill({json:id==='lobby-8-8-8-8-20668'?snapshot:{disponible:false,sala_id:id,jugadores:[]}});
        }
        if(url.pathname==='/api/chat'){
          if(route.request().method()==='POST'){
            const body=route.request().postDataJSON();
            assert.equal(body.room,undefined);
            chatMessages.push({id:chatMessages.length+1,...body,message:body.message||body.phrase,created_at:new Date(now).toISOString()});
          }
          return route.fulfill({json:{messages:chatMessages}});
        }
        if(url.pathname==='/api/geo')return route.fulfill({json:{country:'Uruguay',countryCode:'UY'}});
        if (/versiones|collector/.test(url.pathname)) unexpectedRequests.push(url.pathname);
        return route.fulfill({status:404,body:''});
      });
      await page.goto(origin);
      await expect(page.locator('.room-accordion')).toHaveCount(2);
      assert.equal(requests.length,0,'collapsed rooms should not request versions');
      await page.locator('[data-room-toggle="8.8.8.8:20668"]').click();
      assert.equal(requests.length,0);
      rooms[0].players=[...players,{nickname:'Temporal',gameName:mario}];
      await page.clock.fastForward(10001);
      await expect(page.locator('.room-open .room-summary')).toContainText('6/32');
      rooms[0].players=players;
      await page.clock.fastForward(10001);
      await expect(page.locator('.room-open .room-summary')).toContainText('5/32');
      assert.equal(requests.length,0);
      await expect(page.locator('.room-open .version-request-status')).toHaveText('Versiones ENet no disponibles');
      await expect(page.locator('.room-open .version-request-status')).toHaveCSS('display','none');
      await expect(page.locator('.room-open [data-query-versions]')).toHaveCSS('display','none');
      await page.locator('.room-open [data-query-versions]').dispatchEvent('click');
      await expect(page.locator('.room-open [data-query-versions]')).toBeDisabled();
      await expect(page.locator('.room-open .version-request-status')).toHaveText('Consultando versiones…');
      await expect.poll(()=>requests[0]).toBe('lobby-8-8-8-8-20668');
      releaseFirstQuery();
      await expect(page.locator('.room-open .player-version')).toHaveCount(3);
      await page.locator('.room-open [data-expand]').click();
      await expect(page.locator('.room-open .player-version')).toHaveCount(4);
      const eden=page.locator('.room-open .player-row').filter({hasText:'Eden'});
      await expect(eden).toContainText('Versión 4.0.1');
      await expect(eden.locator('.player-name')).toBeVisible();
      await expect(eden.locator('.player-version')).toBeVisible();
      const withoutVersion = page.locator('.room-open .player-row').filter({hasText:'SinVersion'});
      await expect(withoutVersion.locator('.player-game')).toHaveText(mario);
      await expect(withoutVersion.locator('.player-version')).toHaveCount(0);
      await expect(withoutVersion).not.toContainText('Versión');
      await expect(page.locator('.room-open .player-row').filter({hasText:'Repetido'})).toHaveCount(2);
      assert.equal(requests.length,1);
      await page.locator('[data-favorite="8.8.8.8:20668"]').click();
      assert.deepEqual(await page.evaluate(()=>JSON.parse(localStorage.getItem('edenFavorites'))),['8.8.8.8:20668']);
      await page.locator('.room-open [data-connect]').click();
      await expect(page.locator('#connectDialog')).toBeVisible();
      await expect(page.locator('#dialogIp')).toHaveText('8.8.8.8');
      await expect(page.locator('#dialogPort')).toHaveText('20668');
      await page.locator('#closeConnectDialog').click();
      if(device==='mobile'){
        await page.getByRole('button',{name:'Filtros',exact:true}).click();
        await expect(page.locator('#openFilters')).toHaveAttribute('aria-expanded','true');
        await expect(page.locator('#closeFilters svg')).toBeVisible();
        await page.getByRole('button',{name:'Cerrar filtros'}).click();
      }else{
        await expect(page.locator('#quickOpen svg')).toBeVisible();
      }
      await page.locator('#theme').click();
      await expect(page.locator('html')).toHaveClass(/light/);
      await page.locator('[data-room-toggle="8.8.8.8:20668"]').click();
      await page.locator('[data-room-toggle="8.8.8.8:20668"]').click();
      assert.equal(requests.length,1);
      await page.locator('.room-open [data-query-versions]').dispatchEvent('click');
      await expect.poll(()=>requests.length).toBe(2);
      await expect(page.locator('.room-open .player-version')).toHaveCount(4);
      await page.clock.fastForward(31000);
      await expect.poll(()=>requests.length).toBe(2);
      assert.equal(requests.length,2);
      await page.clock.fastForward(90000);
      await expect(page.locator('.room-open .player-version')).toHaveCount(4);
      await expect(eden).toContainText('Versión 4.0.1');
      await expect(page.locator('.room-open .version-request-status time')).toHaveText('Versiones consultadas a las 14:14');
      await expect(page.locator('.room-open .version-request-status')).toHaveCSS('display','none');
      await expect(page.locator('.room-open .version-association-detail')).toContainText('asociadas a jugadores actuales');
      await expect(page.locator('.room-open .version-association-detail')).toBeHidden();
      await page.clock.fastForward(240000);
      await expect(page.locator('.room-open .player-version')).toHaveCount(0);
      const manualStatus=page.locator('.room-open .version-request-status');
      await expect(manualStatus).toContainText('Muestra ENet antigua');
      await expect(manualStatus.locator('time')).toHaveAttribute('datetime',snapshot.consultado_en);
      assert.equal(requests.length,2,'expiration must never trigger another version read');
      await page.locator('.room-open [data-query-versions]').dispatchEvent('click');
      await expect.poll(()=>requests.length).toBe(3);
      await expect(manualStatus).toContainText('Muestra ENet antigua');
      await expect(manualStatus.locator('time')).toHaveAttribute('datetime',snapshot.consultado_en);
      await expect(page.locator('.room-open .player-version')).toHaveCount(0);
      rooms[0].players=[{nickname:'Nuevo',gameName:smash}];
      await page.clock.fastForward(8*3600000);
      await expect(eden).toHaveCount(0);
      await expect(page.locator('.room-open .player-row')).toHaveCount(1);
      await expect(page.locator('.room-open .player-row')).toContainText('Nuevo');
      await expect(page.locator('.room-open .room-summary')).toContainText('1/32');
      await expect(page.locator('.version-request-status time')).toHaveAttribute('datetime',snapshot.consultado_en);
      assert.equal(requests.length,3,'waiting must never trigger another version read');
      const publishedAt = await page.evaluate(() => new Date(Date.now()+9000).toISOString());
      rooms[0].scheduledVersionsAt = publishedAt;
      rooms[0].players = [{...players[0],gameVersion:'4.0.2',gameVersionSource:'enet-scheduled',gameVersionObservedAt:publishedAt}];
      await page.clock.fastForward(10001);
      await expect(manualStatus).toContainText('Muestra ENet reciente');
      await expect(manualStatus.locator('time')).toHaveAttribute('datetime',publishedAt);
      await expect(eden.locator('.player-version')).toHaveText('Versión 4.0.2');
      assert.equal(requests.length,3);
      snapshot={...snapshot,consultado_en:new Date(Date.parse(publishedAt)-299000).toISOString()};
      await page.locator('.room-open [data-query-versions]').dispatchEvent('click');
      await expect.poll(()=>requests.length).toBe(4);
      await expect(page.locator('.room-open [data-query-versions]')).toBeEnabled();
      await expect(manualStatus).toContainText('Muestra ENet reciente');
      await expect(eden.locator('.player-version')).toHaveText('Versión 4.0.2');
      publicationUnavailable=true;
      await page.locator('.room-open [data-query-versions]').dispatchEvent('click');
      await expect(manualStatus).toContainText('No se pudieron consultar las versiones');
      await expect(manualStatus).toContainText('Muestra ENet reciente');
      await expect(manualStatus.locator('time')).toHaveAttribute('datetime',publishedAt);
      await expect(eden.locator('.player-version')).toHaveText('Versión 4.0.2');
      publicationUnavailable=false;
      await page.locator('[data-room-toggle="9.9.9.9:6007"]').click();
      assert.ok(!requests.includes('lobby-9-9-9-9-6007'));
      rooms[1].scheduledVersionsAt = null;
      await page.clock.fastForward(10001);
      await expect(page.locator('.room-open .version-request-status')).toHaveText('Versiones ENet no disponibles');
      await expect(page.locator('.room-open .version-request-status')).toHaveCSS('display','none');
      await expect(page.locator('.room-open [data-query-versions]')).toHaveCSS('display','none');
      const recent = await page.evaluate(() => new Date().toISOString());
      rooms[1].scheduledVersionsAt = recent;
      rooms[1].players = [{...players[0],gameVersion:'4.0.2',gameVersionSource:'enet-scheduled',gameVersionObservedAt:recent}];
      await page.clock.fastForward(10001);
      await expect(page.locator('.room-open .version-request-status')).toContainText('Muestra ENet reciente');
      await expect(page.locator('.room-open .player-version')).toHaveText('Versión 4.0.2');
      await page.clock.fastForward(360000);
      await expect(page.locator('.room-open .version-request-status')).toContainText('Muestra ENet antigua');
      await expect(page.locator('.room-open .player-version')).toHaveCount(0);
      await page.locator('.room-open [data-query-versions]').dispatchEvent('click');
      await expect.poll(()=>requests.includes('lobby-9-9-9-9-6007')).toBe(true);
      await expect(page.locator('.room-open .player-version')).toHaveCount(0);
      await expect(page.locator('.room-open .version-request-status')).toHaveText('Versión no disponible');
      await expect(page.locator('.room-open .player-name')).toContainText('Eden');
      await expect(page.locator('.room-open .player-game')).toHaveText(mario);
      await expect(page.locator('.room-open .player-row')).not.toContainText(/desconocida|no disponible|sin consultar/i);
      if (device === 'mobile') await page.locator('#openFilters').click();
      await page.locator('#portFilter').fill('20668');
      await expect(page.locator('.room-accordion')).toHaveCount(1);
      await page.locator('#clearFilters').click();
      await expect(page.locator('.room-accordion')).toHaveCount(2);
      if (device === 'mobile') await page.locator('#closeFilters').click();
      await page.context().grantPermissions(['clipboard-read','clipboard-write']);
      await page.locator('[data-room-toggle="8.8.8.8:20668"]').click();
      await page.locator('.room-open [data-share]').click();
      const share=page.getByRole('dialog',{name:'Compartir sala'});
      await expect(share).toBeVisible();
      const link=new URL('#sala=8.8.8.8%3A20668',page.url()).href;
      const message=`Sala: ${rooms[0].name}\nJuego: ${smash}\nIP: 8.8.8.8\nPuerto UDP: 20668\n${link}`;
      await expect(share.getByRole('link',{name:'Enviar por WhatsApp'}))
        .toHaveAttribute('href','https://wa.me/?text='+encodeURIComponent(message));
      await share.getByRole('button',{name:'Copiar enlace'}).click();
      await expect(share.getByRole('status')).toHaveText('Enlace copiado.');
      assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),link);
      await share.getByRole('button',{name:'Copiar datos de conexión'}).click();
      await expect(share.getByRole('status')).toHaveText('Datos de conexión copiados.');
      assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),
        `Sala: ${rooms[0].name}\nIP: 8.8.8.8\nPuerto UDP: 20668`);
      await page.keyboard.press('Escape');
      await expect(share).toBeHidden();
      await expect(page.locator('[data-share-chat]')).toHaveCount(0);
      await expect(page.getByRole('button',{name:'Compartir en el chat'})).toHaveCount(0);
      await page.getByRole('button',{name:'Chat',exact:true}).click();
      await expect(page.locator('#chatPanel')).toBeVisible();
      await page.locator('#chatEntryNickname').fill('Vecino');
      await page.getByRole('button',{name:'Ingresar'}).click();
      await page.getByRole('button',{name:'Enviar',exact:true}).click();
      await expect(page.locator('#chatMessages')).toContainText('¿Alguien quiere jugar?');
      await page.getByRole('button',{name:'Cambiar a escribir mensaje'}).click();
      await page.locator('#chatCustomMessage').fill('Hola Eden');
      await page.getByRole('button',{name:'Enviar',exact:true}).click();
      await expect(page.locator('#chatMessages')).toContainText('Hola Eden');
      await page.getByRole('button',{name:'Cerrar chat'}).click();
      await expect(page.locator('#chatPanel')).toBeHidden();
      await page.goto(link);
      await expect(page.locator('.room-open [data-room-toggle="8.8.8.8:20668"]')).toBeVisible();
      rooms[1]={name:'Sala sin puerto publicado',address:'9.9.9.9',maxPlayers:4,players:[]};
      await page.reload();
      await page.locator('[data-room-toggle="9.9.9.9:"]').click();
      await page.locator('.room-open [data-share]').click();
      await expect(share.getByRole('link',{name:'Enviar por WhatsApp'})).toHaveAttribute(
        'href','https://wa.me/?text='+encodeURIComponent('Sala: Sala sin puerto publicado\nIP: 9.9.9.9'));
      await share.getByRole('button',{name:'Copiar enlace'}).click();
      await expect(share.getByRole('status')).toHaveText('Enlace copiado.');
      assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),new URL('/',link).href);
      await page.keyboard.press('Escape');
      rooms[0].hasPassword=true;
      await page.clock.fastForward(10001);
      await page.locator('[data-room-toggle="8.8.8.8:20668"]').click();
      const returnStatus=page.getByRole('status').and(page.locator('#bridgeNotice'));
      await expect(returnStatus).toHaveCount(1);
      await expect(returnStatus).toBeEmpty();
      await page.locator('.room-open [data-connect]').click();
      await expect(page.locator('#dialogPasswordWarning')).toBeVisible();
      await page.locator('.bridge-options summary').click();
      const send=page.getByRole('button',{name:'Enviar a PS5'});
      await expect(send.locator('svg use')).toHaveAttribute('href','#icon-gamepad');
      await expect(send).toHaveCSS('color','rgb(255, 255, 255)');
      await expect(send).toHaveCSS('background-color','rgb(20, 87, 191)');
      await expect(send).toHaveCSS('border-radius','12px');
      await send.click();
      await expect(page.locator('#bridgeSendStatus')).toContainText('Escribí un apodo');
      await expect(page.locator('#edenNickname')).toBeFocused();
      await page.locator('#edenNickname').fill('JugadorPS5');
      await page.locator('#edenPs5Ip').fill('256.0.0.1');
      await send.click();
      await expect(page.locator('#bridgeSendStatus')).toHaveAttribute('data-state','error');
      await expect(page.locator('#edenPs5Ip')).toBeFocused();
      await page.locator('#edenPs5Ip').fill('192.0.2.10');
      await send.click();
      await expect(page.locator('#sendLanPreview')).toHaveAttribute('aria-busy','true');
      await expect(page.locator('#sendLanPreview')).toBeDisabled();
      await expect.poll(()=>bridgeRequest?.pathname).toBe('/v1/transfer'+suffix);
      assert.deepEqual([...bridgeRequest.searchParams.keys()],['host','port','nick','intent']);
      assert.equal(bridgeRequest.searchParams.get('host'),'8.8.8.8');
      assert.equal(bridgeRequest.searchParams.get('port'),'20668');
      assert.equal(bridgeRequest.searchParams.get('nick'),'JugadorPS5');
      assert.match(bridgeRequest.searchParams.get('intent'),/^[a-f0-9]{32}$/);
      await page.clock.fastForward(10001);
      await expect(page.locator('#bridgeSendStatus')).toContainText('volvé a intentar');
      await expect(send).toBeEnabled();
      const expiredIntent = bridgeRequest.searchParams.get('intent');
      await page.clock.fastForward(300001);
      const connectDialog=page.getByRole('dialog',{name:'Conectar PS5 · ProsperoEden'});
      const sendStatus=connectDialog.getByRole('status');
      await page.locator('.bridge-options summary').click();
      await expect(sendStatus).toHaveCount(0);
      await page.evaluate(hash=>{location.hash=hash}, '#eden-bridge-challenge='+expiredIntent+'.'+token);
      await expect(sendStatus).toHaveAttribute('data-state','error');
      await expect(sendStatus).toHaveText('No se pudo verificar el envío. Volvé a iniciar el envío desde esta pestaña.');
      await expect(sendStatus).toBeVisible();
      await expect(page.locator('#bridgeNotice')).toBeEmpty();
      await expect(send).toBeEnabled();
      await expect(page).toHaveURL(origin+'/');
      assert.equal(receives.length,0);
      await expect(connectDialog).toBeVisible();
      await page.locator('#closeConnectDialog').click();
      await expect(connectDialog).toBeHidden();
      await page.evaluate(()=>{location.hash='#eden-bridge-saved='+'a'.repeat(32)+'.'+'b'.repeat(32)});
      await expect(returnStatus).toHaveAttribute('data-state','error');
      await expect(returnStatus).toContainText('No se pudo verificar');
      await expect(page).toHaveURL(origin+'/');
      await expect(page.locator('#sendLanLegacy')).toHaveCount(0);
      await page.locator('.room-open [data-connect]').click();
      if (!(await send.isVisible())) await page.locator('.bridge-options summary').click();
      await assertDialogFits(connectDialog,`Eden Rooms Bridge dialog on ${device}`,true);
      retry=true;
      await send.click();
      const confirmation=page.getByRole('button',{name:'Confirmar en el Bridge simulado'});
      await expect(confirmation).toBeVisible();
      const pendingIntent=bridgeRequest.searchParams.get('intent');
      assert.equal(new URL(page.url()).hash,'#'+pendingIntent+'.'+token);
      assert.deepEqual(redirects,[origin+'/#eden-bridge-challenge='+pendingIntent+'.'+token]);
      await confirmation.click();
      await expect(returnStatus).toHaveAttribute('data-state','success');
      await expect(returnStatus).toHaveText('Eden Bridge confirmó el envío de la sala.');
      await expect(page).toHaveURL(origin+'/');
      await expect(page.locator('.room-open.room-highlight [data-room-toggle="8.8.8.8:20668"]')).toBeVisible();
      await page.locator('.room-open [data-connect]').click();
      await expect(page.locator('#edenNickname')).toHaveValue('JugadorPS5');
      await expect(page.locator('#edenPs5Ip')).toHaveValue('192.0.2.10');
      await page.locator('#closeConnectDialog').click();
      assert.equal(receives.length,1);
      assert.deepEqual(Object.fromEntries(receives[0].searchParams),
        {host:'8.8.8.8',port:'20668',nick:'JugadorPS5'});
      assert.deepEqual(redirects,['challenge','saved'].map(phase=>
        origin+'/#eden-bridge-'+phase+'='+pendingIntent+'.'+token));
      assert.notEqual(bridgeRequest.searchParams.get('intent'),expiredIntent);
      assert.equal(page.context().pages().length,1);
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),
        `Eden Rooms layout must fit the ${device} viewport`);
      await page.goto(origin+'/ps5/');
      await page.getByRole('button',{name:'Conectar PS5'}).first().click();
      await expect(page.locator('#endpoint')).toHaveText('8.8.8.8:20668');
      await assertDialogFits(page.getByRole('dialog'),`/ps5/ dialog on ${device}`);
      await page.getByRole('button',{name:'Enviar a ProsperoEden'}).click();
      await expect(page.locator('#connectState')).toContainText('Podés copiar los datos manualmente');
      await page.getByRole('button',{name:'Copiar IP y puerto'}).click();
      await expect(page.locator('#connectState')).toContainText('8.8.8.8:20668');
      await page.getByRole('button',{name:'Cerrar',exact:true}).click();
      assert.deepEqual(unexpectedRequests,[]);
      assert.deepEqual(errors,[],'page must have no JavaScript errors');
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),
        `/ps5/ layout must fit the ${device} viewport`);
    }finally{
      await browser?.close();
      site.close();
      bridge.close();
    }
  });
}
