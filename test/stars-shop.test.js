'use strict';
const {test,before,after,beforeEach}=require('node:test');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {createStarsShop}=require('../lib/starsShop');
const {applyBalanceChangeTx}=require('../lib/ledger');
let PGlite;try{({PGlite}=require(process.env.JIGCOIN_PGLITE_PATH||'@electric-sql/pglite'));}catch(_){}
const port=Number(process.env.JIGCOIN_TEST_POSTGRES_PORT || 0);
const run=port || PGlite ? test : test.skip;
let db,pool,user,service,env,calls,brokenLedger,network,clock;
const wrap=conn=>({query:async(s,a)=>{const r=await conn.query(s,a);return {...r,rowCount:r.rowCount??r.affectedRows??r.rows.length};}});
before(async()=>{
 if(!port && !PGlite)return;
 db=port ? await require("./helpers/localStarsDb.cjs")(port) : new PGlite();pool=wrap(db);
 await db.exec(`DO $$ BEGIN
 PERFORM pg_advisory_xact_lock(14142025);
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF;
 END $$;
 CREATE TABLE public.users(id bigint PRIMARY KEY,telegram_id bigint,balance bigint NOT NULL DEFAULT 0);
 CREATE TABLE public.user_balance_ledger(id bigserial PRIMARY KEY,user_id bigint,delta bigint,reason text,ref_type text,ref_id bigint,event_type text);`);
 const sql=fs.readFileSync(path.join(__dirname,'../sql/migrations/010_stars_shop.sql'),'utf8');
 await db.exec(sql);await db.exec(sql);
 // Shop analytics table is additive and private.
 await db.exec(`CREATE TABLE jigcoin_internal.shop_funnel_events_v24(
  id bigserial PRIMARY KEY,user_id bigint NOT NULL REFERENCES public.users(id),
  event_name text NOT NULL,sku text NOT NULL DEFAULT '',
  bucket_10m bigint NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id,event_name,sku,bucket_10m));`);
});
after(async()=>{if(db)await db.close();});
beforeEach(async()=>{
 if(!db)return;
 await db.exec('TRUNCATE jigcoin_internal.shop_funnel_events_v24,jigcoin_internal.stars_orders,jigcoin_internal.stars_offers,jigcoin_internal.stars_shop_visitors,public.user_balance_ledger,public.users RESTART IDENTITY CASCADE;');
 await pool.query('INSERT INTO public.users(id,telegram_id,balance) VALUES(1,10001,12000),(2,10002,0)');
 user={id:1,telegram_id:10001};calls=[];brokenLedger=false;network=false;clock=Date.now();
 env={STARS_SHOP_ENABLED:'1',RECOVERY_TEST_ENABLED:'1',RECOVERY_TEST_TELEGRAM_ID:'10001',TELEGRAM_WEBHOOK_SECRET:'a'.repeat(48),PAYMENT_SUPPORT_CONTACT:'support@example.test',STARS_WEBHOOK_URL:'https://example.test/telegram/stars-webhook'};
 service=createStarsShop({pool,env,now:()=>clock,withTransaction:fn=>db.transaction(tx=>fn(wrap(tx))),
 applyBalanceChangeTx:async(c,args)=>{const r=await applyBalanceChangeTx(c,args);if(brokenLedger)throw Error('injected ledger fault');return r;},
 callTelegram:async(method,body)=>{calls.push({method,body});if(network===true || network===method)throw Error('injected network fault');if(method==='getWebhookInfo')return {url:env.STARS_WEBHOOK_URL,allowed_updates:['pre_checkout_query','message']};if(method==='createInvoiceLink')return 'https://t.me/$fakeinvoice';return true;}});
});
async function order(sku='JC_SMALL'){await service.catalog(user);return service.invoice(user,sku);}
const query=(o,patch={})=>({id:'query-'+o.order_id,from:{id:10001},invoice_payload:o.order_id,currency:'XTR',total_amount:100,...patch});
const receipt=(o,patch={})=>({from:{id:10001},successful_payment:{invoice_payload:o.order_id,currency:'XTR',total_amount:100,telegram_payment_charge_id:'charge-'+o.order_id,...patch}});
async function counts(){return {balance:Number((await pool.query('SELECT balance FROM public.users WHERE id=1')).rows[0].balance),ledger:(await pool.query('SELECT * FROM public.user_balance_ledger')).rows.length};}
run('catalogue previews only active, permanent coin packs and starts no deadline',async()=>{
 env.STARS_SHOP_ENABLED='0';
 const c=await service.catalog(user,{preview:true});
 assert.deepEqual(c.products.map(p=>p.sku),['JC_SMALL','JC_MEDIUM','JC_LARGE']);
 assert.equal(c.enabled,false);
 assert.equal(c.offer_expires_at,null);
 await assert.rejects(service.invoice(user,'JC_SMALL'),{code:'SHOP_NOT_READY'});
});
run('starter offer is genuine, preview does not initiate it, and returning buyers are ineligible',async()=>{
 const preview=await service.catalog(user,{preview:true});
 assert.equal(preview.offer_expires_at,null);
 assert.equal((await pool.query('SELECT * FROM jigcoin_internal.stars_offers')).rows.length,0);
 const first=await service.catalog(user);
 assert.ok(first.products.some(p=>p.sku==='JC_STARTER'));
 assert.ok(Date.parse(first.offer_expires_at)>Date.now());
 const again=await service.catalog(user);
 assert.equal(again.offer_expires_at,first.offer_expires_at);
 assert.equal((await pool.query('SELECT * FROM jigcoin_internal.stars_offers')).rows.length,1);
 await service.invoice(user,'JC_STARTER');
 const paid=await service.invoice(user,'JC_SMALL');
 await service.precheckout(query(paid));
 await service.settlement(receipt(paid));
 const returning=await service.catalog(user);
 assert.ok(!returning.products.some(p=>p.sku==='JC_STARTER'));
 await assert.rejects(service.invoice(user,'JC_STARTER'),{code:'OFFER_ALREADY_USED'});
});
run('shop funnel interaction authenticates, validates, and deduplicates by 10-minute period',async()=>{
 await service.catalog(user);
 await service.interaction(user,{event:'pack_selected',sku:'JC_SMALL'});
 await service.interaction(user,{event:'pack_selected',sku:'JC_SMALL'});
 let rows=(await pool.query('SELECT * FROM jigcoin_internal.shop_funnel_events_v24')).rows;
 assert.equal(rows.length,1);
 await assert.rejects(service.interaction(user,{event:'fake',sku:''}),{code:'INVALID_EVENT'});
 await assert.rejects(service.interaction(user,{event:'pack_selected',sku:'JC_BAD'}),{code:'PRODUCT_UNAVAILABLE'});
 clock+=600001;
 await service.interaction(user,{event:'pack_selected',sku:'JC_SMALL'});
 rows=(await pool.query('SELECT * FROM jigcoin_internal.shop_funnel_events_v24')).rows;
 assert.equal(rows.length,2);
 env.STARS_SHOP_ENABLED='0';
 await assert.rejects(service.interaction(user,{event:'vip_opened'}),{code:'SHOP_NOT_READY'});
});
run('server prices and quantities form an XTR invoice; retry reuses order',async()=>{const a=await order(),b=await service.invoice(user,'JC_SMALL');assert.equal(a.order_id,b.order_id);const create=calls.find(c=>c.method==='createInvoiceLink');assert.equal(create.body.currency,'XTR');assert.equal(create.body.prices[0].amount,100);assert.equal((await counts()).ledger,0);});
run('wrong buyer, price, currency and expired invoice fail precheckout',async()=>{const o=await order();for(const patch of [{from:{id:10002}},{total_amount:1},{currency:'GBP'}]){await service.precheckout(query(o,patch));assert.equal(calls.at(-1).body.ok,false);}clock+=16*60000;await service.precheckout(query(o));assert.equal(calls.at(-1).body.ok,false);assert.equal((await counts()).ledger,0);});
run('precheckout approves once; same query retries but different query cannot charge twice',async()=>{const o=await order();await service.precheckout(query(o));assert.equal(calls.at(-1).body.ok,true);await service.precheckout(query(o));assert.equal(calls.at(-1).body.ok,true);await service.precheckout(query(o,{id:'second'}));assert.equal(calls.at(-1).body.ok,false);});
run('duplicate successful receipts credit exactly once and survive disabled sales',async()=>{const o=await order();await service.precheckout(query(o));env.STARS_SHOP_ENABLED='0';clock+=86400000;await service.settlement(receipt(o));await service.settlement(receipt(o));assert.deepEqual(await counts(),{balance:13000,ledger:1});});
run('parallel receipt delivery is serialized and does not double credit',async()=>{const o=await order();await service.precheckout(query(o));await Promise.all([service.settlement(receipt(o)),service.settlement(receipt(o))]);assert.deepEqual(await counts(),{balance:13000,ledger:1});});
run('ledger failure rolls back balance, receipt state and ledger; retry succeeds',async()=>{const o=await order();await service.precheckout(query(o));brokenLedger=true;await assert.rejects(service.settlement(receipt(o)));assert.deepEqual(await counts(),{balance:12000,ledger:0});assert.equal((await service.status(user,o.order_id)).order.status,'approved');brokenLedger=false;await service.settlement(receipt(o));assert.equal((await counts()).ledger,1);});
run('unapproved or mismatched successful payment cannot grant coins',async()=>{const o=await order();await assert.rejects(service.settlement(receipt(o)),{code:'PAYMENT_NOT_APPROVED'});await service.precheckout(query(o));await assert.rejects(service.settlement(receipt(o,{total_amount:101})),{code:'PAYMENT_MISMATCH'});assert.equal((await counts()).ledger,0);});
run('charge id cannot be reused on another order; transaction rolls back',async()=>{const a=await order();await service.precheckout(query(a));await service.settlement(receipt(a));const b=await order();await service.precheckout(query(b));await assert.rejects(service.settlement(receipt(b,{telegram_payment_charge_id:'charge-'+a.order_id})));assert.deepEqual(await counts(),{balance:13000,ledger:1});});
run('a previously approved starter purchase can still settle and refund once',async()=>{
 const id='a'.repeat(48);
 await pool.query(`INSERT INTO jigcoin_internal.stars_orders(user_id,telegram_id,sku,title,coins,stars,starter,payload,status,precheckout_id,expires_at)
 VALUES(1,10001,'JC_STARTER','Starter offer',1000,50,true,$1,'approved','old-approval',now())`,[id]);
 await service.settlement(receipt({order_id:id},{total_amount:50}));
 await service.refundOrder(id);
 await assert.rejects(service.invoice(user,'JC_STARTER'),{code:'OFFER_EXPIRED'});
 assert.deepEqual(await counts(),{balance:12000,ledger:2});
});
run('refund is recorded and reversed once, late successful receipt does not re-credit',async()=>{const o=await order();await service.precheckout(query(o));await service.settlement(receipt(o));await service.refundOrder(o.order_id);await service.refundOrder(o.order_id);await service.settlement(receipt(o));assert.deepEqual(await counts(),{balance:12000,ledger:2});});
run('refund before success prevents later fulfilment',async()=>{const o=await order();await service.precheckout(query(o));const r=receipt(o);await service.settlement({from:r.from,refunded_payment:r.successful_payment},true);await service.settlement(r);assert.deepEqual(await counts(),{balance:12000,ledger:0});});
run('spent refund leaves an explicit reconciliation amount, never negative balance',async()=>{const o=await order();await service.precheckout(query(o));await service.settlement(receipt(o));await pool.query('UPDATE public.users SET balance=200 WHERE id=1');await service.refundOrder(o.order_id);assert.equal((await counts()).balance,0);assert.equal(Number((await pool.query('SELECT unrecovered_coins FROM jigcoin_internal.stars_orders')).rows[0].unrecovered_coins),800);await assert.rejects(service.invoice(user,'JC_SMALL'),{code:'PAYMENT_SUPPORT_REQUIRED'});});
run('wrong user cannot read order or create invoice',async()=>{const o=await order();await assert.rejects(service.status({id:2},o.order_id),{code:'ORDER_NOT_FOUND'});await assert.rejects(service.invoice({id:2,telegram_id:10002},'JC_SMALL'),{code:'SHOP_NOT_READY'});});
run('webhook rejects missing, wrong and unicode secrets before handling a receipt',async()=>{let status;const res={status:s=>{status=s;return res;},json:()=>{}};for(const token of ['', 'b'.repeat(48),'é'.repeat(48)]){await service.webhook({headers:{'x-telegram-bot-api-secret-token':token},body:{}},res,()=>{throw Error('bypass');});assert.equal(status,401);}assert.equal((await counts()).ledger,0);});
run('webhook lookup network failure cannot open checkout or credit',async()=>{await service.catalog(user);network=true;await assert.rejects(service.invoice(user,'JC_SMALL'));assert.equal((await counts()).ledger,0);network=false;await service.invoice(user,'JC_SMALL');assert.equal((await counts()).ledger,0);});

