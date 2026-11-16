"use strict";
const fault = (code, status=409) => Object.assign(new Error(code), {code,status});
function createGameplay({ pool, withTransaction, applyBalanceChangeTx, getEnergyCap,
  getMultiplier=()=>1, packetMax=25 }) {
  function project(input, now=new Date()) {
    const user={...input};
    const day=now.toISOString().slice(0,10);
    const last=user.last_reset instanceof Date ? user.last_reset.toISOString().slice(0,10) : String(user.last_reset || "").slice(0,10);
    const cap=getEnergyCap(user);
    if (last!==day) return {...user, energy:cap, today_farmed:0, taps_today:0, last_reset:day, last_energy_ts:now};
    let energy=Math.min(cap,Math.max(0,Number(user.energy || 0)));
    let elapsed=Math.max(0,Math.floor((now-new Date(user.last_energy_ts || now.getTime()-3600000))/1000));
    const initial=elapsed;
    // Match the established 1/3/6-second regeneration tiers. Preserve unused
    // fractional time; polling must not postpone the next energy point.
    while (energy<cap) { const step=energy<10?1:energy<30?3:6; if (elapsed<step) break; energy++; elapsed-=step; }
    const timestamp=energy>=cap ? now : new Date(now.getTime()-(elapsed*1000+((now-new Date(user.last_energy_ts || now))%1000 || 0)));
    return {...user, energy, last_energy_ts:initial===elapsed && user.last_energy_ts ? user.last_energy_ts : timestamp};
  }
  async function tap(user, body) {
    const id=body.packet_id, count=body.count;
    if (typeof id!=="string" || !/^[a-zA-Z0-9_-]{8,100}$/.test(id)) throw fault("BAD_PACKET_ID",400);
    if (!Number.isSafeInteger(count) || count<1 || count>Math.min(100,Math.max(1,packetMax))) throw fault("BAD_COUNT",400);
    return withTransaction(async client=>{
      const current=(await client.query("SELECT *,clock_timestamp() AS db_now FROM public.users WHERE id=$1 FOR UPDATE",[user.id])).rows[0];
      if (!current) throw fault("USER_NOT_FOUND",404);
      const prior=(await client.query("SELECT requested_count,applied,gained FROM jigcoin_internal.tap_claims WHERE user_id=$1 AND packet_id=$2",[user.id,id])).rows[0];
      if (prior) {
        if (prior.requested_count!==count) throw fault("PACKET_CONTENT_MISMATCH",409);
        return {user:project(current,new Date(current.db_now)),response:{ok:true,duplicate:true,applied:prior.applied,gained:prior.gained}};
      }
      // Do not replay packets processed before the transactional cutover.
      const legacy=await client.query("SELECT 1 FROM public.tap_packets WHERE packet_id=$1 AND telegram_id=$2",[id,user.telegram_id]);
      if (legacy.rowCount) return {user:project(current,new Date(current.db_now)),response:{ok:true,duplicate:true,applied:0,gained:0}};
      const now=new Date(current.db_now);
      if (new Date(current.banned_until)>now) throw fault("BANNED",403);
      const fresh=project(current,now);
      // Daily counters are statistics, not earning limits. Every validated tap
      // can earn while server-owned energy is available, for all account tiers.
      const applied=Math.max(0,Math.min(count,fresh.energy));
      const doubled=new Date(fresh.double_boost_until)>now ? 2 : 1;
      // Keep fractional coin units across packets, retries, sessions and UTC resets.
      // The user lock serializes this carry with energy and the ledger credit.
      const carry=Number((await client.query('SELECT units FROM jigcoin_internal.tap_fraction WHERE user_id=$1',[user.id])).rows[0]?.units||0);
      const raw=Number(getMultiplier(fresh)),bps=Math.round((Number.isFinite(raw)?Math.max(1,raw):1)*10000);
      const units=carry+applied*doubled*bps,gained=Math.floor(units/10000),remainder=units%10000;
      await client.query(`INSERT INTO jigcoin_internal.tap_fraction(user_id,units) VALUES($1,$2)
        ON CONFLICT(user_id) DO UPDATE SET units=EXCLUDED.units`,[user.id,remainder]);
      if (gained) await applyBalanceChangeTx(client,{userId:user.id,delta:gained,reason:"tap_reward",refType:"tap_packet",eventType:"tap"});
      const updated=(await client.query(`UPDATE public.users SET energy=$2,today_farmed=$3,taps_today=$4,
        last_reset=$5,last_energy_ts=$6,last_tap_at=clock_timestamp() WHERE id=$1 RETURNING *`,
      [user.id,fresh.energy-applied,Number(fresh.today_farmed||0)+gained,Number(fresh.taps_today||0)+applied,
        fresh.last_reset,fresh.last_energy_ts])).rows[0];
      await client.query("INSERT INTO jigcoin_internal.tap_claims(user_id,packet_id,requested_count,applied,gained) VALUES($1,$2,$3,$4,$5)",[user.id,id,count,applied,gained]);
      return {user:updated,response:{ok:true,applied,gained}};
    });
  }
  return {project,tap};
}
module.exports={createGameplay};
