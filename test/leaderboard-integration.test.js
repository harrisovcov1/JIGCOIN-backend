'use strict';
const {test,before,after,beforeEach}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {Pool}=require('pg');
const {createLeaderboards}=require('../lib/leaderboards');
const port=Number(process.env.JIGCOIN_TEST_POSTGRES_PORT);
const integration=port?test:test.skip;
let admin,pool,boards,today,yesterday;
const database='jigcoin_leaderboard_v16_test_'+process.pid;
before(async()=>{
 if(!port)return;
 const options={host:'127.0.0.1',port,user:process.env.USER||'agent',ssl:false};
 admin=new Pool({...options,database:'postgres'});
 await admin.query('CREATE DATABASE '+database);
 pool=new Pool({...options,database});
 await pool.query(`CREATE SCHEMA jigcoin_internal;
 CREATE TABLE public.users(id bigint PRIMARY KEY,telegram_id bigint UNIQUE NOT NULL,
  username text,first_name text,balance bigint NOT NULL DEFAULT 0,is_system_user boolean DEFAULT false,
  banned_until timestamptz,last_reset date,today_farmed bigint DEFAULT 0);
 CREATE TABLE public.referrals(inviter_id bigint NOT NULL,invited_id bigint NOT NULL);
 CREATE TABLE jigcoin_internal.leaderboard_config_v12(singleton boolean PRIMARY KEY DEFAULT true,
  installed_at timestamptz NOT NULL DEFAULT clock_timestamp()-interval '4 days',
  award_start_day date NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date-3);
 INSERT INTO jigcoin_internal.leaderboard_config_v12(singleton) VALUES(true);
 CREATE TABLE jigcoin_internal.leaderboard_days_v12(day date PRIMARY KEY,finalized_at timestamptz,participant_count integer);
 CREATE TABLE jigcoin_internal.leaderboard_scores_v12(day date NOT NULL,user_id bigint NOT NULL REFERENCES public.users(id),
  score bigint NOT NULL,updated_at timestamptz DEFAULT clock_timestamp(),PRIMARY KEY(day,user_id));
 CREATE TABLE jigcoin_internal.leaderboard_awards_v12(day date NOT NULL,place smallint NOT NULL,
  user_id bigint NOT NULL REFERENCES public.users(id),score bigint NOT NULL,display_name text NOT NULL,
  awarded_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(day,place),UNIQUE(day,user_id));`);
 await pool.query(fs.readFileSync(path.join(__dirname,'fixtures/leaderboard-v12-runtime.sql'),'utf8'));
 await pool.query(`CREATE TRIGGER users_daily_score_v12 AFTER UPDATE ON public.users
 FOR EACH ROW EXECUTE FUNCTION jigcoin_internal.capture_daily_score_v12()`);
 const {rows:[dates]}=await pool.query("SELECT (now() AT TIME ZONE 'UTC')::date::text today,((now() AT TIME ZONE 'UTC')::date-1)::text yesterday");
 ({today,yesterday}=dates);
});
after(async()=>{if(pool)await pool.end();if(admin){await admin.query('DROP DATABASE '+database);await admin.end();}});
beforeEach(async()=>{
 if(!pool)return;
 await pool.query(`TRUNCATE jigcoin_internal.leaderboard_awards_v12,jigcoin_internal.leaderboard_scores_v12,
  jigcoin_internal.leaderboard_days_v12,public.referrals,public.users CASCADE`);
 // In these focused tests the finalizer is explicit, avoiding background races.
 boards=createLeaderboards({pool,logger:{error(){}}});
 await boards.finalizeDue(true);
});
async function players(count=4){
 await pool.query("INSERT INTO public.users(id,telegram_id,username,balance,last_reset) SELECT n,n+1000,'Player '||n,1000,$2::date FROM generate_series(1,$1::integer)n",[count,today]);
 return (await pool.query('SELECT * FROM public.users ORDER BY id')).rows;
}
async function score(id,value,day=today){await pool.query('UPDATE public.users SET last_reset=$2,today_farmed=$3 WHERE id=$1',[id,day,value]);}

