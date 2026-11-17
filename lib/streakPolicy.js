'use strict';
const DAY=86400000,RESTORE_STARS=250;
// Version this server-owned schedule when changing future payouts. Never derive
// reward amounts from the browser or rewrite already credited ledger entries.
const STREAK_ECONOMY=Object.freeze({version:'daily-ladder-v6',start:100,step:100,cap:2000,capDay:20,milestoneEvery:100,milestoneBonus:2000});
function dayOf(value){const n=value?new Date(value).getTime():NaN;return Number.isFinite(n)?new Date(n).toISOString().slice(0,10):null;}
function dailyBase(day){
  const value=Number(day);
  if(!Number.isSafeInteger(value)||value<0)throw new RangeError('Invalid streak day');
  return Math.min(STREAK_ECONOMY.cap,STREAK_ECONOMY.start+(Math.max(1,value)-1)*STREAK_ECONOMY.step);
}
function dailyRewardBreakdown(day){
  const base=dailyBase(day),value=Number(day);
  const bonus=value>0&&value%STREAK_ECONOMY.milestoneEvery===0?STREAK_ECONOMY.milestoneBonus:0;
  return {base,bonus,total:base+bonus};
}
function dailyReward(day){return dailyRewardBreakdown(day).total;}
function nextStreakMilestone(completedDays){
  dailyBase(completedDays); // Validate before deriving a future milestone.
  const day=(Math.floor(Number(completedDays)/STREAK_ECONOMY.milestoneEvery)+1)*STREAK_ECONOMY.milestoneEvery;
  if(!Number.isSafeInteger(day))throw new RangeError('Invalid next streak milestone');
  const {base,bonus,total}=dailyRewardBreakdown(day);
  return {day,base,bonus,reward:total};
}
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
module.exports={DAY,RESTORE_STARS,STREAK_ECONOMY,dayOf,dailyBase,dailyReward,dailyRewardBreakdown,nextStreakMilestone,restorePolicy};
