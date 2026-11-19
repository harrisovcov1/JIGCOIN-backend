'use strict';
const timestamp=value=>value==null?NaN:new Date(value).getTime();
const VIP = Object.freeze({sku:'VIP_30D_V11',title:'JigCoin VIP Pass',stars:500,days:30,terms:'vip-v11-20261117'});
const active = (user, now=Date.now()) => timestamp(user?.vip_until || '') > Number(now);
function benefits(user, meta={}, now=Date.now()) {
  const base=Math.max(1,Number(user?.max_energy)||50);
  const standardEnergy=base+(meta.active?Math.max(0,Number(meta.energy_bonus)||0):0);
  const standardTap=meta.active?Math.max(1,Number(meta.tap_multiplier)||1):1;
  const vipActive=active(user,now),adActive=timestamp(user?.double_boost_until||'')>Number(now);
  return {active:vipActive,standard_energy:standardEnergy,vip_energy:standardEnergy*2,
    energy:standardEnergy*(vipActive?2:1),standard_tap:standardTap,vip_tap:standardTap*2,
    tap:standardTap*(vipActive?2:1)*(adActive?2:1),ad_active:adActive};
}
module.exports={VIP,active,benefits};
