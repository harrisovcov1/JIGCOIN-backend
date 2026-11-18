'use strict';
// Local/admin utility. Default is validation only: no network or database access.
// Values are evidenced GBP totals for players' first 30 days, including later
// known refunds of those purchases. Never insert SDK estimates as actual income.
const fs=require('node:fs');
const fields=['purchase_gbp','refund_gbp','ads_gbp','direct_cost_gbp','acquisition_gbp','cash_received_gbp'];
function validate(row){
 if(!row||Array.isArray(row)||typeof row!=='object')throw Error('Expected one JSON object');
 const allowed=new Set(['cohort_day','source',...fields,'coverage_complete','evidence_ref','allocation_method']);
 if(Object.keys(row).some(k=>!allowed.has(k)))throw Error('Unrecognized finance field');
 if(!/^\d{4}-\d{2}-\d{2}$/.test(row.cohort_day||'')||!Number.isFinite(Date.parse(row.cohort_day))||new Date(row.cohort_day).toISOString().slice(0,10)!==row.cohort_day)throw Error('Invalid UTC cohort date');
 if(!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(row.source||''))throw Error('Invalid tracking source');
 for(const key of fields)if(row[key]!=null&&(typeof row[key]!=='string'||!/^\d{1,12}(?:\.\d{1,4})?$/.test(row[key])))throw Error(key+' must be a nonnegative decimal string, or null if unknown');
 if(typeof row.coverage_complete!=='boolean')throw Error('coverage_complete must be boolean');
 for(const key of ['evidence_ref','allocation_method'])if(row[key]!=null&&(typeof row[key]!=='string'||row[key].length>4000))throw Error('Invalid '+key);
 if(row.coverage_complete&&(fields.slice(0,5).some(k=>row[k]==null)||['evidence_ref','allocation_method'].some(k=>(row[k]||'').trim().length<10)))throw Error('Complete coverage requires all income/cost fields plus evidence and allocation explanation');
 return row;
}
async function main(){
 const file=process.argv[2],write=process.argv.includes('--write'),replace=process.argv.includes('--replace');
 if(!file)throw Error('Usage: node scripts/record-cohort-finance.cjs cohort.json [--write [--replace]]');
 const r=validate(JSON.parse(fs.readFileSync(file,'utf8')));
 if(!write){console.log('VALIDATED ONLY — no database connection or changes.');return;}
 if(!process.env.DATABASE_URL)throw Error('DATABASE_URL is required only for --write');
 const {pool}=require('../lib/db'); // Reuse the backend's existing connection/TLS settings.
 const c=await pool.connect();try{
  await c.query('BEGIN');
  await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',['finance:'+r.cohort_day+':'+r.source]);
  const cohort=(await c.query('SELECT players,contribution_window_elapsed FROM jigcoin_internal.release_scorecard_v13 WHERE cohort_day=$1 AND source=$2',[r.cohort_day,r.source])).rows[0];
  if(!cohort)throw Error('No recorded new-player cohort matches this source and UTC date');
  if(r.coverage_complete&&!cohort.contribution_window_elapsed)throw Error('All players must complete their first 30 days before marking evidence complete');
  const old=(await c.query('SELECT * FROM jigcoin_internal.cohort_finance_v13 WHERE cohort_day=$1 AND source=$2 FOR UPDATE',[r.cohort_day,r.source])).rows[0];
  if(old&&!replace)throw Error('An entry already exists. Keep its evidence; use --replace only for a reviewed correction or later refund.');
  await c.query(`INSERT INTO jigcoin_internal.cohort_finance_v13(cohort_day,source,purchase_gbp,refund_gbp,ads_gbp,direct_cost_gbp,acquisition_gbp,cash_received_gbp,coverage_complete,evidence_ref,allocation_method)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(cohort_day,source) DO UPDATE SET
   purchase_gbp=EXCLUDED.purchase_gbp,refund_gbp=EXCLUDED.refund_gbp,ads_gbp=EXCLUDED.ads_gbp,direct_cost_gbp=EXCLUDED.direct_cost_gbp,acquisition_gbp=EXCLUDED.acquisition_gbp,cash_received_gbp=EXCLUDED.cash_received_gbp,coverage_complete=EXCLUDED.coverage_complete,evidence_ref=EXCLUDED.evidence_ref,allocation_method=EXCLUDED.allocation_method,reconciled_at=clock_timestamp()`,[r.cohort_day,r.source,...fields.map(k=>r[k]??null),r.coverage_complete,r.evidence_ref??null,r.allocation_method??null]);
  await c.query('COMMIT');console.log('Saved evidenced cohort totals. No balances, prices or gameplay changed.');
 }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();await pool.end();}
}
if(require.main===module)main().catch(e=>{console.error(e.code?'Finance write failed: '+e.code:e.message);process.exitCode=1;});
module.exports={validate};
