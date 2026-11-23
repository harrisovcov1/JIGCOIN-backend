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
test('best per day, best six, deterministic numeric tie, exclusions and bounded podium',()=>{
 const runs=[];
 for(const player of ['100','20','3','1']) for(let day=0;day<7;day++){
  runs.push({player,day,score:day+10,eligible:true,mode:'ranked'});
 }
 const extra={player:'100',day:0,score:999,eligible:true,mode:'practice'};
 runs.push(extra,{...extra,mode:'ranked',eligible:false},runs[0]);
 const result=standings(runs);
 assert.deepEqual(result,standings([...runs].reverse()));
 assert.deepEqual(result.map(r=>[r.player,r.total,r.prize]),[['1',81,100000],['3',81,50000],['20',81,25000],['100',81,0]]);
});
