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
