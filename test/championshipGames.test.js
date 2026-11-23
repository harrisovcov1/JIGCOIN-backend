const test=require('node:test');
const assert=require('node:assert/strict');
const {names,puzzle,validate,display}=require('../lib/championshipGames');
const solve=require('./helpers/championshipSolver.cjs');
for(const [index,name] of names.entries())test(name+' issues solvable boards and validates actions',()=>{
 for(let sample=0;sample<32;sample++){
  const p=puzzle(index);
  assert.equal(validate(p,solve(p)),true);
  for(const invalid of [[],[999],['0'],null])assert.equal(validate(p,invalid),false);
  assert.equal('solution' in display(p),false);
 }
});
test('Coin Value balances two trays; an ascending tile permutation is invalid',()=>{
 for(let i=0;i<64;i++){
  const p=puzzle(18),answer=solve(p);
  assert.equal(p.rule,'trays');assert.equal(p.tiles.length,2);
  assert.deepEqual(p.targetsByTray.reduce((a,b)=>a+b),p.coins.reduce((a,b)=>a+b));
  assert.equal(validate(p,[...p.coins.keys()].sort((a,b)=>p.coins[a]-p.coins[b])),false);
  assert.equal(validate(p,answer),true);
  const wrong=[...answer];wrong[0]=1-wrong[0];assert.equal(validate(p,wrong),false);
 }
});
test('memory answer phase omits reveal sequences and hidden tile identities',()=>{
 for(const index of [3,4,5,15,17,29]){
  const p=puzzle(index),client=display(p);assert.equal(client.observe,true);
  for(const key of ['solution','faces','reveal','crossings'])assert.equal(key in client,false);
  if(index===29)assert.deepEqual(client.tiles,['1','2','3','4','5','6']);
 }
});
test('partial credit is deterministic, bounded and requires a complete ordered response',()=>{
 const {points}=require('../lib/championshipGames');
 const p=puzzle(6),a=solve(p),b=[...a];[b[4],b[5]]=[b[5],b[4]];
 assert.equal(points(p,a),200);assert.equal(points(p,b),66);assert.equal(points(p,a.slice(0,4)),0);
});
