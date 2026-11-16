// Optional real Chromium regression; network API responses are local fixtures only.
// EDEN_PLAYWRIGHT_MODULE=/absolute/path/to/@playwright/test/index.mjs node --test tests/preview-ui.test.mjs
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
const root=new URL('../',import.meta.url);
for(const [device,width,height] of [['desktop',1280,900],['mobile',390,844]]){
  test(`Preview UI (${device}): versions, caching, expiry and room isolation`,{skip:!process.env.EDEN_PLAYWRIGHT_MODULE},async()=>{
    const {chromium,expect}=await import(process.env.EDEN_PLAYWRIGHT_MODULE);
    const server=createServer(async(req,res)=>{
      try{
        const path=new URL(req.url,'http://localhost').pathname;
        if(path!=='/'&&path!=='/index.html'&&path!=='/assets/player-versions.js'){res.writeHead(404);res.end();return;}
        const content=await readFile(new URL(path.startsWith('/assets/')?path.slice(1):'index.html',root));
        res.writeHead(200,{'Content-Type':path.endsWith('.js')?'text/javascript':'text/html; charset=utf-8'});res.end(content);
      }catch{res.writeHead(500);res.end();}
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const browser=await chromium.launch({headless:true,executablePath:process.env.EDEN_CHROMIUM||'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage']});
    try{
      const page=await browser.newPage({viewport:{width,height}});
      const now=Date.now(),errors=[],requests=[];
      page.on('pageerror',error=>errors.push(error.message));
      await page.clock.install({time:new Date(now)});
      const mario='Mario Kart 8 Deluxe',smash='Super Smash Bros. Ultimate';
      const players=[{nickname:'Eden',gameName:mario},{nickname:'SataHT',gameName:smash},
        {nickname:'SinVersion',gameName:mario},{nickname:'Repetido',gameName:smash,fakeIp:'10.0.0.1'},
        {nickname:'Repetido',gameName:smash,fakeIp:'10.0.0.2'}];
      const rooms=[{name:'Sala Preview 20668',address:'room.test',port:20668,maxPlayers:32,preferredGameName:smash,players,versionsRoomId:'sala-prueba-20668'},
        {name:'Otra sala',address:'other.test',port:6007,maxPlayers:32,preferredGameName:mario,players:[players[0]],versionsRoomId:'other'}];
      const snapshot={disponible:true,sala_id:'sala-prueba-20668',consultado_en:new Date(now).toISOString(),jugadores:[
        {nombre:'Eden',juego:mario,version:'4.0.1',title_id:'0100152000022000'},
        {nombre:'SataHT',juego:smash,version:'13.0.5',title_id:'01006A800016E000'},
        {nombre:'SinVersion',juego:mario,version:''},
        {nombre:'Repetido',juego:smash,virtual_ip:'10.0.0.1',version:'13.0.2'},
        {nombre:'Repetido',juego:smash,virtual_ip:'10.0.0.2',version:'13.0.3'}]};
      await page.route('**/api/**',async route=>{
        const url=new URL(route.request().url());
        if(url.pathname==='/api/rooms')return route.fulfill({json:{rooms}});
        if(url.pathname==='/api/versiones-sala'){
          const id=url.searchParams.get('id');requests.push(id);
          return route.fulfill({json:id==='sala-prueba-20668'?snapshot:{disponible:false,sala_id:id,jugadores:[]}});
        }
        if(url.pathname==='/api/geo')return route.fulfill({json:{country:'Uruguay',countryCode:'UY'}});
        return route.fulfill({status:404,body:''});
      });
      await page.goto(`http://127.0.0.1:${server.address().port}/`);
      await expect(page.locator('.room-accordion')).toHaveCount(2);
      assert.equal(requests.length,0,'collapsed rooms should not request versions');
      await page.locator('[data-room-toggle="room.test:20668"]').click();
      await expect(page.locator('.room-open .player-version')).toHaveCount(3);
      await page.locator('.room-open [data-expand]').click();
      await expect(page.locator('.room-open .player-version')).toHaveCount(4);
      const eden=page.locator('.room-open .player-row').filter({hasText:'Eden'});
      await expect(eden).toContainText('Versión 4.0.1');
      await expect(page.locator('.room-open .player-row').filter({hasText:'SinVersion'})).not.toContainText('Versión');
      await expect(page.locator('.room-open .player-row').filter({hasText:'Repetido'})).toHaveCount(2);
      assert.equal(requests.length,1);
      await page.locator('[data-favorite="room.test:20668"]').click();
      assert.deepEqual(await page.evaluate(()=>JSON.parse(localStorage.getItem('edenFavorites'))),['room.test:20668']);
      await page.locator('.room-open [data-connect]').click();
      await expect(page.locator('#connectDialog')).toBeVisible();
      await expect(page.locator('#dialogIp')).toHaveText('room.test');
      await expect(page.locator('#dialogPort')).toHaveText('20668');
      await page.locator('#closeConnectDialog').click();
      await page.locator('#theme').click();
      await expect(page.locator('html')).toHaveClass(/light/);
      await page.locator('[data-room-toggle="room.test:20668"]').click();
      await page.locator('[data-room-toggle="room.test:20668"]').click();
      assert.equal(requests.length,1,'reopening reuses fresh cached data');
      await page.clock.fastForward(31000);
      await expect.poll(()=>requests.length).toBe(1);
      await page.clock.fastForward(90000);
      await expect(page.locator('.room-open .player-version')).toHaveCount(0);
      await expect(eden).toContainText(mario);
      await page.locator('[data-room-toggle="other.test:6007"]').click();
      await expect.poll(()=>requests.includes('other')).toBe(true);
      await expect(page.locator('.room-open .player-version')).toHaveCount(0);
      assert.deepEqual(errors,[],'page must have no JavaScript errors');
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),'layout must fit viewport');
    }finally{
      await browser.close();await new Promise(resolve=>server.close(resolve));
    }
  });
}

