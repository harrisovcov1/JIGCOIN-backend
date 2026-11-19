"use strict";
const VERSION = "referrals_welcome_v10";
// Reward amounts remain v10. Only registrations made by the v16 server use
// this cumulative-tap qualification; older persisted contracts are unchanged.
const ACTIVATION_VERSION = "referrals_cumulative_v16";
const ACTIVATION_TAPS = 100;
const WELCOME_COINS = 1000;
const TIERS = Object.freeze([
  {at:1,through:4,name:"Bronze",reward_coins:500},
  {at:5,through:19,name:"Silver",reward_coins:1000},
  {at:20,through:49,name:"Gold",reward_coins:1250},
  {at:50,through:199,name:"Platinum",reward_coins:1500},
  {at:200,through:null,name:"Diamond",reward_coins:2000}
].map(Object.freeze));
function validCount(value) {
  const count=Number(value ?? 0);
  if (!Number.isSafeInteger(count) || count<0 || count>=Number.MAX_SAFE_INTEGER) throw Error("REFERRAL_COUNTER_INVALID");
  return count;
}
function tierForOrdinal(ordinal) {
  const n=validCount(ordinal);
  if(n<1) throw Error("REFERRAL_ORDINAL_INVALID");
  return [...TIERS].reverse().find(t=>n>=t.at);
}
function nextReward(count) { return tierForOrdinal(validCount(count)+1).reward_coins; }
function currentTier(count) {
  const n=validCount(count);
  if(n===0)return {tier:0,name:"Get started",multiplier:1};
  const row=tierForOrdinal(n);
  return {tier:TIERS.indexOf(row)+1,name:row.name,multiplier:row.reward_coins/500};
}
// Existing v9 registrations retain their original pending reward contract.
function legacyTier(count) {
  const c=validCount(count);
  if(c>=200)return {tier:5,multiplier:2};
  if(c>=50)return {tier:4,multiplier:1.6};
  if(c>=20)return {tier:3,multiplier:1.3};
  if(c>=5)return {tier:2,multiplier:1.15};
  if(c>=1)return {tier:1,multiplier:1.05};
  return {tier:0,multiplier:1};
}
module.exports={VERSION,ACTIVATION_VERSION,ACTIVATION_TAPS,WELCOME_COINS,TIERS,validCount,tierForOrdinal,nextReward,currentTier,legacyTier};
