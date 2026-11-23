'use strict';

const {createHash}=require('node:crypto');
const DAY = 86400000;
const PRIZES = Object.freeze([100000, 50000, 25000]);

function schedule(serverTime, activation) {
  const now = new Date(serverTime).getTime();
  const accepted = new Date(activation).getTime();
  if (!Number.isFinite(now) || !Number.isFinite(accepted)) throw new Error('Invalid timestamp');
  const day = Math.floor(accepted / DAY);
  const first = day + 7 - ((day + 3) % 7);
  const elapsed = Math.floor(now / DAY) - first;
  if (elapsed < 0) return null;
  const iso = n => new Date(n * DAY).toISOString().slice(0,10);
  const week = first + 7 * Math.floor(elapsed / 7);
  return {day:iso(first + elapsed), week:iso(week), close:iso(week+7), challenge:elapsed % 30};
}

// Ties compare first-ranked-attempt performance across the same six counted
// days. Equal daily bests count the day with the better first attempt.
function standings(runs,week){
 if(!/^\d{4}-\d{2}-\d{2}$/.test(week))throw Error('UTC competition week required');
 const players=new Map();
 for(const r of runs){
  if(!r.eligible || r.mode!=='ranked' || !Number.isInteger(r.score) || r.score<1 || r.score>1000 ||
     !Number.isInteger(r.day)||r.day<0||r.day>6)continue;
  const player=String(r.player);
  if(!/^[1-9][0-9]*$/.test(player))throw Error('Invalid player ID');
  if(!players.has(player))players.set(player,{player,daily:Array(7).fill(0),first:Array(7).fill(0)});
  const row=players.get(player);
  row.daily[r.day]=Math.max(row.daily[r.day],r.score);
  if(r.slot===1)row.first[r.day]=Math.max(row.first[r.day],r.score);
 }
 const rows=Array.from(players.values(),row=>{
  const days=row.daily.map((score,i)=>({score,first:row.first[i]}))
   .sort((a,b)=>b.score-a.score || b.first-a.first).slice(0,6);
  const best=days.map(d=>d.score),firstTotal=days.reduce((n,d)=>n+d.first,0);
  // Last resort only. The published formula rotates the ordering each UTC
  // week without favouring older accounts or rewarding faster networks.
  const tieKey=createHash('sha256').update('jigcoin-champ-v2/'+week+'/'+row.player).digest('hex');
  return {...row,best,firstTotal,tieKey,total:best.reduce((a,b)=>a+b,0)};
 });
 return rows.sort((a,b)=>{
  if(a.total!==b.total)return b.total-a.total;
  for(let i=0;i<6;i++)if(a.best[i]!==b.best[i])return b.best[i]-a.best[i];
  if(a.firstTotal!==b.firstTotal)return b.firstTotal-a.firstTotal;
  return a.tieKey<b.tieKey?-1:a.tieKey>b.tieKey?1:0;
 }).map((row,i)=>({...row,place:i+1,prize:PRIZES[i]||0}));
}
// Once v2 is enabled, legacy workers may finish earlier periods only.
function legacyPeriodFilter(column) {
 if (!['d.day','candidate.week'].includes(column)) throw Error('Unknown legacy period');
 if (process.env.CHAMPIONSHIP_V2!=='1') return '';
 return `AND NOT EXISTS (SELECT 1 FROM jigcoin_internal.championship_config cfg
  WHERE ${column} >= (date_trunc('week',cfg.accepted_at AT TIME ZONE 'UTC')::date + 7))`;
}
module.exports={schedule,standings,PRIZES,legacyPeriodFilter};
