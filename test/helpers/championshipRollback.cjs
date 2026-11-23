// Load the actual former release from Git history, anchored to this checkout
// so unchanged dependency modules resolve normally. Run on disposable DB only.
const fs=require('node:fs');
const path=require('node:path');
const Module=require('node:module');
const {execFileSync}=require('node:child_process');
const assert=require('node:assert/strict');
const legacy='bbf3963145b8e066ca3f2e994255a25cf2ec2952';
function oldModule(file){
 const m=new Module(path.resolve(file),module);
 m.filename=path.resolve(file);m.paths=module.paths;
 m._compile(execFileSync('git',['show',legacy+':'+file],{encoding:'utf8'}),m.filename);
 return m.exports;
}
async function setupLegacy(db){
 const sql=p=>db.query(fs.readFileSync(p,'utf8'));
 await sql('test/fixtures/championship-legacy-tables.sql');
 await sql('test/fixtures/leaderboard-v12-runtime.sql');
 for(const role of ['anon','authenticated','service_role']){
  await db.query(`DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='${role}') THEN CREATE ROLE ${role}; END IF; END $$`);
 }
 for(const m of ['024_revenue_pilot','025_mint_race_cards','20261119172851_weekly_daily_runs_and_awards'])
  await sql('sql/migrations/'+m+'.sql');
}
async function rehearseRollback(db,withTransaction){
 const {rows:[{first_week:start}]}=await db.query('SELECT first_week::text FROM jigcoin_internal.championship_legacy_cutoff');
 await db.query("update jigcoin_internal.leaderboard_config_v12 set award_start_day=$1::date-7",[start]);
 for(const offset of [-1,0,1]){
  await db.query('INSERT INTO jigcoin_internal.leaderboard_days_v12(day) VALUES ($1::date+$2::int)',[start,offset]);
  await db.query('INSERT INTO jigcoin_internal.leaderboard_scores_v12(day,user_id,score) VALUES($1::date+$2::int,2,100)',[start,offset]);
 }
 for(const offset of [-7,0]){
  await db.query("INSERT INTO jigcoin_internal.weekly_racers_v14(week,user_id,share_code,best) VALUES ($1::date+$2::int,2,substr(md5($2::text),1,20),20)",[start,offset]);
 }
 const snapshot=()=>db.query(`SELECT
 (SELECT jsonb_agg(to_jsonb(t) ORDER BY week,place) FROM jigcoin_internal.championship_trophies t) trophies,
 (SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM public.user_balance_ledger l) ledger,
 (SELECT jsonb_agg(balance ORDER BY id) FROM public.users) balances`).then(x=>x.rows);
 const before=await snapshot();
 const {createLeaderboards}=oldModule('lib/leaderboards.js');
 const {createWeeklyRace}=oldModule('lib/weeklyRace.js');
 const oldFlag=process.env.CHAMPIONSHIP_V2;delete process.env.CHAMPIONSHIP_V2;
 try{
  for(let restart=0;restart<2;restart++){
   await createLeaderboards({pool:db}).finalizeDue(true);
   await createWeeklyRace({pool:db,withTransaction,env:{}}).finalizeDue({force:true,now:new Date(Date.parse(start)+14*86400000)});
  }
 }finally{if(oldFlag!==undefined)process.env.CHAMPIONSHIP_V2=oldFlag;}
 for(const [table,col] of [['leaderboard_awards_v12','day'],['weekly_awards_v16','week']]){
  assert.deepEqual((await db.query(`SELECT count(*) FILTER (WHERE ${col}<$1)::int old,count(*) FILTER (WHERE ${col}>=$1)::int blocked FROM jigcoin_internal.${table}`,[start])).rows,[{old:2,blocked:0}]);
 }
 assert.deepEqual(await snapshot(),before);
 console.log('PASS restored actual pre-v2 daily and weekly workers twice, historical periods still awarded, no post-cutover legacy medals; v2 trophies, ledger and balances matched');
}
module.exports={setupLegacy,rehearseRollback};
