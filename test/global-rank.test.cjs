'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {execFileSync}=require('node:child_process');
const text=fs.readFileSync(path.join(__dirname,'../index.js'),'utf8');
const {createLeaderboards}=require('../lib/leaderboards');
const {createGameplay}=require('../lib/gameplay');
const {benefits:vipBenefits}=require('../lib/vipPolicy');
const fn=text.slice(text.indexOf('async function getGlobalRankForUser(user)'),text.indexOf('// ------------ Build state for frontend'));
// Execute the shipped portable SELECT with an isolated SQLite window-function
// fixture. This checks ordering/data behavior; it does not claim a live PG test.
const python=`import sqlite3,json,sys
x=json.load(sys.stdin)
db=sqlite3.connect(':memory:')
db.execute("ATTACH DATABASE ':memory:' AS public")
db.execute("CREATE TABLE public.users(id INTEGER PRIMARY KEY,telegram_id INTEGER NOT NULL UNIQUE,balance NUMERIC NOT NULL,is_system_user BOOLEAN DEFAULT 0,banned_until TEXT,energy INTEGER DEFAULT 43,max_energy INTEGER DEFAULT 50,last_reset TEXT DEFAULT '2026-11-19',last_energy_ts TEXT DEFAULT '2026-11-19T10:00:00.000Z',today_farmed INTEGER DEFAULT 209)")
db.executemany('INSERT INTO public.users(id,telegram_id,balance) VALUES (?,?,?)',x['users'])
# SQLite does not implement PostgreSQL's EXTRACT or ::bigint cast. Supply
# the clock value alone; keep the window ordering and account join verbatim.
sql=x['sql'].replace('(EXTRACT(EPOCH FROM statement_timestamp()) * 1000000)::bigint','1795082400000000')
db.row_factory=sqlite3.Row
cur=db.execute(sql,{'1':x['args'][0]})
print(json.dumps({'rows':[dict(zip([c[0] for c in cur.description],r)) for r in cur.fetchall()]}))
`;
function fixture(users){
 let calls=0;
 const c={BOT_USERNAME:'fixture_bot',powerups:{getActivePowerupsForUser:async()=>[]},utcDayString:d=>d.toISOString().slice(0,10),getStreakMetaFromUser:()=>({active:true}),getEffectiveMaxEnergy:()=>50,pool:{async query(sql,args){calls++;assert.match(sql.trim(),/^SELECT/);return JSON.parse(execFileSync('python',['-c',python],{input:JSON.stringify({sql,args,users}),encoding:'utf8'}));}}};
 c.leaderboards = createLeaderboards({pool:c.pool});
 c.journey = {status:async()=>({})};
 c.gameplay = createGameplay({getEnergyCap:c.getEffectiveMaxEnergy});
 c.vipBenefits = vipBenefits;
 vm.createContext(c);vm.runInContext(fn+'\n'+text.slice(text.indexOf('async function buildClientState('),text.indexOf('// ------------ NEW: generic reward helpers')),c);return {rank:c.getGlobalRankForUser,state:c.buildClientState,calls:()=>calls};
}
test('equal balances use the exact ordinal position shown by the global leaderboard',async()=>{
 const users=[[91,900,200],[24,700,200],[53,800,200],[12,100,300],[3,400,0]];
 const f=fixture(users);
 for(const [id,position] of [[12,1],[24,2],[53,3],[91,4],[3,5]]){
  const r=await f.rank({id,balance:999999});assert.equal(r.rank,position);assert.equal(r.total,5);
 }
 assert.equal(f.calls(),5,'one snapshot query for each rank');
});
test('rank ignores an outdated caller balance and reflects the saved table balance',async()=>{
 const f=fixture([[1,100,100],[2,200,300],[3,300,200]]);
 assert.equal((await f.rank({id:1,balance:100000})).rank,3);
 assert.equal((await f.rank({id:2,balance:0})).rank,1);
});
test('one player and a missing account never fabricate a position',async()=>{
 const f=fixture([[1,100,0]]);assert.equal((await f.rank({id:1})).rank,1);
 const r=await f.rank({id:999});assert.equal(r.rank,null);assert.equal(r.total,0);
});

test('the actual client-state builder returns matching balance and ordinal rank without writing in recovery',async()=>{
 const f=fixture([[1,100,11003],[2,200,11003],[3,300,9000]]);
 const state=await f.state({id:2,telegram_id:200,balance:'11003',energy:43,today_farmed:209,streak_count:2},{readOnly:true});
 assert.equal(state.balance,11003);assert.equal(state.energy,43);assert.equal(state.today,209);assert.equal(state.energy_clock.elapsed_ms,0);assert.equal(state.energy_clock.sampled_us,1795082400000000);
 assert.equal(state.global_rank,2);assert.equal(state.global_total,3);assert.equal(f.calls(),1);
});

test('state uses the same saved balance snapshot as its global position',async()=>{
 const f=fixture([[1,100,11203],[2,200,11003]]);
 const state=await f.state({id:1,telegram_id:100,balance:'11003'},{readOnly:true});
 assert.equal(state.balance,11203);assert.equal(state.global_rank,1);
});
