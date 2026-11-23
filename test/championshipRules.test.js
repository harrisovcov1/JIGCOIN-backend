const {test}=require('node:test');
const assert=require('node:assert/strict');
const {schedule,standings}=require('../lib/championshipRules');
test('UTC season begins next full Monday and rolls through month end and UK DST',()=>{
 const accepted='2027-03-21T23:59:59Z', first=Date.parse('2027-03-22T00:00:00Z');
 assert.equal(schedule(first-1,accepted),null);
 for(let i=0;i<75;i++){
  const start=first+i*86400000;
  assert.equal(schedule(start,accepted).challenge,i%30);
  assert.equal(schedule(start+86399999,accepted).challenge,i%30);
  assert.equal(schedule(start,accepted).week,new Date(first+Math.floor(i/7)*7*86400000).toISOString().slice(0,10));
 }
});
test('best per day, best six, deterministic rotating tie, exclusions and bounded podium',()=>{
 const runs=[];
 for(const player of ['100','20','3','1']) for(let day=0;day<7;day++){
  runs.push({player,day,score:day+10,eligible:true,mode:'ranked'});
 }
 const extra={player:'100',day:0,score:999,eligible:true,mode:'practice'};
 runs.push(extra,{...extra,mode:'ranked',eligible:false},runs[0]);
 const result=standings(runs,'2026-11-23');
 assert.deepEqual(result,standings([...runs].reverse(),'2026-11-23'));
 assert.deepEqual(result.map(r=>[r.total,r.prize]),[[81,100000],[81,50000],[81,25000],[81,0]]);
});
test('perfect weeks reward first-attempt skill before the rotating residual tie',()=>{
 const runs=[];
 for(const id of ['1','900','1000','2000'])for(let day=0;day<6;day++){
  runs.push({player:id,day,slot:1,score:id==='1'?800:1000,eligible:true,mode:'ranked'},
   {player:id,day,slot:2,score:1000,eligible:true,mode:'ranked'});
 }
 const winners=new Set();
 for(let w=0;w<52;w++){
  const week=new Date(Date.UTC(2027,0,4+w*7)).toISOString().slice(0,10);
  const ranked=standings(runs,week);
  assert.equal(ranked[3].player,'1');assert.ok(ranked.every(r=>r.total===6000));
  assert.equal(ranked.reduce((n,r)=>n+r.prize,0),175000);
  assert.deepEqual(ranked,standings([...runs].reverse(),week));winners.add(ranked[0].player);
 }
 assert.equal(winners.size,3);
});
