'use strict';
// Progress comes only from server-applied tap packets. Cosmetic ownership never
// changes balances, tap multipliers, or airdrop eligibility.
const EVENT_KEY='launch-edition-1', DAILY_TARGET=100, DAILY_REWARD=50;
const fail=(code,status=409)=>{throw Object.assign(new Error(code),{code,status});};
function createProgression({pool,withTransaction,applyBalanceChangeTx,streakMilestones=[]}) {
  async function snapshot(client,identity,lock=false) {
    const {rows}=await client.query(`SELECT *,clock_timestamp() AS db_now
      FROM public.users WHERE id=$1 ${lock?'FOR UPDATE':''}`,[identity.id]);
    const user=rows[0];
    if(!user||String(user.telegram_id)!==String(identity.telegram_id)||user.is_system_user)fail('ACCOUNT_UNAVAILABLE',403);
    const now=new Date(user.db_now),day=now.toISOString().slice(0,10),start=new Date(day+'T00:00:00Z'),end=new Date(+start+86400000);
    const banned=!!user.banned_until&&new Date(user.banned_until)>now;
    const event=(await client.query('SELECT * FROM jigcoin_internal.collectible_events WHERE event_key=$1',[EVENT_KEY])).rows[0];
    const counts=(await client.query(`SELECT
      COALESCE(SUM(applied) FILTER(WHERE created_at >= $2 AND created_at < $3),0) AS daily,
      COALESCE(SUM(applied) FILTER(WHERE created_at >= $4 AND created_at < $5),0) AS launch
      FROM jigcoin_internal.tap_claims WHERE user_id=$1 AND created_at <= $6
      AND ((created_at >= $2 AND created_at < $3) OR (created_at >= $4 AND created_at < $5))`,
      [user.id,start,end,event?.starts_at||null,event?.ends_at||null,now])).rows[0];
    const claims=(await client.query(`SELECT kind,period FROM jigcoin_internal.progression_claims
      WHERE user_id=$1 AND ((kind='daily' AND period=$2) OR (kind='launch' AND period=$3))`,[user.id,day,EVENT_KEY])).rows;
    const claimed=claims.some(x=>x.kind==='daily'),owned=claims.some(x=>x.kind==='launch');
    const live=event?.starts_at&&new Date(event.starts_at)<=now&&new Date(event.ends_at)>now;
    const ended=event?.ends_at&&new Date(event.ends_at)<=now;
    const dailyProgress=Math.min(DAILY_TARGET,Number(counts.daily)),launchProgress=Math.min(event?.target_taps||250,Number(counts.launch));
    return {ok:true,server_now:now.toISOString(),telegram_id:Number(user.telegram_id),
      daily:{day,target:DAILY_TARGET,progress:dailyProgress,reward:DAILY_REWARD,claimed,eligible:!banned&&!claimed&&dailyProgress>=DAILY_TARGET,resets_at:end.toISOString()},
      event:{key:EVENT_KEY,status:live?'live':ended?'ended':'upcoming',starts_at:event?.starts_at||null,ends_at:event?.ends_at||null,
        target:event?.target_taps||250,progress:launchProgress,owned,eligible:!banned&&!owned&&!!event?.starts_at&&launchProgress>=(event.target_taps||250)},
      streak_milestones:streakMilestones,airdrop:{status:'not_announced'}};
  }
  async function status(user){return snapshot(pool,user);}
  async function claim(user,body={}) {
    if(!['daily','launch'].includes(body.kind))fail('INVALID_CHALLENGE',400);
    return withTransaction(async client=>{
      const s=await snapshot(client,user,true),daily=body.kind==='daily';
      if(daily&&body.period!==s.daily.day)fail('CHALLENGE_DAY_CHANGED');
      if(!daily&&body.period!==EVENT_KEY)fail('INVALID_EVENT',400);
      const item=daily?s.daily:s.event,already=daily?item.claimed:item.owned;
      if(already)return {...s,already_claimed:true,reward:0};
      if(!item.eligible)fail('CHALLENGE_NOT_READY');
      const receipt=(await client.query(`INSERT INTO jigcoin_internal.progression_claims(user_id,kind,period,reward_amount)
        VALUES($1,$2,$3,$4) RETURNING id`,[user.id,body.kind,body.period,daily?DAILY_REWARD:0])).rows[0];
      if(daily){
        const credit=await applyBalanceChangeTx(client,{userId:user.id,delta:DAILY_REWARD,reason:'daily_tap_challenge',refType:'progression_claim',refId:receipt.id,eventType:'challenge_reward'});
        await client.query('UPDATE jigcoin_internal.progression_claims SET ledger_id=$1 WHERE id=$2',[credit.ledgerId,receipt.id]);
      }
      return {...await snapshot(client,user),already_claimed:false,reward:daily?DAILY_REWARD:0};
    });
  }
  return {status,claim};
}
module.exports={createProgression,EVENT_KEY,DAILY_TARGET,DAILY_REWARD};
