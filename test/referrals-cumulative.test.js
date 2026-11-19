'use strict';
const {test,before,after,beforeEach}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {Pool}=require('pg');
const {createReferralCredit}=require('../lib/referralCredit');
const {createInvite}=require('../lib/invite');
const {createGameplay}=require('../lib/gameplay');
const {ACTIVATION_VERSION,nextReward}=require('../lib/referralPolicy');

// Never reads DATABASE_URL. This suite owns a new disposable loopback database.
const port=Number(process.env.JIGCOIN_TEST_POSTGRES_PORT||0),run=port?test:test.skip;
const db='jigcoin_referrals_test_'+process.pid;
let admin,pool,service,invite,game,owner,sequence=0;
const migration=fs.readFileSync(path.join(__dirname,'../sql/migrations/20261119172826_referral_cumulative_activation.sql'),'utf8');
async function transaction(fn){const c=await pool.connect();try{await c.query('BEGIN');const r=await fn(c);await c.query('COMMIT');return r;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
const createService=extra=>createReferralCredit({pool,withTransaction:transaction,logger:{error(){}},...extra});
const saved=id=>pool.query('SELECT * FROM public.users WHERE id=$1',[id]).then(r=>r.rows[0]);
const newFriend=(param=`ref_${owner.telegram_id}`)=>service.register({id:20000+(++sequence),first_name:'Friend '+sequence,last_name:'Private surname'},param);
async function tap(user,count,packet='referral_test_'+(++sequence)){
  return game.tap(user,{packet_id:packet,count});
}
async function refill(user){await pool.query('UPDATE public.users SET energy=55,last_energy_ts=clock_timestamp() WHERE id=$1',[user.id]);}
async function reach(user,count=100){for(let left=count;left>0;left-=Math.min(25,left)){await refill(user);await tap(user,Math.min(25,left));}}
async function awardCount(){return Number((await pool.query("SELECT count(*) AS n FROM public.user_balance_ledger WHERE reason='referral_reward'")).rows[0].n);}
async function enrollLegacy(user,version=10,required=false,minTaps=150){
  const r=(await pool.query(`INSERT INTO public.referrals(inviter_id,invited_id,inviter_user_id,invitee_user_id,status)
    VALUES($1,$2,$3,$4,'pending') RETURNING id`,[owner.telegram_id,user.telegram_id,owner.id,user.id])).rows[0];
  await pool.query(`INSERT INTO jigcoin_internal.referral_credits_v${version}(referral_id,inviter_user_id,invitee_user_id,activation_required,min_taps)
    VALUES($1,$2,$3,$4,$5)`,[r.id,owner.id,user.id,required,minTaps]);
  return r.id;
}
before(async()=>{
  if(!port)return;
  const connection={host:'127.0.0.1',port,user:process.env.USER||'agent',ssl:false};
  admin=new Pool({...connection,database:'postgres'});await admin.query(`CREATE DATABASE ${db}`);
  pool=new Pool({...connection,database:db,max:16});
  await pool.query(`DO $$ BEGIN PERFORM pg_advisory_xact_lock(14142025);
    IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF; END $$;`);
  await pool.query(fs.readFileSync(path.join(__dirname,'helpers/referral-fixture.sql'),'utf8'));
  await pool.query(migration);await pool.query(migration);
});
beforeEach(async()=>{
  if(!port)return;
  await pool.query('TRUNCATE public.users RESTART IDENTITY CASCADE');
  await pool.query('TRUNCATE public.tap_packets');sequence=0;
  service=createService();invite=createInvite({pool,botUsername:'JIGCOINBOT'});
  owner=await service.register({id:10001,first_name:'Inviter'});
  game=createGameplay({pool,withTransaction:transaction,getEnergyCap:u=>u.max_energy,getMultiplier:()=>1,
    applyBalanceChangeTx:async(c,{userId,delta,reason,refType,eventType})=>{
      await c.query('INSERT INTO public.user_balance_ledger(user_id,delta,reason,ref_type,event_type) VALUES($1,$2,$3,$4,$5)',[userId,delta,reason,refType,eventType]);
      await c.query('UPDATE public.users SET balance=balance+$2 WHERE id=$1',[userId,delta]);
    }});
});
after(async()=>{if(pool)await pool.end();if(admin){await admin.query(`DROP DATABASE IF EXISTS ${db}`);await admin.end();}});

test('reward bands apply to the milestone invite itself',()=>{
  for(const [count,reward] of [[0,500],[3,500],[4,1000],[18,1000],[19,1250],[48,1250],[49,1500],[198,1500],[199,2000],[1000,2000]])assert.equal(nextReward(count),reward);
});
run('v16 installs additively, stays private and passes referral readiness',async()=>{
  await service.assertReady();
  const security=(await pool.query(`SELECT c.relrowsecurity,
    has_table_privilege('anon','jigcoin_internal.referral_credits_v16','SELECT,INSERT,UPDATE,DELETE') AS anon_access,
    has_table_privilege('authenticated','jigcoin_internal.referral_credits_v16','SELECT,INSERT,UPDATE,DELETE') AS authenticated_access
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='jigcoin_internal' AND c.relname='referral_credits_v16'`)).rows[0];
  assert.deepEqual(security,{relrowsecurity:true,anon_access:false,authenticated_access:false});
});
run('welcome1000 remains general and unique; new referrals never award merely for joining',async()=>{
  const friend=await newFriend();await service.settle(friend);
  const organic=await newFriend('');
  assert.equal(Number(friend.balance),1000);assert.equal(Number(organic.balance),1000);
  assert.equal(await awardCount(),0);
  const repeat=await service.register({id:friend.telegram_id},`ref_${owner.telegram_id}`);
  assert.equal(Number(repeat.balance),1000);
  assert.equal(Number((await pool.query('SELECT count(*) AS n FROM jigcoin_internal.welcome_credits_v10 WHERE user_id=$1',[friend.id])).rows[0].n),1);
  assert.equal((await pool.query('SELECT policy_version,min_taps FROM jigcoin_internal.referral_credits_v16')).rows[0].policy_version,ACTIVATION_VERSION);
});
run('100 verified taps accumulate across UTC days and sessions;99 never awards and replay never increases progress',async()=>{
  const friend=await newFriend();
  await tap(friend,25);await tap(friend,25);await service.settle(friend);
  await pool.query("UPDATE jigcoin_internal.tap_claims SET created_at=created_at-interval '1 day' WHERE user_id=$1",[friend.id]);
  await pool.query("UPDATE public.users SET last_reset=CURRENT_DATE-1 WHERE id=$1",[friend.id]);
  await tap(friend,25);const ninetyNine=await tap(friend,24,'repeatable_packet');await service.settle(friend);
  assert.equal(Number(ninetyNine.user.taps_today),49);assert.equal(await awardCount(),0);
  assert.equal((await invite.summary(owner)).friend_progress[0].verified_taps,99);
  const repeated=await tap(friend,24,'repeatable_packet');assert.equal(repeated.response.duplicate,true);
  assert.equal((await invite.summary(owner)).friend_progress[0].verified_taps,99);
  await tap(friend,1);await service.settle(friend);
  const claim=(await pool.query('SELECT * FROM jigcoin_internal.referral_credits_v16')).rows[0];
  assert.equal(claim.verified_taps,100);assert.ok(claim.qualified_at);assert.ok(claim.awarded_at);
  assert.equal(claim.inviter_reward,500);assert.equal(await awardCount(),1);
});
run('only applied taps qualify; requested counts, client totals, purchases and confirmed ads do not',async()=>{
  const friend=await newFriend();
  await pool.query('UPDATE public.users SET energy=1,taps_today=99999,balance=999999,vip_until=clock_timestamp()+interval\'30 days\' WHERE id=$1',[friend.id]);
  const r=await tap(friend,25);assert.equal(r.response.applied,1);
  await pool.query('INSERT INTO jigcoin_internal.ad_attempts(user_id,eligible_at,claimed_at) VALUES($1,clock_timestamp(),clock_timestamp())',[friend.id]);
  await service.settle(friend);
  const data=await invite.summary(owner);assert.equal(data.friend_progress[0].verified_taps,1);assert.equal(await awardCount(),0);
  assert.deepEqual(data.qualification,{mode:'cumulative_taps',min_taps:100,period:'lifetime',ad_qualifies:false,purchase_required:false});
});
run('simultaneous qualification and retries award the inviter exactly once',async()=>{
  const friend=await newFriend();await reach(friend);
  await Promise.all(Array.from({length:12},()=>service.activate(friend)));
  assert.equal(await awardCount(),1);
  const current=await saved(owner.id);assert.equal(Number(current.balance),1500);assert.equal(Number(current.referrals_count),1);assert.equal(Number(current.referrals_points),500);
  assert.equal(Number((await saved(friend.id)).balance),1100);
});
run('concurrent fourth-to-fifth boundary uses one serialized inviter ordinal per reward',async()=>{
  await pool.query('UPDATE public.users SET referrals_count=3,referrals=3,referrals_points=1500,balance=2500 WHERE id=$1',[owner.id]);
  const first=await newFriend(),second=await newFriend();await reach(first);await reach(second);
  await Promise.all([service.activate(first),service.activate(second)]);
  const rows=(await pool.query('SELECT referral_ordinal,inviter_reward FROM jigcoin_internal.referral_credits_v16 ORDER BY referral_ordinal')).rows;
  assert.deepEqual(rows,[{referral_ordinal:4,inviter_reward:500},{referral_ordinal:5,inviter_reward:1000}]);
  assert.equal(Number((await saved(owner.id)).referrals_count),5);
});
run('failed award rolls back every credit and retries successfully from saved taps',async()=>{
  const friend=await newFriend();await reach(friend);
  const broken=createService({withTransaction:fn=>transaction(c=>fn({query:(sql,args)=>{
    if(sql.includes('INSERT INTO public.sponsor_ledger'))throw Object.assign(Error('test failure'),{code:'TEST_AUDIT_FAILURE'});
    return c.query(sql,args);
  }}))});
  await broken.settle(friend);assert.equal(await awardCount(),0);assert.equal(Number((await saved(owner.id)).balance),1000);
  assert.equal(Number((await saved(friend.id)).balance),1100);
  await service.settle(friend);assert.equal(await awardCount(),1);
});
run('legacy v10 join, daily taps, and ad contracts retain their original qualification',async()=>{
  const joined=await newFriend('');await enrollLegacy(joined,10,false);await service.activate(joined);assert.equal(await awardCount(),1);
  const strict=await newFriend('');await enrollLegacy(strict,10,true,150);await reach(strict,100);
  await service.activate(strict);assert.equal(await awardCount(),1);
  await pool.query('UPDATE public.users SET taps_today=149 WHERE id=$1',[strict.id]);await service.activate(strict);assert.equal(await awardCount(),1);
  await pool.query('UPDATE public.users SET taps_today=150 WHERE id=$1',[strict.id]);await service.activate(strict);assert.equal(await awardCount(),2);
  const ad=await newFriend('');await enrollLegacy(ad,10,true,150);
  await pool.query('INSERT INTO jigcoin_internal.ad_attempts(user_id,eligible_at,claimed_at) VALUES($1,clock_timestamp(),clock_timestamp())',[ad.id]);
  await service.activate(ad);assert.equal(await awardCount(),3);
  assert.deepEqual((await pool.query('SELECT qualification FROM jigcoin_internal.referral_credits_v10 ORDER BY referral_id')).rows.map(r=>r.qualification),['join','taps','confirmed_ad']);
});
run('legacy v9 preserves its inviter rate and additional friend reward exactly once',async()=>{
  const friend=await newFriend('');await enrollLegacy(friend,9,false);
  await Promise.all(Array.from({length:5},()=>service.activate(friend)));
  assert.equal(await awardCount(),1);assert.equal(Number((await saved(owner.id)).balance),1800);
  assert.equal(Number((await saved(friend.id)).balance),1800);
});
run('self, malformed, nonexistent and reassigned attribution cannot create a referral',async()=>{
  const invalid=['ref_0','ref_-1','ref_10001_bad','ref_99999999999999999999999','ref_888888',{ref:'10001'}];
  for(const payload of invalid)await newFriend(payload);
  await service.register({id:77777},'ref_77777');
  const organic=await newFriend('');await service.register({id:organic.telegram_id},`ref_${owner.telegram_id}`);
  assert.equal(Number((await pool.query('SELECT count(*) AS n FROM public.referrals')).rows[0].n),0);
  const raced=await newFriend(`ref_${owner.telegram_id}__src_race_123abc`);
  assert.equal(String(raced.referred_by),String(owner.telegram_id));
});
run('summary and history are account scoped, stateful, bounded and do not expose friend Telegram IDs',async()=>{
  const joined=await newFriend(),playing=await newFriend(),qualified=await newFriend(),rewarded=await newFriend(),held=await newFriend();
  await reach(playing,25);await reach(qualified);await reach(rewarded);await service.activate(rewarded);
  await pool.query('UPDATE public.users SET banned_until=clock_timestamp()+interval\'1 day\' WHERE id=$1',[held.id]);
  const other=await newFriend('');await newFriend(`ref_${other.telegram_id}`);
  const data=await invite.summary(owner);
  assert.equal(data.friends_joined,5);assert.equal(data.friends_pending,2);assert.equal(data.friends_qualified,2);assert.equal(data.friends_rewarded,1);assert.equal(data.friends_on_hold,1);
  assert.deepEqual(new Set(data.friend_progress.map(r=>r.status)),new Set(['joined','playing','qualified','rewarded','on_hold']));
  assert.ok(data.friend_progress.every(r=>!('telegram_id' in r)&&!('last_name' in r)&&!('invite_link' in r)));
  assert.ok(!JSON.stringify(data).includes('Private surname'));
  assert.equal((await invite.summary(other)).friends_joined,1);
  assert.equal((await invite.history(owner)).credits.length,1);assert.equal((await invite.history(other)).credits.length,0);
  await assert.rejects(invite.summary({...owner,telegram_id:other.telegram_id}),{status:401});
  await assert.rejects(invite.history({...owner,telegram_id:other.telegram_id}),{status:401});
  for(let n=0;n<20;n++)await newFriend();
  const bounded=await invite.summary(owner);assert.equal(bounded.friend_progress.length,20);assert.equal(bounded.friends_joined,25);assert.equal(bounded.friend_progress_has_more,true);
});
run('legacy rows expose their preserved rule and unknown unpaid historical records are not guessed paid',async()=>{
  const join=await newFriend(''),daily=await newFriend(''),unknown=await newFriend('');
  await enrollLegacy(join,10,false);await enrollLegacy(daily,9,true,150);
  await pool.query('INSERT INTO public.referrals(inviter_id,invited_id,inviter_user_id,invitee_user_id) VALUES($1,$2,$3,$4)',[owner.telegram_id,unknown.telegram_id,owner.id,unknown.id]);
  const data=await invite.summary(owner),modes=data.friend_progress.map(r=>r.qualification_mode);
  assert.deepEqual(new Set(modes),new Set(['join','daily_taps_or_ad','legacy_unknown']));
  assert.equal(data.friend_progress.find(r=>r.qualification_mode==='legacy_unknown').status,'on_hold');
  await service.activate(unknown);assert.equal(await awardCount(),0);
});
run('incoming invitation identifies only the actual inviter and tracks personal cumulative play separately from outgoing friends',async()=>{
  assert.equal((await invite.summary(owner)).incoming_referral,null);
  const friend=await newFriend();
  const child=await newFriend(`ref_${friend.telegram_id}`);
  let data=await invite.summary(friend),incoming=data.incoming_referral;
  assert.equal(incoming.display_name,'Inviter');
  assert.equal(incoming.policy_version,ACTIVATION_VERSION);assert.equal(incoming.qualification_mode,'cumulative_taps');
  assert.equal(incoming.status,'joined');assert.equal(incoming.verified_taps,0);assert.equal(incoming.min_taps,100);
  assert.equal(incoming.reward_coins,null);assert.equal(incoming.rewarded_at,null);
  assert.equal(data.friends_joined,1);assert.equal(data.friend_progress[0].display_name,child.first_name);
  assert.equal((await invite.summary(child)).incoming_referral.display_name,friend.first_name);
  await reach(friend,40);
  incoming=(await invite.summary(friend)).incoming_referral;
  assert.equal(incoming.status,'playing');assert.equal(incoming.verified_taps,40);
  await reach(friend,60);
  incoming=(await invite.summary(friend)).incoming_referral;
  assert.equal(incoming.status,'qualified');assert.equal(incoming.verified_taps,100);assert.equal(incoming.reward_coins,null);
  await service.activate(friend);
  incoming=(await invite.summary(friend)).incoming_referral;
  assert.equal(incoming.status,'rewarded');assert.equal(incoming.reward_coins,500);assert.ok(incoming.rewarded_at);
  assert.deepEqual(Object.keys(incoming).sort(),['display_name','status','policy_version','qualification_mode',
    'verified_taps','min_taps','joined_at','rewarded_at','reward_coins'].sort());
  assert.equal(Number((await saved(friend.id)).balance),1100); // welcome + taps, no extra friend credit
});
run('incoming invitation preserves legacy rules and never turns a held or unknown contract into a 100-tap promise',async()=>{
  const join=await newFriend(''),daily=await newFriend(''),unknown=await newFriend('');
  await enrollLegacy(join,10,false);await enrollLegacy(daily,9,true,150);
  let incoming=(await invite.summary(join)).incoming_referral;
  assert.equal(incoming.qualification_mode,'join');assert.equal(incoming.min_taps,null);assert.equal(incoming.status,'qualified');
  await pool.query('UPDATE public.users SET taps_today=60 WHERE id=$1',[daily.id]);
  incoming=(await invite.summary(daily)).incoming_referral;
  assert.equal(incoming.policy_version,'referral_credit_v9');assert.equal(incoming.qualification_mode,'daily_taps_or_ad');
  assert.equal(incoming.min_taps,150);assert.equal(incoming.verified_taps,60);assert.equal(incoming.status,'playing');
  await pool.query('INSERT INTO public.referrals(inviter_id,invited_id,inviter_user_id,invitee_user_id) VALUES($1,$2,$3,$4)',
    [owner.telegram_id,unknown.telegram_id,owner.id,unknown.id]);
  incoming=(await invite.summary(unknown)).incoming_referral;
  assert.equal(incoming.qualification_mode,'legacy_unknown');assert.equal(incoming.min_taps,null);assert.equal(incoming.status,'on_hold');
  const held=await newFriend();await reach(held,100);
  await pool.query('UPDATE public.users SET banned_until=clock_timestamp()+interval\'1 day\' WHERE id=$1',[owner.id]);
  incoming=(await invite.summary(held)).incoming_referral;
  assert.equal(incoming.status,'on_hold');assert.equal(incoming.reward_coins,null);
});
run('database constraints reject partial qualification and partial/mispriced awards',async()=>{
  const friend=await newFriend();
  await assert.rejects(pool.query('UPDATE jigcoin_internal.referral_credits_v16 SET verified_taps=100 WHERE invitee_user_id=$1',[friend.id]),{code:'23514'});
  await assert.rejects(pool.query('UPDATE jigcoin_internal.referral_credits_v16 SET awarded_at=clock_timestamp() WHERE invitee_user_id=$1',[friend.id]),{code:'23514'});
  await reach(friend);await service.activate(friend);
  await assert.rejects(pool.query('UPDATE jigcoin_internal.referral_credits_v16 SET inviter_reward=2000 WHERE invitee_user_id=$1',[friend.id]),{code:'23514'});
});
