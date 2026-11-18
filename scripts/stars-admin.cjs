'use strict';
// Run on the backend host with its existing environment. Never paste credentials in chat.
const {pool,withTransaction}=require('../lib/db');
const {applyBalanceChangeTx}=require('../lib/ledger');
const {createStarsShop,telegramClient}=require('../lib/starsShop');
const {createStreakRestore}=require('../lib/streakRestore');
const {createVipPass}=require('../lib/vipPass');
const env=process.env,callTelegram=telegramClient(env);
const shop=createStarsShop({pool,withTransaction,applyBalanceChangeTx,env,callTelegram});
const restore=createStreakRestore({pool,withTransaction,env,callTelegram});
const vip=createVipPass({pool,withTransaction,env,callTelegram});
const yes=v=>/^(1|true)$/i.test(String(v||''));
async function main(){
 const [command,payload,confirm]=process.argv.slice(2);
 if(command==='status'){
  const bot=await callTelegram('getMe',{}),hook=await callTelegram('getWebhookInfo',{});
  const schema=await pool.query("SELECT to_regclass('jigcoin_internal.stars_orders') IS NOT NULL AS installed");
  console.log(JSON.stringify({bot_username:bot.username,stars_configured:shop.ready(),coin_public_sales_enabled:yes(env.COIN_PUBLIC_SALES_ENABLED),vip_public_sales_enabled:yes(env.VIP_PUBLIC_SALES_ENABLED),maintenance:yes(env.MAINTENANCE_MODE),release_cohort_enabled:yes(env.RELEASE_COHORT_ENABLED),schema_installed:schema.rows[0].installed,
    webhook_matches:hook.url===env.STARS_WEBHOOK_URL,pending_updates:hook.pending_update_count,allowed_updates:hook.allowed_updates,
    has_webhook_error:Boolean(hook.last_error_date)},null,2));return;
 }
 if(command==='configure-webhook'){
  if(!/^[A-Za-z0-9_-]{32,256}$/.test(env.TELEGRAM_WEBHOOK_SECRET||''))throw Error('Set TELEGRAM_WEBHOOK_SECRET to 32-256 allowed characters first.');
  const url=new URL(env.STARS_WEBHOOK_URL||'');
  if(url.protocol!=='https:'||url.pathname!=='/telegram/stars-webhook'||url.search||url.hash)throw Error('Invalid STARS_WEBHOOK_URL.');
  const hook=await callTelegram('getWebhookInfo',{});
  if(hook.url&&hook.url!==url.href)throw Error('A different webhook is already installed. Inspect it before replacing it.');
  await callTelegram('setWebhook',{url:url.href,secret_token:env.TELEGRAM_WEBHOOK_SECRET,drop_pending_updates:false,
    allowed_updates:[...new Set([...(hook.allowed_updates||[]),'message','pre_checkout_query'])]});
  const readback=await callTelegram('getWebhookInfo',{});
  if(readback.url!==url.href || !readback.allowed_updates?.includes('pre_checkout_query'))throw Error('Webhook readback did not match.');
  console.log('Webhook configured and verified. Sales flag was not changed.');return;
 }
 if(command==='refund' && confirm==='--confirm-refund'){
  console.log(JSON.stringify(await (vip.matches(payload)?vip:restore.matches(payload)?restore:shop).refundOrder(payload)));return;
 }
 throw Error('Usage: node scripts/stars-admin.cjs status | configure-webhook | refund ORDER_REFERENCE --confirm-refund');
}
main().catch(e=>{console.error(e.code||'Admin operation failed; check configuration and retry. No credentials are printed.');process.exitCode=1;}).finally(()=>pool.end());
