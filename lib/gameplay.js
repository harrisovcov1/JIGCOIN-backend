'use strict';
const {active:vipActive}=require('./vipPolicy');
const fault=(code,status=409)=>Object.assign(Error(code),{code,status});
function createGameplay({pool,withTransaction,applyBalanceChangeTx,getEnergyCap,getMultiplier=()=>1,packetMax=25}){
 function project(input,now=new Date()){
  const user={...input};const day=now.toISOString().slice(0,10);
  const last=user.last_reset instanceof Date?user.last_reset.toISOString().slice(0,10):String(user.last_reset||'').slice(0,10);
  const cap=getEnergyCap(user,now.getTime());
  if(last!==day)return {...user,energy:cap,today_farmed:0,taps_today:0,last_reset:day,last_energy_ts:now};
  let energy=Math.min(cap,Math.max(0,Number(user.energy||0)));
  const stamp=new Date(user.last_energy_ts||now.getTime()-3600000).getTime();
  let elapsed=Math.max(0,Math.floor((now.getTime()-stamp)/1000));const initial=elapsed;
  while(energy<cap){const step=energy<10?1:energy<30?3:6;if(elapsed<step)break;energy++;elapsed-=step;}
  const timestamp=energy>=cap?now:new Date(now.getTime()-(elapsed*1000+Math.max(0,(now.getTime()-stamp)%1000)));
  return {...user,energy,last_energy_ts:energy>=cap?now:initial===elapsed&&user.last_energy_ts?user.last_energy_ts:timestamp};
 }
 async function tap(identity,body){
  const id=body.packet_id,count=body.count;
  if(typeof id!=='string'||!/^[a-zA-Z0-9_-]{8,100}$/.test(id))throw fault('BAD_PACKET_ID',400);
  if(!Number.isSafeInteger(count)||count<1||count>Math.min(100,Math.max(1,packetMax)))throw fault('BAD_COUNT',400);
  return withTransaction(async c=>{
   const current=(await c.query('SELECT *,clock_timestamp() AS db_now FROM public.users WHERE id=$1 FOR UPDATE',[identity.id])).rows[0];
   if(!current)throw fault('USER_NOT_FOUND',404);
   const prior=(await c.query('SELECT requested_count,applied,gained,vip_bonus FROM jigcoin_internal.tap_claims WHERE user_id=$1 AND packet_id=$2',[identity.id,id])).rows[0];
   if(prior){if(prior.requested_count!==count)throw fault('PACKET_CONTENT_MISMATCH');return {user:project(current,new Date(current.db_now)),response:{ok:true,duplicate:true,applied:prior.applied,gained:Number(prior.gained),vip_bonus:Number(prior.vip_bonus)}};}
   if((await c.query('SELECT 1 FROM public.tap_packets WHERE packet_id=$1 AND telegram_id=$2',[id,identity.telegram_id])).rowCount)return {user:project(current,new Date(current.db_now)),response:{ok:true,duplicate:true,applied:0,gained:0,vip_bonus:0}};
   const now=new Date(current.db_now);if(new Date(current.banned_until)>now)throw fault('BANNED',403);
   const fresh=project(current,now),applied=Math.max(0,Math.min(count,Math.floor(fresh.energy)));
   const ad=new Date(fresh.double_boost_until)>now?2:1;
   const mult=Number(getMultiplier(fresh,now.getTime()));
   if(!Number.isFinite(mult)||mult<1||mult>100)throw fault('INVALID_SERVER_MULTIPLIER',503);
   const units=applied*ad*Math.round(mult*10000);
   const carry=Number((await c.query('SELECT units FROM jigcoin_internal.tap_fraction WHERE user_id=$1',[identity.id])).rows[0]?.units||0);
   const base=Math.floor((units+carry)/10000);
   await c.query('INSERT INTO jigcoin_internal.tap_fraction(user_id,units) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET units=EXCLUDED.units',[identity.id,(units+carry)%10000]);
   let bonus=0;
   if(vipActive(fresh,now.getTime())&&applied){
    const extra=Number((await c.query('SELECT fraction_units FROM jigcoin_internal.vip_tap_stats_v11 WHERE user_id=$1',[identity.id])).rows[0]?.fraction_units||0);
    bonus=Math.floor((units+extra)/10000);
    await c.query(`INSERT INTO jigcoin_internal.vip_tap_stats_v11(user_id,bonus_coins,fraction_units) VALUES($1,$2,$3)
     ON CONFLICT(user_id) DO UPDATE SET bonus_coins=vip_tap_stats_v11.bonus_coins+EXCLUDED.bonus_coins,fraction_units=EXCLUDED.fraction_units`,[identity.id,bonus,(units+extra)%10000]);
   }
   if(base)await applyBalanceChangeTx(c,{userId:identity.id,delta:base,reason:'tap_reward',refType:'tap_packet',eventType:'tap'});
   if(bonus)await applyBalanceChangeTx(c,{userId:identity.id,delta:bonus,reason:'vip_tap_bonus_v11',refType:'tap_packet',eventType:'tap'});
   const gained=base+bonus;
   const updated=(await c.query(`UPDATE public.users SET energy=$2,today_farmed=$3,taps_today=$4,last_reset=$5,last_energy_ts=$6,last_tap_at=clock_timestamp() WHERE id=$1 RETURNING *`,[identity.id,fresh.energy-applied,Number(fresh.today_farmed||0)+gained,Number(fresh.taps_today||0)+applied,fresh.last_reset,fresh.last_energy_ts])).rows[0];
   await c.query('INSERT INTO jigcoin_internal.tap_claims(user_id,packet_id,requested_count,applied,gained,vip_bonus) VALUES($1,$2,$3,$4,$5,$6)',[identity.id,id,count,applied,gained,bonus]);
   return {user:updated,response:{ok:true,applied,gained,vip_bonus:bonus}};
  });
 }
 return {project,tap};
}
module.exports={createGameplay};
