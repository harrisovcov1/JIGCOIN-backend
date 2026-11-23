// Loopback-only HTTP test harness. Uses the existing synthetic account fixture.
const helper=require('../test/helpers/httpApp.cjs');
(async()=>{
 const app=await helper.startIsolatedApp({after(){}},false,{
   env:{CHAMPIONSHIP_OWNER_PREVIEW_ID:'10001',CHAMPIONSHIP_V2:'0'},
   pool:{async query(s){return {rows:[],rowCount:s.startsWith('SELECT 1 FROM public.users')?1:0};}}
 });
 console.log(JSON.stringify({url:app.url,init:helper.signedInitData(10001)}));
})();
