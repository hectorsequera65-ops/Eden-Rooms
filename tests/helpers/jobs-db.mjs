import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
export function jobsDB(){
  const sqlite=new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../fixtures/versions-schema.sql',import.meta.url),'utf8'));
  sqlite.exec(readFileSync(new URL('../../migrations/0001_enet_jobs.sql',import.meta.url),'utf8'));
  const DB={prepare(sql){
    const statement=sqlite.prepare(sql);
    function bound(params=[]){return {bind:(...args)=>bound(args),first:async()=>statement.get(...params)??null,
      all:async()=>({results:statement.all(...params)}),run:async()=>({meta:statement.run(...params)}),
      _run:()=>({meta:statement.run(...params)})};}
    return bound();
  },async batch(statements){
    sqlite.exec('BEGIN');
    try{const results=statements.map(s=>s._run());sqlite.exec('COMMIT');return results;}
    catch(error){sqlite.exec('ROLLBACK');throw error;}
  }};
  function room(id='smash',address='69.24.117.72',port=20668){
    sqlite.prepare('INSERT INTO salas_autorizadas VALUES (?,?,1)').run(id,id);
    sqlite.prepare('INSERT INTO salas_endpoints VALUES (?,?,?)').run(id,address,port);
  }
  return {sqlite,DB,room};
}