run('lost invoice creation response is recoverable without duplicate orders or coins',async()=>{
 await service.catalog(user);network='createInvoiceLink';await assert.rejects(service.invoice(user,'JC_SMALL'));
 const rows=(await pool.query('SELECT * FROM jigcoin_internal.stars_orders')).rows;assert.equal(rows.length,1);assert.equal(rows[0].status,'created');
 network=false;const r=await service.invoice(user,'JC_SMALL');assert.equal(r.order_id,rows[0].payload);assert.deepEqual(await counts(),{balance:12000,ledger:0});
});
run('shop visitor measurement counts one viewer per UTC day and excludes preview',async()=>{
 env.STARS_SHOP_ENABLED='0';await service.catalog(user);assert.equal((await pool.query('SELECT * FROM jigcoin_internal.stars_shop_visitors')).rows.length,0);
 env.STARS_SHOP_ENABLED='1';await service.catalog(user);await service.catalog(user);assert.equal((await pool.query('SELECT * FROM jigcoin_internal.stars_shop_visitors')).rows.length,1);
});
run('paused product rejects checkout without balance changes',async()=>{
 const o=await order();await pool.query("UPDATE jigcoin_internal.stars_products SET active=false WHERE sku='JC_SMALL'");
 try{await service.precheckout(query(o));assert.equal(calls.at(-1).body.ok,false);assert.equal((await counts()).ledger,0);}
 finally{await pool.query("UPDATE jigcoin_internal.stars_products SET active=true WHERE sku='JC_SMALL'");}
});
run('client database roles cannot access payment records',async()=>{
 for(const role of ['anon','authenticated']) {
  await db.exec('SET ROLE '+role);
  try{await assert.rejects(pool.query('SELECT * FROM jigcoin_internal.stars_orders'));}
  finally{await db.exec('RESET ROLE');}
 }
});
run('real HTTP routes keep Stars owner-only and accept authenticated receipts during maintenance',async t=>{
 const {startIsolatedApp,signedInitData}=require('./helpers/httpApp.cjs');
 const app=await startIsolatedApp(t,true,{pool,starsService:service,env});
 const post=async(path,body,headers={})=>{
  const r=await fetch(app.url+path,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
  return {status:r.status,body:await r.json()};
 };
 for(const endpoint of ['catalog','invoice','status'])for(const initData of ['',signedInitData(10002),signedInitData(10001,{age:3700}),signedInitData(10001,{token:'forged'})]){
  const r=await post('/api/stars/'+endpoint,{initData,sku:'JC_SMALL'});assert.equal(r.status,503);assert.equal(r.body.error,'MAINTENANCE_MODE');
 }
 const auth=signedInitData();const catalog=await post('/api/stars/catalog',{initData:auth});assert.equal(catalog.body.enabled,true);
 const o=(await post('/api/stars/invoice',{initData:auth,sku:'JC_SMALL',stars:1,coins:999999})).body;assert.ok(o.order_id);
 const bad=await post('/telegram/stars-webhook',{message:receipt(o)});assert.equal(bad.status,401);
 const headers={'X-Telegram-Bot-Api-Secret-Token':env.TELEGRAM_WEBHOOK_SECRET};
 assert.equal((await post('/telegram/stars-webhook',{pre_checkout_query:query(o)},headers)).status,200);
 assert.equal((await post('/telegram/stars-webhook',{message:receipt(o)},headers)).status,200);
 assert.equal((await post('/telegram/stars-webhook',{message:receipt(o)},headers)).status,200);
 assert.deepEqual(await counts(),{balance:13000,ledger:1});
 assert.equal((await post('/api/stars/status',{initData:auth,order_id:o.order_id})).body.order.status,'paid');
 const stranger=await post('/telegram/stars-webhook',{message:{from:{id:10002},text:'/start'}},headers);assert.equal(stranger.status,200);
});