integration('one scored player and 142 global accounts are truthful separate populations',async()=>{
 const [me]=await players(142);await score(me.id,2022);await boards.assertReady();
 const daily=await boards.board(me,'daily');const global=await boards.board(me,'global');
 assert.equal(daily.total,1);assert.equal(global.total,142);
 assert.equal(daily.me.rank,1);assert.equal(daily.me.score,2022);assert.equal(daily.podium.length,1);
 assert.equal(daily.overtake,null);assert.equal(daily.gap_below,null);
});
integration('balance credits affect Global but never manufacture daily tap coins',async()=>{
 const [me,rival]=await players(2);await score(me.id,21);await score(rival.id,25);
 await pool.query('UPDATE public.users SET balance=balance+7000 WHERE id=$1',[me.id]);
 const daily=await boards.board(me,'daily');const global=await boards.board(me,'global');
 assert.equal(daily.me.score,21);assert.equal(daily.me.rank,2);assert.equal(daily.overtake.need_points,5);
 assert.equal(global.me.score,8000);assert.equal(global.me.rank,1);
 await score(me.id,42);
 assert.equal((await boards.board(me,'daily')).me.score,42);
});
integration('eligible rivals use exact ordinal ties and only actual referral connections',async()=>{
 const [me,rival]=await players(6);
 await pool.query(`UPDATE public.users SET balance=CASE id WHEN 1 THEN 2000 WHEN 2 THEN 2000 ELSE 9000 END,
  is_system_user=(id=3),banned_until=CASE WHEN id=4 THEN now()+interval '1 day' ELSE NULL END;
  INSERT INTO public.referrals VALUES(1001,1002);`);
 const global=await boards.board(rival,'global');
 assert.equal(global.total,4);assert.equal(global.me.rank,4);assert.equal(global.overtake.need_points,1);
 const friends=await boards.board(me,'friends');
 assert.equal(friends.total,2);assert.deepEqual(friends.entries.map(r=>r.telegram_id),[1001,1002]);
 await assert.rejects(()=>boards.board(me,'global',{page:-1}),{code:'BAD_PAGE'});
});
integration('finalized daily awards exclude ineligible accounts and retain recorded names and scores',async()=>{
 const people=await players(5);
 await pool.query("UPDATE public.users SET is_system_user=(id=4),banned_until=CASE WHEN id=5 THEN now()+interval '1 day' ELSE NULL END");
 for(const u of people)await score(u.id,u.id<=3?100:9999,yesterday);
 const finalize=()=>pool.query('SELECT jigcoin_internal.finalize_daily_race_v12($1::date) AS applied',[yesterday]);
 const completed=await Promise.all([finalize(),finalize()]);
 assert.equal(completed.filter(r=>r.rows[0].applied).length,1);
 assert.equal((await pool.query('SELECT participant_count FROM jigcoin_internal.leaderboard_days_v12 WHERE day=$1',[yesterday])).rows[0].participant_count,3);
 await pool.query("UPDATE public.users SET username='Changed name',balance=700000 WHERE id=1");
 const history=await boards.history(people[0]);
 assert.deepEqual(history.podiums.map(r=>r.telegram_id),['1001','1002','1003']);
 assert.equal(history.podiums[0].display_name,'Player 1');assert.equal(history.podiums[0].score,100);
 assert.deepEqual(history.my_awards,[{day:yesterday,place:1,score:100}]);
});
integration('closed days reject late scores and a retry on the current day records correctly',async()=>{
 const [me]=await players(1);await score(me.id,50,yesterday);
 await pool.query('SELECT jigcoin_internal.finalize_daily_race_v12($1::date)',[yesterday]);
 await assert.rejects(()=>score(me.id,51,yesterday),/DAILY_RACE_CLOSED/);
 await score(me.id,1,today);
 const current=await boards.board(me,'daily');assert.equal(current.me.score,1);
 assert.equal((await boards.history(me)).my_awards[0].score,50);
});
