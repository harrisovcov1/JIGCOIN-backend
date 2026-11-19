'use strict';
const crypto = require('crypto');
const {createReleaseAccess}=require('./releaseAccess');
const yes = v => /^(1|true)$/i.test(String(v || ''));
const fail = (code, status=400) => Object.assign(new Error(code), {code,status});
const shortId = v => typeof v === 'string' && /^[a-f0-9]{48}$/.test(v);
function createStarsShop({pool,withTransaction,applyBalanceChangeTx,env,callTelegram,streakMilestones=[],streakRestore,vipPass,now=()=>Date.now()}) {
  const secret = String(env.TELEGRAM_WEBHOOK_SECRET || '');
  const support = String(env.PAYMENT_SUPPORT_CONTACT || '').trim();
  const ready = () => yes(env.STARS_SHOP_ENABLED) && /^[A-Za-z0-9_-]{32,256}$/.test(secret) && support.length >= 5;
  const access=createReleaseAccess(env,now);
  const enabledFor=user=>access.sell(user,'COIN');
  const authorize = user => {if (!enabledFor(user)) throw fail('SHOP_NOT_READY',503);};
  const lock = (c,id) => c.query('SELECT pg_advisory_xact_lock(hashtext($1))',['stars-shop:'+id]);
  async function catalog(user,{preview=false}={}) {
    const enabled = enabledFor(user);
    if(enabled && !preview)await pool.query(`INSERT INTO jigcoin_internal.stars_shop_visitors(user_id,visit_day)
      VALUES($1,(NOW() AT TIME ZONE 'UTC')::date) ON CONFLICT DO NOTHING`,[user.id]);
    // The five standard packs are the launch catalogue. Historical starter
    // receipts/offers remain in the database, but no new countdown is started.
    const [productRows,orderRows]=await Promise.all([
      pool.query(`SELECT sku,title,coins,stars,starter,featured,sort_order
        FROM jigcoin_internal.stars_products WHERE active=TRUE AND starter=FALSE ORDER BY sort_order,stars`),
      pool.query(`SELECT payload,sku,coins,stars,status,created_at FROM jigcoin_internal.stars_orders
        WHERE user_id=$1 ORDER BY id DESC LIMIT 5`,[user.id])
    ]);
    return {ok:true,enabled,telegram_id:Number(user.telegram_id),catalog_mode:preview?'preview':'visit',
      streak_milestones:streakMilestones,server_now:new Date(now()).toISOString(),support_contact:support,
      offer_expires_at:null,products:productRows.rows.map(p=>({...p,coins:Number(p.coins),stars:Number(p.stars)})),recent_orders:orderRows.rows};
  }
  async function invoice(user,sku) {
    authorize(user);
    if(typeof sku!=='string'||!/^JC_[A-Z0-9_]{1,40}$/.test(sku)) throw fail('INVALID_PRODUCT');
    // Do not accept money until Telegram is delivering confirmations to this service.
    const info=await callTelegram('getWebhookInfo',{});
    if(info.url !== String(env.STARS_WEBHOOK_URL || '') || !info.allowed_updates?.includes('pre_checkout_query') || !info.allowed_updates?.includes('message')) throw fail('CHECKOUT_NOT_READY',503);
    let order=await withTransaction(async c=>{
      await lock(c,user.id);
      const fresh=(await c.query('SELECT * FROM public.users WHERE id=$1 FOR UPDATE',[user.id])).rows[0];
      if(!fresh||String(fresh.telegram_id)!==String(user.telegram_id))throw fail('ACCOUNT_UNAVAILABLE',403);
      authorize(fresh);
      const debt=(await c.query('SELECT 1 FROM jigcoin_internal.stars_orders WHERE user_id=$1 AND unrecovered_coins>0 LIMIT 1',[user.id])).rows.length;
      if(debt) throw fail('PAYMENT_SUPPORT_REQUIRED',409);
      const p=(await c.query('SELECT * FROM jigcoin_internal.stars_products WHERE sku=$1 AND active=TRUE',[sku])).rows[0];
      if(!p) throw fail('PRODUCT_UNAVAILABLE',409);
      if(p.starter)throw fail('PRODUCT_UNAVAILABLE',409);
      await c.query("UPDATE jigcoin_internal.stars_orders SET status='expired' WHERE user_id=$1 AND ((status IN ('created','invoiced') AND expires_at<=NOW()) OR (status='approved' AND expires_at+interval '15 minutes'<=NOW()))",[user.id]);
      const existing=(await c.query("SELECT * FROM jigcoin_internal.stars_orders WHERE user_id=$1 AND sku=$2 AND status IN ('created','invoiced','approved') ORDER BY id DESC LIMIT 1",[user.id,sku])).rows[0];
      if(existing)return existing;
      let expires=now()+15*60000;
      return (await c.query(`INSERT INTO jigcoin_internal.stars_orders(user_id,telegram_id,sku,title,coins,stars,starter,payload,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,[user.id,user.telegram_id,p.sku,p.title,p.coins,p.stars,p.starter,crypto.randomBytes(24).toString('hex'),new Date(expires)])).rows[0];
    });
    if(order.status==='approved') throw fail('PAYMENT_PENDING',409);
    if(!order.invoice_url) {
      const url=await callTelegram('createInvoiceLink',{title:order.title,description:`${Number(order.coins).toLocaleString('en-GB')} in-game coins. No cash value or guaranteed airdrop.`,payload:order.payload,provider_token:'',currency:'XTR',prices:[{label:order.title,amount:Number(order.stars)}]});
      if(typeof url!=='string'||!/^https:\/\/t\.me\/\$/.test(url)) throw fail('INVOICE_UNAVAILABLE',503);
      order=(await pool.query(`UPDATE jigcoin_internal.stars_orders SET invoice_url=COALESCE(invoice_url,$2),status=CASE WHEN status='created' THEN 'invoiced' ELSE status END WHERE id=$1 RETURNING *`,[order.id,url])).rows[0];
    }
    return {ok:true,order_id:order.payload,url:order.invoice_url};
  }
  async function status(user,payload) {
    if(!shortId(payload))throw fail('INVALID_ORDER');
    await pool.query("UPDATE jigcoin_internal.stars_orders SET status='expired' WHERE user_id=$1 AND payload=$2 AND ((status IN ('created','invoiced') AND expires_at<=NOW()) OR (status='approved' AND expires_at+interval '15 minutes'<=NOW()))",[user.id,payload]);
    const row=(await pool.query('SELECT payload,coins,stars,status,created_at FROM jigcoin_internal.stars_orders WHERE payload=$1 AND user_id=$2',[payload,user.id])).rows[0];
    if(!row)throw fail('ORDER_NOT_FOUND',404);
    return {ok:true,order:row};
  }
  async function precheckout(q) {
    let allowed=false;
    try {
      if(!ready() || !shortId(q.invoice_payload))throw fail('UNAVAILABLE');
      const known=(await pool.query('SELECT * FROM jigcoin_internal.stars_orders WHERE payload=$1',[q.invoice_payload])).rows[0];
      if(!known)throw fail('ORDER_NOT_FOUND');
      allowed=await withTransaction(async c=>{
        await lock(c,known.user_id);
        const user=(await c.query('SELECT * FROM public.users WHERE id=$1 FOR UPDATE',[known.user_id])).rows[0];
        if(!user||!enabledFor(user))return false;
        const o=(await c.query('SELECT * FROM jigcoin_internal.stars_orders WHERE payload=$1 FOR UPDATE',[q.invoice_payload])).rows[0];
        if(String(o.telegram_id)!==String(q.from.id)||q.currency!=='XTR'||q.total_amount!==Number(o.stars)||!['invoiced','approved'].includes(o.status))return false;
        if(o.status==='approved')return o.precheckout_id===q.id;
        if(new Date(o.expires_at).getTime()<=now())return false;
        if(!(await c.query('SELECT sku FROM jigcoin_internal.stars_products WHERE sku=$1 AND active=TRUE',[o.sku])).rows.length)return false;
        if(o.starter && (await c.query("SELECT 1 FROM jigcoin_internal.stars_orders WHERE user_id=$1 AND starter=TRUE AND id<>$2 AND status IN ('approved','paid','refunded') LIMIT 1",[o.user_id,o.id])).rows.length)return false;
        await c.query("UPDATE jigcoin_internal.stars_orders SET status='approved',precheckout_id=$2 WHERE id=$1",[o.id,q.id]);
        return true;
      });
    }catch(_){allowed=false;}
    await callTelegram('answerPreCheckoutQuery',{pre_checkout_query_id:q.id,ok:allowed,...(!allowed?{error_message:'This order is unavailable or expired. Reopen the Coin Shop to try again.'}:{})});
    return {ok:true};
  }
  async function settlement(message,refund=false) {
    const p=refund?message.refunded_payment:message.successful_payment;
    if(!p || !shortId(p.invoice_payload) || typeof p.telegram_payment_charge_id!=='string' || !p.telegram_payment_charge_id)throw fail('INVALID_PAYMENT');
    const known=(await pool.query('SELECT * FROM jigcoin_internal.stars_orders WHERE payload=$1',[p.invoice_payload])).rows[0];
    if(!known)throw fail('UNKNOWN_PAYMENT',409);
    return withTransaction(async c=>{
      await lock(c,known.user_id);
      const o=(await c.query('SELECT * FROM jigcoin_internal.stars_orders WHERE payload=$1 FOR UPDATE',[p.invoice_payload])).rows[0];
      if(String(message.from?.id)!==String(o.telegram_id)||p.currency!=='XTR'||p.total_amount!==Number(o.stars))throw fail('PAYMENT_MISMATCH',409);
      if(o.charge_id && o.charge_id!==p.telegram_payment_charge_id)throw fail('CHARGE_MISMATCH',409);
      if(refund) {
        if(o.status==='refunded')return {ok:true,duplicate:true};
        let recovered=0;
        if(o.status==='paid') {
          const u=(await c.query('SELECT balance FROM public.users WHERE id=$1 FOR UPDATE',[o.user_id])).rows[0];
          recovered=Math.min(Math.max(0,Number(u.balance)),Number(o.coins));
          if(recovered)await applyBalanceChangeTx(c,{userId:o.user_id,delta:-recovered,reason:'stars_refund',refType:'stars_order',refId:o.id,eventType:'spend'});
        }
        const debt=o.status==='paid'?Number(o.coins)-recovered:0;
        await c.query("UPDATE jigcoin_internal.stars_orders SET status='refunded',charge_id=$2,refunded_at=NOW(),unrecovered_coins=$3 WHERE id=$1",[o.id,p.telegram_payment_charge_id,debt]);
        return {ok:true,refunded:true};
      }
      if(['paid','refunded'].includes(o.status))return {ok:true,duplicate:true};
      // A genuine successful receipt is fulfilled even if its invoice expired or sales were paused in transit.
      if(!o.precheckout_id)throw fail('PAYMENT_NOT_APPROVED',409);
      await applyBalanceChangeTx(c,{userId:o.user_id,delta:Number(o.coins),reason:'stars_purchase',refType:'stars_order',refId:o.id,eventType:'purchase_credit'});
      await c.query("UPDATE jigcoin_internal.stars_orders SET status='paid',charge_id=$2,paid_at=NOW() WHERE id=$1",[o.id,p.telegram_payment_charge_id]);
      return {ok:true,credited:true};
    });
  }
  async function refundOrder(payload) {
    if(!shortId(payload))throw fail('INVALID_ORDER');
    const o=(await pool.query('SELECT * FROM jigcoin_internal.stars_orders WHERE payload=$1',[payload])).rows[0];
    if(!o||!o.charge_id||!['paid','refunded'].includes(o.status))throw fail('REFUND_NOT_AVAILABLE');
    if(o.status==='refunded')return {ok:true,duplicate:true};
    try { await callTelegram('refundStarPayment',{user_id:Number(o.telegram_id),telegram_payment_charge_id:o.charge_id}); }
    catch(e) {if(e.telegramCode!=='CHARGE_ALREADY_REFUNDED')throw e;}
    return settlement({from:{id:Number(o.telegram_id)},refunded_payment:{invoice_payload:o.payload,currency:'XTR',total_amount:Number(o.stars),telegram_payment_charge_id:o.charge_id}},true);
  }
  const handler=fn=>async(req,res)=>{
    res.set('Cache-Control','no-store');
    try{return res.json(await fn(req));}catch(e){console.error('Stars operation failed',{code:e.code||'INTERNAL'});return res.status(e.status||503).json({ok:false,error:e.status?(e.code||(e.status===401?'UNAUTHORIZED':'INVALID_REQUEST')):'SHOP_TEMPORARILY_UNAVAILABLE'});}
  };
  const webhook=async(req,res,next)=>{
    const actual=String(req.headers['x-telegram-bot-api-secret-token']||'');
    if(!/^[A-Za-z0-9_-]{32,256}$/.test(secret)||Buffer.byteLength(actual)!==Buffer.byteLength(secret)||!crypto.timingSafeEqual(Buffer.from(actual),Buffer.from(secret)))return res.status(401).json({ok:false});
    try {
      const u=req.body||{};
      if(vipPass?.matches(u.pre_checkout_query?.invoice_payload))await vipPass.precheckout(u.pre_checkout_query);
      else if(vipPass?.matches(u.message?.successful_payment?.invoice_payload))await vipPass.settlement(u.message);
      else if(vipPass?.matches(u.message?.refunded_payment?.invoice_payload))await vipPass.settlement(u.message,true);
      else if(u.pre_checkout_query)await (streakRestore?.matches(u.pre_checkout_query.invoice_payload)?streakRestore.precheckout(u.pre_checkout_query):precheckout(u.pre_checkout_query));
      else if(u.message?.successful_payment)await (streakRestore?.matches(u.message.successful_payment.invoice_payload)?streakRestore.settlement(u.message):settlement(u.message));
      else if(u.message?.refunded_payment)await (streakRestore?.matches(u.message.refunded_payment.invoice_payload)?streakRestore.settlement(u.message,true):settlement(u.message,true));
      else if(/^\/(paysupport|terms)(@\w+)?(?:\s|$)/.test(u.message?.text||'')) {
        await callTelegram('sendMessage',{chat_id:u.message.chat.id,text:`JigCoin purchases grant the stated in-game coins, streak restore or VIP benefits, not cash or guaranteed airdrop value. For payment help or refunds, contact ${support || 'the app owner'}. Include your order reference from Shop, Vault or Daily streak. Do not send passwords or bot tokens.`});
      } else return next();
      return res.json({ok:true});
    } catch(e){console.error('Stars webhook failed',{code:e.code||'INTERNAL'});return res.status(503).json({ok:false,error:'PAYMENT_PROCESSING_RETRY'});}
  };
  return {catalog,invoice,status,precheckout,settlement,refundOrder,webhook,handler,ready};
}
function telegramClient(env) {
  const fetch=require('node-fetch');
  return async(method,body)=>{
    const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),7000);
    try{
      const token=String(env.BOT_TOKEN||'');
      if(!token)throw fail('BOT_NOT_CONFIGURED',503);
      const r=await fetch(`https://api.telegram.org/bot${token}/${method}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:controller.signal});
      const result=await r.json();
      if(!result.ok) {const e=fail('TELEGRAM_UNAVAILABLE',503);e.telegramStatus=result.error_code;e.retryAfter=result.parameters?.retry_after;if(result.description?.includes('CHARGE_ALREADY_REFUNDED'))e.telegramCode='CHARGE_ALREADY_REFUNDED';throw e;}
      return result.result;
    }finally{clearTimeout(timer);}
  };
}
module.exports={createStarsShop,telegramClient};
