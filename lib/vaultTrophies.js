'use strict';
// Read-only, account-scoped history; never invokes ranking or settlement.
// Remains readable when the live Championship flag is disabled for rollback.
const PRIZES=Object.freeze([100000,50000,25000]);
function createVaultTrophies({pool}){
 async function history(user){
  const {rows}=await pool.query(`SELECT t.week::text,t.place,t.score,t.coins,
    (l.id IS NOT NULL AND l.user_id=t.player AND l.delta=t.coins
     AND l.reason='weekly_championship' AND l.ref_type='championship_week'
     AND l.ref_id=to_char(t.week,'YYYYMMDD')::bigint
     AND l.event_type='challenge_reward') AS ledger_verified
    FROM jigcoin_internal.championship_trophies t
    LEFT JOIN public.user_balance_ledger l ON l.id=t.ledger_id
    WHERE t.player=$1 ORDER BY t.week DESC,t.place`,[user.id]);
  const trophies=rows.map(r=>{
   const place=Number(r.place),score=Number(r.score),coins=Number(r.coins);
   if(r.ledger_verified!==true||!Number.isInteger(place)||PRIZES[place-1]!==coins||
    !Number.isSafeInteger(score)||score<1||score>6000||!/^\d{4}-\d{2}-\d{2}$/.test(r.week))
     throw Object.assign(Error('TROPHY_HISTORY_UNVERIFIED'),{status:503,code:'TROPHY_HISTORY_UNVERIFIED'});
   return {week:r.week,place,score,coins};
  });
  return {ok:true,telegram_id:String(user.telegram_id),trophies};
 }
 return {history};
}
module.exports={createVaultTrophies};
