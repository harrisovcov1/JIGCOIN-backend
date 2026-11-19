'use strict';
const {createReleaseAccess}=require('./releaseAccess');
const timestamp=value=>value==null?NaN:new Date(value).getTime();
const crypto=require('node:crypto');
const {VIP,benefits}=require('./vipPolicy');
const yes=v=>/^(1|true)$/i.test(String(v||''));
const fail=(code,status=409)=>{throw Object.assign(Error(code),{code,status});};
const matches=p=>typeof p==='string'&&/^vp_[a-f0-9]{48}$/.test(p);
function createVipPass({pool,withTransaction,env,callTelegram,getStreakMeta=()=>({}),now=()=>Date.now()}) {
 const access=createReleaseAccess(env,now);
 const enabled=user=>access.sell(user,'VIP');
 const lockUser=async(c,id)=>(await c.query('SELECT * FROM public.users WHERE id=$1 FOR UPDATE',[id])).rows[0];
 async function assertReady(){
  const r=await pool.query("SELECT version FROM jigcoin_internal.vip_v11_migrations WHERE version='vault_vip_v11'");
  if(!r.rows.length)fail('INSTALL_VIP_V11_MIGRATION',503);
 }
 async function overview(identity) {
  const [users,stats,orders]=await Promise.all([
   pool.query('SELECT * FROM public.users WHERE id=$1',[identity.id]),
   pool.query('SELECT bonus_coins FROM jigcoin_internal.vip_tap_stats_v11 WHERE user_id=$1',[identity.id]),
   pool.query(`SELECT o.payload,o.status,o.stars,o.created_at,o.paid_at,g.starts_at,g.ends_at
     FROM jigcoin_internal.vip_orders_v11 o LEFT JOIN jigcoin_internal.vip_grants_v11 g ON g.id=o.grant_id
     WHERE o.user_id=$1 ORDER BY o.id DESC LIMIT 10`,[identity.id])]);
  const u=users.rows[0];if(!u||String(u.telegram_id)!==String(identity.telegram_id))fail('ACCOUNT_UNAVAILABLE',403);
  const at=now(),streak=getStreakMeta(u,at),b=benefits(u,streak,at);
  return {ok:true,telegram_id:String(u.telegram_id),server_now:new Date(now()).toISOString(),
   balance:Number(u.balance),vip_active:b.active,vip_until:u.vip_until,benefits:b,
   streak_day:streak.active?Number(u.streak_count)||0:0,
   vip_bonus_coins:Number(stats.rows[0]?.bonus_coins||0),bonus_tracking_since:'v11',
   product:{...VIP,enabled:enabled(u),currency:'XTR',auto_renew:false},recent_orders:orders.rows};
 }
 async function invoice(identity,body={}) {
  if(!enabled(identity))fail('VIP_SALES_UNAVAILABLE',503);
  if(body.terms_accepted!==true||body.terms_version!==VIP.terms)fail('ACCEPT_VIP_TERMS',400);
  const hook=await callTelegram('getWebhookInfo',{});
  if(!env.STARS_WEBHOOK_URL||hook.url!==env.STARS_WEBHOOK_URL||!hook.allowed_updates?.includes('message')||!hook.allowed_updates?.includes('pre_checkout_query'))fail('CHECKOUT_NOT_READY',503);
  let order=await withTransaction(async c=>{
   const u=await lockUser(c,identity.id);
   if(!u||String(u.telegram_id)!==String(identity.telegram_id)||!enabled(u))fail('ACCOUNT_UNAVAILABLE',403);
   await c.query("UPDATE jigcoin_internal.vip_orders_v11 SET status='expired' WHERE user_id=$1 AND ((status IN ('created','invoiced') AND expires_at<=$2) OR (status='approved' AND expires_at+interval '15 minutes'<=$2))",[u.id,new Date(now())]);
   const existing=(await c.query("SELECT * FROM jigcoin_internal.vip_orders_v11 WHERE user_id=$1 AND status IN ('created','invoiced','approved') LIMIT 1",[u.id])).rows[0];
   if(existing){if(existing.status==='approved')fail('PAYMENT_PENDING');return existing;}
   return (await c.query(`INSERT INTO jigcoin_internal.vip_orders_v11(user_id,telegram_id,payload,stars,duration_days,terms_version,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,[u.id,u.telegram_id,'vp_'+crypto.randomBytes(24).toString('hex'),VIP.stars,VIP.days,VIP.terms,new Date(now()+15*60000)])).rows[0];
  });
  if(!order.invoice_url){
   const url=await callTelegram('createInvoiceLink',{title:'JigCoin VIP · 30 days',
    description:'2× tap coins and 2× energy capacity for 30 days. Streak perks included; ad boost stacks. Other rewards unchanged. One payment, no auto-renewal. Existing VIP time is preserved.',
    payload:order.payload,provider_token:'',currency:'XTR',prices:[{label:'VIP · 30 days',amount:order.stars}]});
   if(typeof url!=='string'||!/^https:\/\/t\.me\/\$/.test(url))fail('INVOICE_UNAVAILABLE',503);
   order=(await pool.query(`UPDATE jigcoin_internal.vip_orders_v11 SET invoice_url=COALESCE(invoice_url,$2),status=CASE WHEN status='created' THEN 'invoiced' ELSE status END WHERE id=$1 RETURNING *`,[order.id,url])).rows[0];
  }
  return {ok:true,order_id:order.payload,url:order.invoice_url,stars:VIP.stars};
 }
 async function status(identity,payload){
  if(!matches(payload))fail('INVALID_ORDER',400);
  await pool.query("UPDATE jigcoin_internal.vip_orders_v11 SET status='expired' WHERE user_id=$1 AND payload=$2 AND ((status IN ('created','invoiced') AND expires_at<=$3) OR (status='approved' AND expires_at+interval '15 minutes'<=$3))",[identity.id,payload,new Date(now())]);
  const o=(await pool.query('SELECT payload,status,stars,paid_at,refunded_at FROM jigcoin_internal.vip_orders_v11 WHERE user_id=$1 AND payload=$2',[identity.id,payload])).rows[0];
  if(!o)fail('ORDER_NOT_FOUND',404);return {ok:true,order:o};
 }
 async function precheckout(q){
  let ok=false;
  try{
   if(!matches(q.invoice_payload))fail('INVALID_ORDER');
   const known=(await pool.query('SELECT user_id FROM jigcoin_internal.vip_orders_v11 WHERE payload=$1',[q.invoice_payload])).rows[0];
   if(known)ok=await withTransaction(async c=>{
    const u=await lockUser(c,known.user_id);
    const o=(await c.query('SELECT * FROM jigcoin_internal.vip_orders_v11 WHERE payload=$1 FOR UPDATE',[q.invoice_payload])).rows[0];
    if(!u||!enabled(u)||String(q.from?.id)!==String(o.telegram_id)||q.currency!=='XTR'||q.total_amount!==Number(o.stars))return false;
    if(o.status==='approved')return o.precheckout_id===q.id;
    if(o.status!=='invoiced'||timestamp(o.expires_at)<=now())return false;
    await c.query("UPDATE jigcoin_internal.vip_orders_v11 SET status='approved',precheckout_id=$2 WHERE id=$1",[o.id,q.id]);return true;
   });
  }catch(_){ok=false;}
  await callTelegram('answerPreCheckoutQuery',{pre_checkout_query_id:q.id,ok,...(!ok?{error_message:'VIP checkout is unavailable or expired. Reopen Vault and try again.'}:{})});
  return {ok:true};
 }
 async function revokeGrant(c,u,grantId){
  const g=(await c.query('SELECT * FROM jigcoin_internal.vip_grants_v11 WHERE id=$1 AND user_id=$2 FOR UPDATE',[grantId,u.id])).rows[0];
  if(!g||g.revoked_at)return;
  const remaining=Math.max(0,timestamp(g.ends_at)-Math.max(now(),timestamp(g.starts_at)));
  await c.query('UPDATE jigcoin_internal.vip_grants_v11 SET revoked_at=$2 WHERE id=$1',[g.id,new Date(now())]);
  // Remove only this grant's unconsumed time. Later renewals retain their full duration.
  if(remaining){
   await c.query(`UPDATE jigcoin_internal.vip_grants_v11 SET starts_at=starts_at-($3::bigint*interval '1 millisecond'),
    ends_at=ends_at-($3::bigint*interval '1 millisecond') WHERE user_id=$1 AND id>$2 AND revoked_at IS NULL`,[u.id,g.id,remaining]);
   await c.query("UPDATE public.users SET vip_until=GREATEST($2::timestamptz,vip_until-($3::bigint*interval '1 millisecond')) WHERE id=$1",[u.id,new Date(now()),remaining]);
  }
 }
 async function settlement(message,refund=false){
  const p=refund?message.refunded_payment:message.successful_payment;
  if(!p||!matches(p.invoice_payload)||typeof p.telegram_payment_charge_id!=='string'||!p.telegram_payment_charge_id)fail('INVALID_PAYMENT',400);
  const known=(await pool.query('SELECT user_id FROM jigcoin_internal.vip_orders_v11 WHERE payload=$1',[p.invoice_payload])).rows[0];
  if(!known)fail('UNKNOWN_PAYMENT');
  return withTransaction(async c=>{
   const u=await lockUser(c,known.user_id);
   const o=(await c.query('SELECT * FROM jigcoin_internal.vip_orders_v11 WHERE payload=$1 FOR UPDATE',[p.invoice_payload])).rows[0];
   if(!u||String(message.from?.id)!==String(o.telegram_id)||p.currency!=='XTR'||p.total_amount!==Number(o.stars))fail('PAYMENT_MISMATCH');
   if(o.charge_id&&o.charge_id!==p.telegram_payment_charge_id)fail('CHARGE_MISMATCH');
   if(refund){
    if(o.status==='refunded')return {ok:true,duplicate:true};
    if(o.grant_id)await revokeGrant(c,u,o.grant_id);
    await c.query("UPDATE jigcoin_internal.vip_orders_v11 SET status='refunded',charge_id=$2,refunded_at=$3 WHERE id=$1",[o.id,p.telegram_payment_charge_id,new Date(now())]);
    return {ok:true,refunded:true};
   }
   if(['paid','refunded'].includes(o.status))return {ok:true,duplicate:true};
   if(!o.precheckout_id)fail('PAYMENT_NOT_APPROVED');
   const start=Math.max(now(),timestamp(u.vip_until)||0),end=start+Number(o.duration_days)*86400000;
   const grant=(await c.query(`INSERT INTO jigcoin_internal.vip_grants_v11(user_id,source_key,starts_at,ends_at)
    VALUES($1,$2,$3,$4) RETURNING id`,[u.id,'stars:'+o.payload,new Date(start),new Date(end)])).rows[0];
   await c.query('UPDATE public.users SET vip_until=$2 WHERE id=$1',[u.id,new Date(end)]);
   await c.query("UPDATE jigcoin_internal.vip_orders_v11 SET status='paid',charge_id=$2,paid_at=$3,grant_id=$4 WHERE id=$1",[o.id,p.telegram_payment_charge_id,new Date(now()),grant.id]);
   return {ok:true,activated:true,vip_until:new Date(end).toISOString()};
  });
 }
 async function refundOrder(payload){
  if(!matches(payload))fail('INVALID_ORDER',400);
  const o=(await pool.query('SELECT * FROM jigcoin_internal.vip_orders_v11 WHERE payload=$1',[payload])).rows[0];
  if(!o?.charge_id||!['paid','refunded'].includes(o.status))fail('REFUND_NOT_AVAILABLE');
  if(o.status==='refunded')return {ok:true,duplicate:true};
  try{await callTelegram('refundStarPayment',{user_id:Number(o.telegram_id),telegram_payment_charge_id:o.charge_id});}
  catch(e){if(e.telegramCode!=='CHARGE_ALREADY_REFUNDED')throw e;}
  return settlement({from:{id:Number(o.telegram_id)},refunded_payment:{invoice_payload:o.payload,currency:'XTR',total_amount:Number(o.stars),telegram_payment_charge_id:o.charge_id}},true);
 }
 return {enabled,overview,invoice,status,precheckout,settlement,refundOrder,matches,assertReady};
}
module.exports={createVipPass};