for(const [device,width,height] of [['desktop',1280,900],['mobile',390,844]]){
  test(`On-demand UI (${device}): queue, result without reload, offline timeout and retry`,{skip:!process.env.EDEN_PLAYWRIGHT_MODULE},async()=>{
    const {chromium,expect}=await import(process.env.EDEN_PLAYWRIGHT_MODULE);
    const server=createServer(async(req,res)=>{
      const path=new URL(req.url,'http://localhost').pathname;
      if(path!=='/'&&path!=='/assets/player-versions.js'){res.writeHead(404);res.end();return;}
      res.writeHead(200,{'Content-Type':path.endsWith('.js')?'text/javascript':'text/html; charset=utf-8'});
      res.end(await readFile(new URL(path.startsWith('/assets/')?path.slice(1):'index.html',root)));
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const browser=await chromium.launch({headless:true,executablePath:process.env.EDEN_CHROMIUM||'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage']});
    try{
      const page=await browser.newPage({viewport:{width,height}});const now=Date.now();
      await page.clock.install({time:new Date(now)});
      let queued=0,polls=0,ready=false,privateRequests=0;
      const id='sala-prueba-20668',game='Super Smash Bros. Ultimate';
      await page.route('**/api/**',async route=>{
        const request=route.request(),url=new URL(request.url());
        if(url.pathname.startsWith('/api/collector'))privateRequests++;
        if(url.pathname==='/api/rooms')return route.fulfill({json:{rooms:[{name:'Preview bajo demanda',address:'69.24.117.72',port:20668,maxPlayers:32,preferredGameName:game,versionsRoomId:id,players:[{nickname:'Eden',gameName:game}]}]}});
        if(url.pathname==='/api/versiones-sala')return route.fulfill({json:ready?{disponible:true,sala_id:id,consultado_en:new Date(now+4000).toISOString(),jugadores:[{nombre:'Eden',juego:game,title_id:'01006A800016E000',version:'13.0.5'}]}:{disponible:false,sala_id:id,jugadores:[]}});
        if(url.pathname==='/api/versiones-consultar'){
          if(request.method()==='POST'){
            queued++;assert.deepEqual(request.postDataJSON(),{sala_id:id});
            assert.equal(request.headers().origin,url.origin);
            assert.equal(request.headers()['x-api-key'],undefined);assert.equal(request.headers()['x-collector-key'],undefined);
            return route.fulfill({status:202,json:{sala_id:id,estado:'pendiente',espera_ms:45000}});
          }
          polls++;if(queued===1&&polls>=2)ready=true;
          return route.fulfill({json:{sala_id:id,estado:queued===1&&ready?'listo':'consultando',espera_ms:45000}});
        }
        if(url.pathname==='/api/geo')return route.fulfill({json:{country:'Uruguay',countryCode:'UY'}});
        return route.fulfill({status:404,body:''});
      });
      await page.goto(`http://127.0.0.1:${server.address().port}/`);
      await page.locator('[data-room-toggle]').click();
      await expect(page.locator('.version-request-status')).toContainText('Consultando versiones…');
      await expect.poll(()=>queued).toBe(1);
      await page.locator('[data-room-toggle]').click();await page.locator('[data-room-toggle]').click();
      assert.equal(queued,1);
      await page.clock.fastForward(2000);await expect.poll(()=>polls).toBe(1);
      await page.clock.fastForward(2000);await expect(page.locator('.room-open .player-version')).toHaveText('Versión 13.0.5');
      assert.equal(queued,1);assert.equal(privateRequests,0);
      await page.clock.fastForward(120001);
      await expect.poll(()=>queued).toBe(2);
      await expect(page.locator('.room-open .player-version')).toHaveCount(0);
      await page.clock.fastForward(45001);
      await expect(page.locator('.version-request-status')).toContainText('No se pudieron consultar las versiones.');
      const retry=page.getByRole('button',{name:'Reintentar',exact:true});
      await expect(retry).toBeDisabled();
      await page.clock.fastForward(15001);await expect(retry).toBeEnabled();
      assert.equal(queued,2,'offline worker must not cause automatic re-enqueue loops');
      await retry.click();await expect.poll(()=>queued).toBe(3);
      assert.equal(privateRequests,0);
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
    }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
  });
}
