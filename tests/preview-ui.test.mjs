// Optional real Chromium regression; network API responses are local fixtures only.
// EDEN_PLAYWRIGHT_MODULE=/absolute/path/to/@playwright/test/index.mjs node --test tests/preview-ui.test.mjs
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
const root=new URL('../',import.meta.url);
for(const [device,width,height] of [['desktop',1280,900],['mobile',390,844]]){
  test(`Preview UI (${device}): persistent versions, query time and room isolation`,{skip:!process.env.EDEN_PLAYWRIGHT_MODULE},async()=>{
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
      const rooms=[{name:'Sala Preview 20668',address:'8.8.8.8',port:20668,maxPlayers:32,preferredGameName:smash,players,versionsRoomId:'lobby-8-8-8-8-20668'},
        {name:'Otra sala',address:'9.9.9.9',port:6007,maxPlayers:32,preferredGameName:mario,players:[{...players[0],gameVersion:'Versión desconocida'}],versionsRoomId:'lobby-9-9-9-9-6007'}];
      const snapshot={disponible:true,sala_id:'lobby-8-8-8-8-20668',consultado_en:new Date(now-3600000).toISOString(),endpoint:{direccion:"8.8.8.8",puerto:20668},jugadores:[
        {nombre:'Eden',juego:mario,virtual_ip:'10.0.0.10',version:'4.0.1',title_id:'0100152000022000'},
        {nombre:'SataHT',juego:smash,virtual_ip:'10.0.0.11',version:'13.0.5',title_id:'01006A800016E000'},
        {nombre:'SinVersion',juego:mario,version:''},
        {nombre:'Repetido',juego:smash,virtual_ip:'10.0.0.1',version:'13.0.2'},
        {nombre:'Repetido',juego:smash,virtual_ip:'10.0.0.2',version:'13.0.3'}]};
      await page.route('**/api/**',async route=>{
        const url=new URL(route.request().url());
        if(url.pathname==='/api/rooms')return route.fulfill({json:{rooms}});
        if(url.pathname==='/api/versiones-publicadas'){
          assert.equal(route.request().method(),'GET');
          assert.equal(route.request().headers()['x-api-key'],undefined);
          assert.equal(route.request().headers()['x-enet-preview-key'],undefined);
          const id=url.searchParams.get('id');requests.push(id);
          return route.fulfill({json:id==='lobby-8-8-8-8-20668'?snapshot:{disponible:false,sala_id:id,jugadores:[]}});
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
      await page.locator('#closeConnectDialog').click();
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
      assert.deepEqual(unexpectedRequests,[]);
      assert.deepEqual(errors,[],'page must have no JavaScript errors');
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),'layout must fit viewport');
    }finally{
      await browser?.close();await new Promise(resolve=>server.close(resolve));
    }
  });
}
