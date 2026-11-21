'use strict';
const yes=v=>/^(1|true)$/i.test(String(v||''));
const validId=v=>/^[1-9]\d{0,15}$/.test(String(v||''))&&Number.isSafeInteger(Number(v));
const ids=value=>new Set(String(value||'').split(',').map(v=>v.trim()).filter(validId));
// One policy for catalogue, invoice creation and pre-checkout. Receipt handling
// deliberately does not use these gates: pausing sales must not lose a payment.
function createReleaseAccess(env,now=()=>Date.now()) {
 const testers=ids(env.RELEASE_COHORT_TELEGRAM_IDS);
 const owner=id=>yes(env.RECOVERY_TEST_ENABLED)&&validId(id)&&String(id)===String(env.RECOVERY_TEST_TELEGRAM_ID);
 const cohort=id=>yes(env.RELEASE_COHORT_ENABLED)&&validId(id)&&testers.has(String(id));
 const admitted=id=>owner(id)||cohort(id);
 const sell=(user,product)=>{
  if(!user||!validId(user.telegram_id)||user.is_system_user||new Date(user.banned_until).getTime()>now())return false;
  if(!yes(env.STARS_SHOP_ENABLED)||yes(env['DISABLE_'+product+'_SALES']))return false;
  if(!/^[A-Za-z0-9_-]{32,256}$/.test(String(env.TELEGRAM_WEBHOOK_SECRET||''))||String(env.PAYMENT_SUPPORT_CONTACT||'').trim().length<5)return false;
  if(yes(env.MAINTENANCE_MODE)&&!admitted(user.telegram_id))return false;
  return admitted(user.telegram_id)||yes(env[product+'_PUBLIC_SALES_ENABLED']);
 };
 return {owner,cohort,admitted,sell};
}
// The cohort takes the ordinary application routes. It does not get the owner's
// ad kill-switch override, free grants, or onboarding bypass.
const COHORT_PATHS=new Set([
 '/api/pilot/profile','/api/pilot/coin','/api/weekly/standings','/api/weekly/start','/api/weekly/answer',
 '/api/state','/api/config','/api/tapPacket','/api/task','/api/onboarding/complete',
 '/api/stars/catalog','/api/stars/catalog-preview','/api/stars/invoice','/api/stars/status','/api/stars/interaction',
 '/api/vip/overview','/api/vip/product','/api/vip/status','/api/vip/create-checkout','/api/vip/order-status',
 '/api/streak/restore/create-checkout','/api/streak/restore/status',
 '/api/mission/list','/api/mission/start','/api/mission/complete','/api/mission/outcome',
 '/api/progression','/api/progression/claim','/api/invite/summary','/api/invite/history','/api/invite/interaction',
 '/api/leaderboard/global','/api/leaderboard/window','/api/leaderboard/daily',
 '/api/leaderboard/friends','/api/leaderboard/history','/api/leaderboard/event'
]);
function cohortMiddleware({env,verifyTelegramInitData}) {
 const access=createReleaseAccess(env);
 return (req,_res,next)=>{
  if(req.method==='POST'&&COHORT_PATHS.has(req.path))try{
   const raw=req.body?.initData||req.headers['x-telegram-initdata'];
   if(typeof raw==='string'&&raw.length<=16384){
    const p=new URLSearchParams(raw),keys=[...p.keys()],age=Date.now()/1000-Number(p.get('auth_date'));
    if(new Set(keys).size===keys.length&&age>=-30&&age<=3600&&
       verifyTelegramInitData(raw,String(env.TELEGRAM_BOT_TOKEN||env.BOT_TOKEN||'').trim()).ok){
     const u=JSON.parse(p.get('user'));
     if(Number.isSafeInteger(u?.id)&&access.cohort(u.id))req.releaseCohortAllowed=true;
    }
   }
  }catch(_){}
  next();
 };
}
module.exports={createReleaseAccess,cohortMiddleware,ids};
