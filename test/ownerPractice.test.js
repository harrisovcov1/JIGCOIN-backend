'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {randomUUID} = require('node:crypto');
const {createOwnerPractice} = require('../lib/ownerPractice');
const games = require('../lib/championshipGames');
const solve = require('./helpers/championshipSolver.cjs');
const {startIsolatedApp, signedInitData} = require('./helpers/httpApp.cjs');
const owner = '10001';

test('owner practice uses all 30 accepted boards, server scores and five rounds, separate from daily competition', () => {
  let now = Date.now(), board;
  const service = createOwnerPractice({clock: () => now, deal: v => (board = games.puzzle(v))});
  assert.equal(service.status(owner).variants.length, 30);
  let previous = null;
  for (let variant = 0; variant < 30; variant++) {
    const start = {mode:'practice', request:randomUUID(), variant, previous};
    let run = service.act(owner,'start',start);
    assert.equal(service.act(owner,'start',start).id, run.id);
    assert.equal(service.act(owner,'resume',{id:run.id}).round,0);
    for (let round = 0; round < 5; round++) {
      assert.equal(run.name,games.names[variant]);
      for (const key of ['solution','faces','reveal','crossings']) assert.equal(run.board[key],undefined);
      const actions = solve(board);
      const observation = games.observation(board);
      if (observation) {
        const req = {id:run.id,round};
        assert.deepEqual(service.act(owner,'observe',req).frame, observation.frames[0]);
        assert.throws(()=>service.act(owner,'answer',{...req,actions}),/OBSERVE_FIRST/);
        now += observation.interval * observation.frames.length;
        assert.equal(service.act(owner,'observe',req).done,true);
      }
      if (board.hidden) actions.forEach((tile,step) => {
        const req = {id:run.id,round,tile,step};
        assert.deepEqual(service.act(owner,'flip',req),service.act(owner,'flip',req));
      });
      const req = {id:run.id,round,actions};
      run = service.act(owner,'answer',req);
      assert.equal(run.score,(round+1)*200);
      assert.equal(service.act(owner,'answer',req).score,run.score);
    }
    assert.equal(run.finished,true); previous=run.id;
  }
  now += 600001;
  assert.equal(service.status(owner).run,null);
  assert.throws(()=>service.act(owner,'resume',{id:previous}),/REOPEN_PRACTICE/);
});

test('real HTTP routes enforce signed owner, existing eligible account, mode, expiry and no financial writes', async t=>{
  let eligible=true;
  const queries=[];
  const pool={async query(sql,params){
    queries.push(sql);
    if (sql.includes('SELECT 1 FROM public.users u WHERE u.telegram_id=$1')) {
      assert.deepEqual(params,[owner]);return {rowCount:eligible?1:0,rows:[]};
    }
    return {rows:[]};
  }};
  const app=await startIsolatedApp(t,false,{pool,env:{CHAMPIONSHIP_OWNER_PREVIEW_ID:owner,CHAMPIONSHIP_V2:'0'}});
  queries.length=0;
  const post=async(path,raw,body={})=>{
    const resp=await fetch(app.url+'/api/championship/'+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...body,telegram_id:10001,initData:raw})});
    return {status:resp.status,data:await resp.json()};
  };
  const valid=signedInitData(Number(owner)), other=signedInitData(20002);
  const req={previous:null,variant:0,request:randomUUID(),mode:'practice'};
  assert.equal((await post('status','')).status,401);
  assert.deepEqual((await post('status',other)).data,{active:false});
  assert.equal((await post('owner-practice/start',other,req)).status,403);
  assert.equal((await post('owner-practice/start',signedInitData(Number(owner),{age:200000}),req)).status,401);
  assert.equal((await post('status',valid)).data.ownerPractice.variants.length,30);
  assert.equal((await post('owner-practice/start',valid,{...req,mode:'ranked'})).status,400);
  const run=(await post('owner-practice/start',valid,req)).data;
  assert.ok(run.id);
  assert.equal((await post('owner-practice/resume',other,{id:run.id})).status,403);
  assert.equal((await post('owner-practice/start',valid,{...req,request:randomUUID()})).status,409);
  eligible=false;
  assert.equal((await post('owner-practice/resume',valid,{id:run.id})).status,403);
  assert.deepEqual((await post('status',valid)).data,{active:false});
  assert.ok(queries.every(s=>s.startsWith('SELECT 1 FROM public.users') && s.includes('championship_exclusions')));
});

test('preview routes stay unregistered with missing owner or with official competition enabled',async t=>{
  for (const env of [{},{CHAMPIONSHIP_OWNER_PREVIEW_ID:owner,CHAMPIONSHIP_V2:'1'}]){
    const app=await startIsolatedApp(t,false,{env});
    const r=await fetch(app.url+'/api/championship/owner-practice/start',{method:'POST'});
    assert.equal(r.status,404);
  }
});
