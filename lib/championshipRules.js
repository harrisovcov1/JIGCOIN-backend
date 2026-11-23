'use strict';

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

// Input consists solely of admitted server-validated ranked runs for one UTC week.
// A positive daily result qualifies. Compare the six counted scores descending
// after the total, then immutable numeric player ID for otherwise identical records.
function standings(runs) {
  const players = new Map();
  for (const r of runs) {
    if (!r.eligible || r.mode !== 'ranked' || !Number.isInteger(r.score) ||
        r.score < 1 || r.score > 1000 || !Number.isInteger(r.day) || r.day < 0 || r.day > 6) continue;
    const id = String(r.player);
    if (!/^[1-9][0-9]*$/.test(id)) throw new Error('Invalid player ID');
    const daily = players.get(id) || Array(7).fill(0);
    daily[r.day] = Math.max(daily[r.day], r.score);
    players.set(id, daily);
  }
  const rows = Array.from(players, ([player,daily]) => {
    const best = [...daily].sort((a,b)=>b-a).slice(0,6);
    return {player, daily, best, total:best.reduce((a,b)=>a+b,0)};
  });
  return rows.sort((a,b)=>{
    if (a.total !== b.total) return b.total-a.total;
    for (let i=0;i<6;i++) if (a.best[i] !== b.best[i]) return b.best[i]-a.best[i];
    return BigInt(a.player)<BigInt(b.player)?-1:1;
  }).map((row,i)=>({...row,place:i+1,prize:PRIZES[i]||0}));
}
module.exports={schedule,standings,PRIZES};
