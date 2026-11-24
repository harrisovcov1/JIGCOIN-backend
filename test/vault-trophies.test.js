'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {createVaultTrophies}=require('../lib/vaultTrophies');
const player={id:71,telegram_id:101};
test('empty trophy history is verified and independent of activation',async()=>{
 const service=createVaultTrophies({pool:{query:async(sql,args)=>{
  assert.match(sql,/WHERE t\.player=\$1/);assert.deepEqual(args,[71]);assert.doesNotMatch(sql,/INSERT|UPDATE|DELETE|settle/i);return {rows:[]};
 }}});
 assert.deepEqual(await service.history(player),{ok:true,telegram_id:'101',trophies:[]});
});
test('only matching ledger-backed podium credits are exposed; discrepancies fail closed',async()=>{
 const row={week:'2026-11-30',place:1,score:6000,coins:100000,ledger_verified:true};
 let current=row;
 const service=createVaultTrophies({pool:{query:async()=>({rows:[current]})}});
 assert.deepEqual((await service.history(player)).trophies,[{week:row.week,place:1,score:6000,coins:100000}]);
 for(const change of [{ledger_verified:false},{place:2},{coins:0},{score:6001}]){
  current={...row,...change};await assert.rejects(service.history(player),/TROPHY_HISTORY_UNVERIFIED/);
 }
});
