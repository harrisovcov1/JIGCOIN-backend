'use strict';
const crypto=require('crypto');
const {restorePolicy,dayOf,RESTORE_STARS}=require('./streakPolicy');
const yes=v=>/^(1|true)$/i.test(String(v||''));
const fail=(code,status=409)=>{throw Object.assign(new Error(code),{code,status});};
const matches=p=>typeof p==='string'&&/^sr_[a-f0-9]{48}$/.test(p);
function createStreakRestore({pool,withTransaction,callTelegram,env,now=()=>Date.now()}){
  const enabled=user=>yes(env.STARS_SHOP_ENABLED)&&yes(env.RECOVERY_TEST_ENABLED)&&
    String(user.telegram_id)===String(env.RECOVERY_TEST_TELEGRAM_ID)&&!user.is_system_user&&
    /^[A-Za-z0-9_-]{32,256}$/.test(String(env.TELEGRAM_WEBHOOK_SECRET||''))&&String(env.PAYMENT_SUPPORT_CONTACT||'').trim().length>=5;
  const lockUser=async(c,id)=>(await c.query('SELECT * FROM public.users WHERE id=$1 FOR UPDATE',[id])).rows[0];
  const valid=(u,o)=>{const p=restorePolicy(u,new Date(now()));return p.eligible&&p.last_day===dayOf(o.prior_last_day)&&p.days===Number(o.prior_streak)&&now()<new Date(o.expires_at).getTime();};
  async function offer(user){return {ok:true,...restorePolicy(user,new Date(now())),enabled:enabled(user)};}
  async function invoice(identity){
    if(!enabled(identity))fail('SHOP_NOT_READY',503);
    const hook=await callTelegram('getWebhookInfo',{});
    if(!env.STARS_WEBHOOK_URL||hook.url!==env.STARS_WEBHOOK_URL||!hook.allowed_updates?.includes('message')||!hook.allowed_updates?.includes('pre_checkout_query'))fail('CHECKOUT_NOT_READY',503);
    let o=await withTransaction(async c=>{
      const u=await lockUser(c,identity.id);
      if(!u||String(u.telegram_id)!==String(identity.telegram_id)||!enabled(u))fail('ACCOUNT_UNAVAILABLE',403);
      const p=restorePolicy(u,new Date(now()));if(!p.eligible)fail('RESTORE_NOT_AVAILABLE');
      const old=(await c.query('SELECT * FROM jigcoin_internal.streak_restore_orders WHERE user_id=$1 AND missed_day=$2',[u.id,p.missed_day])).rows[0];
      if(old){if(!['created','invoiced'].includes(old.status))fail(old.status==='approved'?'PAYMENT_PENDING':'RESTORE_ALREADY_USED');return old;}
      return (await c.query(`INSERT INTO jigcoin_internal.streak_restore_orders
        (user_id,telegram_id,payload,prior_last_day,prior_streak,missed_day,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,[u.id,u.telegram_id,'sr_'+crypto.randomBytes(24).toString('hex'),p.last_day,p.days,p.missed_day,p.expires_at])).rows[0];
    });
    if(!o.invoice_url){
      const url=await callTelegram('createInvoiceLink',{title:'Restore daily streak',description:`Restore your ${o.prior_streak}-day streak after one missed day. No missed-day coins. Today's reward must be claimed separately.`,payload:o.payload,provider_token:'',currency:'XTR',prices:[{label:'Streak restore',amount:RESTORE_STARS}]});
      if(typeof url!=='string'||!/^https:\/\/t\.me\/\$/.test(url))fail('INVOICE_UNAVAILABLE',503);
      o=(await pool.query(`UPDATE jigcoin_internal.streak_restore_orders SET invoice_url=COALESCE(invoice_url,$2),status=CASE WHEN status='created' THEN 'invoiced' ELSE status END WHERE id=$1 RETURNING *`,[o.id,url])).rows[0];
    }
    return {ok:true,order_id:o.payload,url:o.invoice_url,stars:RESTORE_STARS};
  }
  async function status(user,payload){
    if(payload!=null&&!matches(payload))fail('INVALID_ORDER',400);
    const columns='payload,status,stars,prior_streak,expires_at,restored_at';
    const o=(await pool.query(payload?`SELECT ${columns} FROM jigcoin_internal.streak_restore_orders WHERE payload=$1 AND user_id=$2`:`SELECT ${columns} FROM jigcoin_internal.streak_restore_orders WHERE user_id=$1 ORDER BY id DESC LIMIT 1`,payload?[payload,user.id]:[user.id])).rows[0];
    if(payload&&!o)fail('ORDER_NOT_FOUND',404);return {ok:true,order:o||null};
  }
  async function precheckout(q){
    let ok=false;
    try{
      if(!matches(q.invoice_payload))fail('INVALID_ORDER');
      const known=(await pool.query('SELECT * FROM jigcoin_internal.streak_restore_orders WHERE payload=$1',[q.invoice_payload])).rows[0];
      if(known)ok=await withTransaction(async c=>{
        const u=await lockUser(c,known.user_id);
        const o=(await c.query('SELECT * FROM jigcoin_internal.streak_restore_orders WHERE id=$1 FOR UPDATE',[known.id])).rows[0];
        if(!u||!enabled(u)||String(o.telegram_id)!==String(q.from?.id)||q.currency!=='XTR'||q.total_amount!==RESTORE_STARS||!valid(u,o))return false;
        if(o.status==='approved')return o.precheckout_id===q.id;
        if(o.status!=='invoiced')return false;
        await c.query("UPDATE jigcoin_internal.streak_restore_orders SET status='approved',precheckout_id=$2,approved_at=NOW() WHERE id=$1",[o.id,q.id]);return true;
      });
    }catch(_){ok=false;}
    await callTelegram('answerPreCheckoutQuery',{pre_checkout_query_id:q.id,ok,...(!ok?{error_message:'This restore is unavailable. Reopen Daily streak to check your options.'}:{})});
    return {ok:true};
  }
  async function refundPending(o){
    try{await callTelegram('refundStarPayment',{user_id:Number(o.telegram_id),telegram_payment_charge_id:o.charge_id});}
    catch(e){if(e.telegramCode!=='CHARGE_ALREADY_REFUNDED')throw e;}
    await pool.query("UPDATE jigcoin_internal.streak_restore_orders SET status='refunded',refunded_at=NOW() WHERE id=$1 AND status='refund_pending'",[o.id]);
    return {ok:true,refunded:true};
  }
  async function settlement(message,refund=false){
    const p=refund?message.refunded_payment:message.successful_payment;
    if(!p||!matches(p.invoice_payload)||typeof p.telegram_payment_charge_id!=='string'||!p.telegram_payment_charge_id)fail('INVALID_PAYMENT');
    const known=(await pool.query('SELECT * FROM jigcoin_internal.streak_restore_orders WHERE payload=$1',[p.invoice_payload])).rows[0];
    if(!known)fail('UNKNOWN_PAYMENT');
    const result=await withTransaction(async c=>{
      const u=await lockUser(c,known.user_id);
      const o=(await c.query('SELECT * FROM jigcoin_internal.streak_restore_orders WHERE id=$1 FOR UPDATE',[known.id])).rows[0];
      if(String(message.from?.id)!==String(o.telegram_id)||p.currency!=='XTR'||p.total_amount!==RESTORE_STARS)fail('PAYMENT_MISMATCH');
      if(o.charge_id&&o.charge_id!==p.telegram_payment_charge_id)fail('CHARGE_MISMATCH');
      if(refund){
        if(o.status==='refunded')return {ok:true,duplicate:true};
        // A refund never deletes earned coins or permanent cosmetics. Mark receipt to prevent replay.
        await c.query("UPDATE jigcoin_internal.streak_restore_orders SET status='refunded',charge_id=$2,refunded_at=NOW() WHERE id=$1",[o.id,p.telegram_payment_charge_id]);return {ok:true,refunded:true};
      }
      if(['restored','refunded'].includes(o.status))return {ok:true,duplicate:true};
      if(!o.precheckout_id)fail('PAYMENT_NOT_APPROVED');
      if(o.status==='refund_pending')return {refund:o};
      if(!u||u.is_system_user||!valid(u,o)){
        const pending=(await c.query("UPDATE jigcoin_internal.streak_restore_orders SET status='refund_pending',charge_id=$2 WHERE id=$1 RETURNING *",[o.id,p.telegram_payment_charge_id])).rows[0];return {refund:pending};
      }
      // Lock shared with daily claims. Restore continuity only; never grant missed-day coins.
      await c.query(`UPDATE public.users SET last_checkin_at=$2::date::timestamp AT TIME ZONE 'UTC',
        last_checkin_date=$2::date,last_daily=$2::date,streak_broken_at=NULL WHERE id=$1`,[u.id,dayOf(o.missed_day)]);
      await c.query("UPDATE jigcoin_internal.streak_restore_orders SET status='restored',charge_id=$2,restored_at=NOW() WHERE id=$1",[o.id,p.telegram_payment_charge_id]);
      return {ok:true,restored:true};
    });
    return result.refund?refundPending(result.refund):result;
  }
  async function refundOrder(payload){
    if(!matches(payload))fail('INVALID_ORDER',400);
    const o=(await pool.query('SELECT * FROM jigcoin_internal.streak_restore_orders WHERE payload=$1',[payload])).rows[0];
    if(!o?.charge_id||!['restored','refund_pending','refunded'].includes(o.status))fail('REFUND_NOT_AVAILABLE');
    if(o.status==='refunded')return {ok:true,duplicate:true};
    try{await callTelegram('refundStarPayment',{user_id:Number(o.telegram_id),telegram_payment_charge_id:o.charge_id});}
    catch(e){if(e.telegramCode!=='CHARGE_ALREADY_REFUNDED')throw e;}
    return settlement({from:{id:Number(o.telegram_id)},refunded_payment:{invoice_payload:o.payload,currency:'XTR',total_amount:RESTORE_STARS,telegram_payment_charge_id:o.charge_id}},true);
  }
  return {enabled,offer,invoice,status,precheckout,settlement,refundOrder,matches};
}
module.exports={createStreakRestore};
