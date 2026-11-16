'use strict';
const DAY=86400000,RESTORE_STARS=250;
function dayOf(value){const n=value?new Date(value).getTime():NaN;return Number.isFinite(n)?new Date(n).toISOString().slice(0,10):null;}
function dailyBase(day){return day>=30?2000:day>=14?1000:day>=7?750:500;}
function dailyReward(day,milestones=[]){return dailyBase(day)+milestones.filter(m=>m.days===day).reduce((n,m)=>n+m.bonus,0);}
function restorePolicy(user,now=new Date()){
  const last=dayOf(user.last_checkin_at||user.last_checkin_date),today=dayOf(now);
  const days=Math.max(0,Math.floor(Number(user.streak_count)||0));
  const gap=last&&today?Math.round((Date.parse(today)-Date.parse(last))/DAY):null;
  const broken=days>0&&gap>1;
  const at=last?Date.parse(last+'T00:00:00Z'):null;
  return {eligible:days>0&&gap===2,broken,days,last_day:last,gap,stars:RESTORE_STARS,
    missed_day:broken?dayOf(at+DAY):null,broken_at:broken?new Date(at+2*DAY).toISOString():null,
    expires_at:broken?new Date(at+3*DAY).toISOString():null};
}
module.exports={DAY,RESTORE_STARS,dayOf,dailyBase,dailyReward,restorePolicy};
