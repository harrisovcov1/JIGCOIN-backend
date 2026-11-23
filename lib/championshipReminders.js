'use strict';
const prefix='jigcoin_internal.championship_';
function quiet(hour,start,end){
 if(start===end)return false;
 return start<end?hour>=start&&hour<end:hour>=start||hour<end;
}
function createReminders({withTransaction,callTelegram}){
 async function set(user,body){
  return withTransaction(async c=>{
   await c.query('SELECT id FROM public.users WHERE id=$1 FOR UPDATE',[user.id]);
   if(body.enabled===false){await c.query('DELETE FROM '+prefix+'reminders WHERE player=$1',[user.id]);return {enabled:false};}
   const {minute,quietFrom,quietTo}=body;
   if(body.enabled!==true||![minute,quietFrom,quietTo].every(Number.isInteger)||minute<0||minute>=1440||quietFrom<0||quietFrom>23||quietTo<0||quietTo>23||quiet(Math.floor(minute/60),quietFrom,quietTo))
    throw Object.assign(Error('Invalid reminder time'),{status:400,code:'INVALID_REMINDER'});
   const grant=await c.query('SELECT 1 FROM jigcoin_internal.telegram_write_grants WHERE telegram_id=$1',[user.telegram_id]);
   if(!grant.rowCount)throw Object.assign(Error('Telegram permission required'),{status:403,code:'WRITE_PERMISSION_REQUIRED'});
   await c.query(`INSERT INTO ${prefix}reminders VALUES ($1,$2,$3,$4) ON CONFLICT(player) DO UPDATE
    SET minute=excluded.minute,quiet_from=excluded.quiet_from,quiet_to=excluded.quiet_to`,[user.id,minute,quietFrom,quietTo]);
   return {enabled:true};
  });
 }
 async function dispatch(){
  const assigned=await withTransaction(async c=>(await c.query(`WITH utc AS (SELECT now() AT TIME ZONE 'UTC' AS t)
    INSERT INTO ${prefix}deliveries(player,day,state)
    SELECT r.player,t::date,'reserved' FROM ${prefix}reminders r JOIN public.users u ON u.id=r.player
    JOIN jigcoin_internal.telegram_write_grants g ON g.telegram_id=u.telegram_id CROSS JOIN utc
    WHERE r.minute=extract(hour FROM t)*60+extract(minute FROM t) AND u.telegram_id>0 AND NOT coalesce(u.is_system_user,false)
    AND (u.banned_until IS NULL OR u.banned_until<now()) AND NOT EXISTS(SELECT 1 FROM ${prefix}exclusions x WHERE x.player=r.player)
    ON CONFLICT DO NOTHING RETURNING player,day::text`)).rows);
  for(const job of assigned){
   await withTransaction(async c=>{
    const user=await c.query(`SELECT u.telegram_id FROM public.users u JOIN ${prefix}reminders r ON r.player=u.id
     WHERE u.id=$1 AND r.minute=extract(hour FROM now() AT TIME ZONE 'UTC')*60+extract(minute FROM now() AT TIME ZONE 'UTC') FOR UPDATE OF u`,[job.player]);
    let state='blocked';
    if(user.rowCount){
     try{await callTelegram('sendMessage',{chat_id:user.rows[0].telegram_id,text:'Your daily JIGCOIN Championship challenge is ready. You can turn off reminders in Weekly Championship.'});state='sent';}
     catch{state='uncertain';}
    }
    await c.query('UPDATE '+prefix+'deliveries SET state=$3 WHERE player=$1 AND day=$2',[job.player,job.day,state]);
   });
  }
 }
 return {set,dispatch};
}
module.exports={quiet,createReminders};
