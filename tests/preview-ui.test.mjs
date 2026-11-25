// Optional real Chromium regression; network API responses are local fixtures only.
// EDEN_PLAYWRIGHT_MODULE=/absolute/path/to/@playwright/test/index.mjs node --test tests/preview-ui.test.mjs
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
const root=new URL('../',import.meta.url);
for(const [device,width,height] of [['desktop',1280,900],['mobile',390,844]]){
  test(`Preview UI (${device}): versions, sharing, chat and PS5`,{skip:!process.env.EDEN_PLAYWRIGHT_MODULE},async()=>{
    const {chromium,expect}=await import(process.env.EDEN_PLAYWRIGHT_MODULE);
    const server=createServer(async(req,res)=>{
      try{
        const path=new URL(req.url,'http://localhost').pathname;
        if(!['/','/index.html','/ps5/','/assets/player-versions.js','/assets/bridge-status.js'].includes(path)){
          res.writeHead(404);res.end();return;
        }
        const content=await readFile(new URL(path.startsWith('/assets/')?path.slice(1):path==='/ps5/'?'ps5/index.html':'index.html',root));
        res.writeHead(200,{'Content-Type':path.endsWith('.js')?'text/javascript':'text/html; charset=utf-8'});res.end(content);
      }catch{res.writeHead(500);res.end();}
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    let browser;
    try{
      browser=await chromium.launch({headless:true,executablePath:process.env.EDEN_CHROMIUM,args:['--no-sandbox','--disable-dev-shm-usage']});
      const page=await browser.newPage({viewport:{width,height},timezoneId:'America/Montevideo'});
      const now=Date.parse('2026-11-16T17:14:00Z'),errors=[],requests=[],unexpectedRequests=[];
      page.on('pageerror',error=>errors.push(error.message));
      await page.clock.install({time:new Date(now)});
      const mario='Mario Kart 8 Deluxe',smash='Super Smash Bros. Ultimate';
      const players=[{nickname:'Eden',gameName:mario,fakeIp:'10.0.0.10'},{nickname:'SataHT',gameName:smash,fakeIp:'10.0.0.11'},
        {nickname:'SinVersion',gameName:mario},{nickname:'Repetido',gameName:smash,fakeIp:'10.0.0.1'},
        {nickname:'Repetido',gameName:smash,fakeIp:'10.0.0.2'}];
      const rooms=[{name:'Sala Preview 20668 & Pokémon 🏁',password:'no-compartir',token:'no-compartir',address:'8.8.8.8',port:20668,maxPlayers:32,preferredGameName:smash,players,versionsRoomId:'lobby-8-8-8-8-20668'},
        {name:'Otra sala',address:'9.9.9.9',port:6007,maxPlayers:32,preferredGameName:mario,players:[{...players[0],gameVersion:'Versión desconocida'}],versionsRoomId:'lobby-9-9-9-9-6007'}];
      const snapshot={disponible:true,sala_id:'lobby-8-8-8-8-20668',consultado_en:new Date(now-3600000).toISOString(),endpoint:{direccion:"8.8.8.8",puerto:20668},jugadores:[
        {nombre:'Eden',juego:mario,virtual_ip:'10.0.0.10',version:'4.0.1',title_id:'0100152000022000'},
        {nombre:'SataHT',juego:smash,virtual_ip:'10.0.0.11',version:'13.0.5',title_id:'01006A800016E000'},
        {nombre:'SinVersion',juego:mario,version:''},
        {nombre:'Repetido',juego:smash,virtual_ip:'10.0.0.1',version:'13.0.2'},
        {nombre:'Repetido',juego:smash,virtual_ip:'10.0.0.2',version:'13.0.3'}]};
      const origin=`http://127.0.0.1:${server.address().port}`;
      const chatMessages=[];
      await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
      await page.route(new RegExp('^'+origin+'/api/'),async route=>{
        const url=new URL(route.request().url());
        if(url.pathname==='/api/rooms')return route.fulfill({json:{rooms}});
        if(url.pathname==='/api/versiones-publicadas'){
          assert.equal(route.request().method(),'GET');
          assert.equal(route.request().headers()['x-api-key'],undefined);
          assert.equal(route.request().headers()['x-enet-preview-key'],undefined);
          const id=url.searchParams.get('id');requests.push(id);
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
      await page.goto(`http://127.0.0.1:${server.address().port}/`);
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
      await expect(page.locator('.room-open [data-query-versions]')).toBeHidden();
      await page.locator('.room-open [data-query-versions]').dispatchEvent('click');
      await expect(page.locator('.room-open .player-version')).toHaveCount(3);
      await page.locator('.room-open [data-expand]').click();
      await expect(page.locator('.room-open .player-version')).toHaveCount(4);
      const eden=page.locator('.room-open .player-row').filter({hasText:'Eden'});
      await expect(eden).toContainText('Versión 4.0.1');
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
      const bridgeTransfers=[],bridgeReceives=[];
      await page.route('http://192.0.2.10:24879/v1/**',route=>{
        const url=new URL(route.request().url());
        if(url.pathname==='/v1/transfer/preview')bridgeTransfers.push(url);
        if(url.pathname==='/v1/receive/preview')bridgeReceives.push(url);
        // Keep the page open and stop at the receiver, before any approval or save.
        return route.fulfill({status:204});
      });
      await send.click();
      await expect(page.locator('#sendLanPreview')).toHaveAttribute('aria-busy','true');
      await expect(page.locator('#sendLanPreview')).toBeDisabled();
      await expect.poll(()=>bridgeTransfers.length).toBe(1);
      const [bridgeRequest]=bridgeTransfers;
      assert.deepEqual([...bridgeRequest.searchParams.keys()],['host','port','nick','intent']);
      assert.equal(bridgeRequest.searchParams.get('host'),'8.8.8.8');
      assert.equal(bridgeRequest.searchParams.get('port'),'20668');
      assert.equal(bridgeRequest.searchParams.get('nick'),'JugadorPS5');
      assert.match(bridgeRequest.searchParams.get('intent'),/^[a-f0-9]{32}$/);
      await page.clock.fastForward(10001);
      await expect(page.locator('#bridgeSendStatus')).toContainText('volvé a intentar');
      await expect(send).toBeEnabled();
      await expect(page.locator('#connectDialog')).toBeVisible();
      const bridgeNotice=page.locator('#bridgeNotice');
      const returnChallenge=async (intent,token)=>{
        await page.evaluate(hash=>{location.hash=hash},`eden-bridge-challenge=${intent}.${token}`);
      };
      const expiredIntent=bridgeRequest.searchParams.get('intent');
      await page.clock.fastForward(300000);
      await returnChallenge(expiredIntent,'a'.repeat(32));
      await page.locator('#closeConnectDialog').click();
      await expect(bridgeNotice).toHaveAttribute('data-state','error');
      await expect(bridgeNotice).toContainText('No se pudo verificar');
      assert.equal(bridgeReceives.length,0);
      const readPending=()=>page.evaluate(()=>JSON.parse(sessionStorage.getItem('edenBridgeIntent')));
      assert.equal((await readPending()).token,undefined);

      await page.locator('.room-open [data-connect]').click();
      await send.click();
      await expect.poll(()=>bridgeTransfers.length).toBe(2);
      const currentIntent=bridgeTransfers[1].searchParams.get('intent');
      assert.notEqual(currentIntent,expiredIntent);
      const token='b'.repeat(32);
      await returnChallenge(currentIntent,token);
      await expect.poll(()=>bridgeReceives.length).toBe(1);
      assert.deepEqual([...bridgeReceives[0].searchParams],[
        ['host','8.8.8.8'],['port','20668'],['nick','JugadorPS5'],
      ]);
      assert.equal((await readPending()).token,token);
      await expect(bridgeNotice).toBeEmpty();
      await expect(page.locator('#connectDialog')).toBeVisible();
      await page.locator('#closeConnectDialog').click();
      await page.evaluate(()=>{location.hash='#eden-bridge-saved='+'a'.repeat(32)+'.'+'b'.repeat(32)});
      await expect(page.locator('#bridgeNotice')).toHaveAttribute('data-state','error');
      await expect(page.locator('#bridgeNotice')).toContainText('No se pudo verificar');
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
      await expect(page.locator('.room-open [data-query-versions]')).toBeHidden();
      await page.locator('.room-open [data-query-versions]').dispatchEvent('click');
      await expect.poll(()=>requests.length).toBe(2);
      await page.clock.fastForward(31000);
      await expect.poll(()=>requests.length).toBe(2);
      assert.equal(requests.length,2);
      await page.clock.fastForward(90000);
      await expect(page.locator('.room-open .player-version')).toHaveCount(4);
      await expect(eden).toContainText('Versión 4.0.1');
      await expect(page.locator('.version-request-status time')).toHaveText('Versiones consultadas a las 13:14');
      rooms[0].players=[{nickname:'Nuevo',gameName:smash}];
      await page.clock.fastForward(8*3600000);
      await expect(eden).toHaveCount(0);
      await expect(page.locator('.room-open .player-row')).toHaveCount(1);
      await expect(page.locator('.room-open .player-row')).toContainText('Nuevo');
      await expect(page.locator('.room-open .room-summary')).toContainText('1/32');
      await expect(page.locator('.version-request-status time')).toHaveAttribute('datetime',snapshot.consultado_en);
      assert.equal(requests.length,2,'waiting must never trigger another version read');
      await page.locator('[data-room-toggle="9.9.9.9:6007"]').click();
      assert.ok(!requests.includes('lobby-9-9-9-9-6007'));
      await expect(page.locator('.room-open [data-query-versions]')).toBeHidden();
      await page.locator('.room-open [data-query-versions]').dispatchEvent('click');
      await expect.poll(()=>requests.includes('lobby-9-9-9-9-6007')).toBe(true);
      await expect(page.locator('.room-open .player-version')).toHaveCount(0);
      await expect(page.locator('.room-open .version-request-status')).toHaveCount(0);
      await expect(page.locator('.room-open .player-name')).toContainText('Eden');
      await expect(page.locator('.room-open .player-game')).toHaveText(mario);
      await expect(page.locator('.room-open .player-row')).not.toContainText(/desconocida|no disponible|sin consultar/i);
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
      await share.getByRole('button',{name:'Cerrar'}).click();
      await page.locator('.room-open [data-connect]').click();
      await expect(page.locator('#edenNickname')).toHaveValue('JugadorPS5');
      await expect(page.locator('#edenPs5Ip')).toHaveValue('192.0.2.10');
      await page.locator('#closeConnectDialog').click();
      // Exercise only presentation, without a Bridge return or approval.
      const liveNotice=page.getByRole('status').and(bridgeNotice);
      await expect(liveNotice).toHaveCount(1);
      await expect(liveNotice).toHaveAttribute('aria-atomic','true');
      await expect(liveNotice).toBeEmpty();
      assert.equal(await liveNotice.evaluate(notice=>notice.getBoundingClientRect().height),0);
      await bridgeNotice.evaluate(async notice=>{
        const {showBridgeSaveSuccess}=await import('/assets/bridge-status.js');
        showBridgeSaveSuccess(notice);
      });
      await expect(liveNotice).toBeVisible();
      await expect(bridgeNotice).toHaveAttribute('data-state','success');
      await expect(bridgeNotice).toHaveText('Sala guardada correctamente en la PS5.');
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),
        `Eden Rooms layout must fit the ${device} viewport`);
      await page.goto(origin+'/ps5/');
      await page.getByRole('button',{name:'Conectar PS5'}).first().click();
      await expect(page.locator('#endpoint')).toHaveText('8.8.8.8:20668');
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
      await browser?.close();await new Promise(resolve=>server.close(resolve));
    }
  });
}
