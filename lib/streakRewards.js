'use strict';
const {dailyBase,dailyReward,restorePolicy}=require('./streakPolicy');
const COSMETICS=[{key:'momentum_aura',days:7,name:'Momentum aura'},{key:'veteran_frame',days:30,name:'Veteran frame'}];
const dayOf=value=>value?new Date(value).toISOString().slice(0,10):null;
function createStreakRewards({pool,baseReward,milestones,tiers,restoreEnabled=()=>false}) {
  const reward=day=>dailyReward(day,milestones);
  const tier=days=>[...tiers].reverse().find(t=>days>=t.minDays)||{name:'Warm-up',tapMult:1,energyBonus:0};
  async function grant(client,userId,days) {
    for(const c of COSMETICS)if(days>=c.days)await client.query(`INSERT INTO jigcoin_internal.streak_cosmetics(user_id,cosmetic_key)
      VALUES($1,$2) ON CONFLICT(user_id,cosmetic_key) DO NOTHING`,[userId,c.key]);
  }
  async function describe(client,user,now=new Date()) {
    const day=dayOf(now),last=dayOf(user.last_checkin_at||user.last_checkin_date),days=Math.max(0,Number(user.streak_count)||0);
    const gap=last?Math.round((Date.parse(day)-Date.parse(last))/86400000):null;
    const claimed=gap===0,broken=restorePolicy(user,now).broken;
    const nextDay=broken||!last?1:days+1;
    const focus=claimed?days:nextDay,first=Math.floor((Math.max(1,focus)-1)/7)*7+1;
    const owned=(await client.query('SELECT cosmetic_key FROM jigcoin_internal.streak_cosmetics WHERE user_id=$1',[user.id])).rows.map(r=>r.cosmetic_key);
    const benefitDays=broken||!last||gap<0?0:days;
    const currentTier=tier(benefitDays),nextTier=tiers.find(t=>t.minDays>benefitDays&&(t.tapMult>1||t.energyBonus>0));
    const nextMilestone=milestones.find(m=>m.days>(broken?0:days));
    return {day,days,claimed,broken,base_reward:dailyBase(claimed?days:nextDay),continuing_reward:2000,continuing_from_day:30,
      restore:{...restorePolicy(user,now),enabled:restoreEnabled(user),daily_reward:dailyBase(days),tap_bonus_percent:Math.round((tier(days).tapMult-1)*100),energy_bonus:tier(days).energyBonus},today_reward:reward(claimed?days:nextDay),next_reward:reward(nextDay),next_day:nextDay,
      resets_at:new Date(Date.parse(day+'T00:00:00Z')+86400000).toISOString(),
      calendar:Array.from({length:7},(_,i)=>{const d=first+i;return {day:d,reward:reward(d),claimed:!broken&&d<=days,focus:d===focus,cosmetic:COSMETICS.find(c=>c.days===d)?.key||null};}),
      tier:{name:currentTier.name,tap_bonus_percent:Math.round((currentTier.tapMult-1)*100),energy_bonus:currentTier.energyBonus},
      next_tier:nextTier?{day:nextTier.minDays,name:nextTier.name,tap_bonus_percent:Math.round((nextTier.tapMult-1)*100),energy_bonus:nextTier.energyBonus}:null,
      next_milestone:nextMilestone?{day:nextMilestone.days,reward:reward(nextMilestone.days)}:null,
      milestones:milestones.map(m=>({day:m.days,reward:reward(m.days)})),
      cosmetics:COSMETICS.map(c=>({...c,owned:owned.includes(c.key)}))};
  }
  async function decorate(rows) {
    if(!rows?.length)return rows;
    const ids=rows.map(r=>r.telegram_id).filter(id=>Number.isSafeInteger(Number(id)));
    const owned=(await pool.query(`SELECT u.telegram_id,c.cosmetic_key FROM jigcoin_internal.streak_cosmetics c
      JOIN public.users u ON u.id=c.user_id WHERE u.telegram_id=ANY($1::bigint[])`,[ids])).rows;
    return rows.map(row=>({...row,cosmetics:owned.filter(c=>String(c.telegram_id)===String(row.telegram_id)).map(c=>c.cosmetic_key)}));
  }
  return {grant,describe,decorate};
}
module.exports={createStreakRewards,COSMETICS};
