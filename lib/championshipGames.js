'use strict';

const {randomInt} = require('node:crypto');
const names = [
 'Fast Pair','Exact Sum','Double Target','Symbol Recall','Reverse Recall','Position Recall',
 'Ascending','Alternating','Reverse','Mint Mark','Odd Symbol','Visual Difference',
 'Next Shape','Missing Tile','Rotation','Coin Flash','Group Count','Moving Count',
 'Coin Value','Mixed Categories','Changing Rules','Missing Digit','Logic Clue','Secret Sequence',
 'Exact Change','Fewest Moves','Target Total','Pair Match','Silhouette Match','Memory Pairs'
];
const instructions = [
 'Pick two coins that add up to the target.', 'Pick exactly three different coins for the total.', 'Solve two pair totals in the order shown.',
 'Memorise four symbols and repeat them.', 'Memorise four symbols and enter them backwards.', 'Follow the highlighted grid path, then replay it.',
 'Tap the numbers from low to high.', 'Count upward, alternating Sun and Moon.', 'Tap the numbers from high to low.',
 'Compare each coin with the reference stamp.', 'Find the shape outside the named group.', 'Compare corresponding positions in both panels.',
 'Choose the next shape in the pattern.', 'Choose the shape missing from the gap.', 'Rotate the arrow one quarter turn clockwise.',
 'Count the coins before the flash disappears.', 'Count only the requested shape.', 'Count round coins as they cross the line.',
 'Arrange the tray in ascending coin value.', 'Assign each symbol to its shape bucket.', 'Sort by shape first, then by finish.',
 'Find the missing digit in the pattern.', 'Choose the only code satisfying every clue.', 'Use the key to decode the symbols.',
 'Build the exact total with the available coins.', 'Make the total using the smallest number of coins.', 'Reach the target within two signed moves.',
 'Match the visible coin faces.', 'Match each solid shape with its outline.', 'Remember the board and complete three pairs within five turns.'
];
const glyphs = ['◆','●','▲','■'];
const arrows = ['↑','→','↓','←'];
const range = n => Array.from({length:n},(_,i)=>i);
function shuffle(items) {
 const out=[...items];
 for(let i=out.length-1;i>0;i--){const j=randomInt(i+1); [out[i],out[j]]=[out[j],out[i]];}
 return out;
}
function ordered(prompt, tiles, solution, extra={}) {
 return {prompt,tiles,rule:'order',solution,...extra};
}
function single(prompt, choices, answer, extra={}) {
 const tiles=shuffle(choices);
 return ordered(prompt,tiles,[tiles.indexOf(answer)],extra);
}
function puzzle(v) {
 const values=shuffle([1,2,3,4,5,6]);
 const symbols=shuffle(glyphs);
 const path=shuffle(range(9)).slice(0,4);
 const idx=randomInt(6);
 const digits=shuffle(range(9)).slice(0,3);
 const numeric=n=>String(n);
 if(v<3){
  const count=v===1?3:2, picks=shuffle(range(6));
  const target=picks.slice(0,count).reduce((a,i)=>a+values[i],0);
  const targets=[target];
  if(v===2) {
   const rest=picks.slice(2);
   const other=rest.slice(1).find(i=>values[rest[0]]+values[i]!==target);
   targets.push(values[rest[0]]+values[other]);
  }
  return {rule:'sum',prompt:'Choose '+count+' different coins per target. Complete targets in order. Tiles reset between targets.',tiles:values.map(numeric),values,targets,count};
 }
 if(v<=5){
  const seq=v===5?path:range(4).map(()=>randomInt(4));
  const tiles=v===5?range(9).map(i=>String(i+1)):symbols;
  return ordered(v===4?'Recall the symbols in reverse order.':v===5?'Recall the highlighted grid path.':'Recall the symbols in order.',tiles,v===4?[...seq].reverse():seq,{reveal:seq.map(i=>tiles[i]),grid:v===5});
 }
 if(v<=8 || v===18){
  const order=range(6).sort((a,b)=>values[a]-values[b]);
  if(v===8)order.reverse();
  if(v===7){
   const tiles=values.map(n=>(n%2?'Sun ':'Moon ')+n);
   tiles.push('Moon 1','Sun 2');
   return ordered('Start with Sun 1. Tap 1 through 6, alternating Sun and Moon.',tiles,order);
  }
  return ordered(v===18?'Build a mint tray from lowest coin value to highest.':v===8?'Tap every coin from highest to lowest.':'Tap every coin from lowest to highest.',values.map(numeric),order);
 }
 if(v<=11){
  const reference=range(6).map(()=>symbols[randomInt(4)]);
  const tiles=v===11?[...reference]:Array(6).fill(v===9?'J·':'Triangle ▲');
  tiles[idx]=v===9?'J:':v===10?'Square ■':symbols[(symbols.indexOf(tiles[idx])+1)%4];
  return ordered(v===9?'Find the altered mint stamp. Reference: J·':v===10?'All legitimate pieces are triangles. Find the outsider.':'Compare each position with the reference row. Tap the changed position.',tiles,[idx],v===11?{reference}:{});
 }
 if(v<=14){
  const i=randomInt(4);
  if(v===14)return single('Turn '+arrows[i]+' one quarter clockwise.',arrows,arrows[(i+1)%4]);
  return single(v===12?'Complete: '+[0,1,2,0,1].map(j=>symbols[j]).join(' '):'Fill the gap: '+[symbols[0],'?',symbols[2],symbols[0],symbols[1],symbols[2]].join(' '),symbols,symbols[v===12?2:1]);
 }
 if(v<=17){
  const n=randomInt(3,9);
  const scene=shuffle([...Array(n).fill('●'),...Array(v===15?0:randomInt(2,5)).fill('◆')]);
  return single(v===15?'Count the coins in the flash.':v===16?'Count only round coins.':'Count the round coins crossing the line.',range(8).map(i=>String(i+2)),String(n),
   v===16?{reference:scene}:v===17?{crossings:scene}:{reveal:scene,flash:true});
 }
 if(v===19 || v===20){
  const pieces=shuffle(['Light circle','Dark square','Dark circle','Light square']);
  const shape=pieces.map(p=>p.endsWith('circle')?0:1);
  const finish=pieces.map(p=>p.startsWith('Light')?2:3);
  return ordered('Assign the pieces from left to right to their shape buckets.',v===19?['Circle','Square']:['Circle','Square','Light','Dark'],v===19?shape:shape.concat(finish),{reference:pieces,switchAt:v===20?4:null});
 }
 if(v===21){const n=randomInt(2,6);return single('Complete: '+[n-2,n-1,'?',n+1].join(' · '),range(10).map(numeric),String(n));}
 if(v===22){const [a,b,c]=digits;return single('First digit '+a+', last digit '+c+', digit sum '+(a+b+c)+'.',[digits,[b,a,c],[a,c,b],[c,b,a]].map(d=>d.join('')),digits.join(''));}
 if(v===23){
  const seq=range(4).map(()=>randomInt(4));
  return ordered('Decode '+seq.map(i=>symbols[i]).join(' ')+' using the key.',range(4).map(numeric),seq,{reference:symbols.map((s,i)=>s+' = '+i)});
 }
 if(v===24 || v===25 || v===26){
  const vals=v===26?[1,3,-1,-3]:shuffle([1,1,2,3,4,5]);
  const start=v===26?randomInt(6,10):0;
  const target=v===26?start-2:randomInt(5,10);
  return {rule:'change',prompt:v===26?'Reach the target in at most two moves. Moves may repeat.':v===25?'Make exact change using the fewest coins.':'Make exact change. Use each coin at most once.',tiles:vals.map(String),values:vals,start,target,repeat:v===26,budget:v===26?2:vals.length,optimal:v===25};
 }
 if(v>=27 && v<=29){
  const faces=shuffle([...symbols.slice(0,3),...symbols.slice(0,3)]);
  if(v===28){
   const outline={'◆':'◇','●':'○','▲':'△','■':'□'};
   const tiles=shuffle(symbols.slice(0,3).flatMap(s=>[s,outline[s]]));
   return {rule:'pairs',prompt:'Match each solid coin to its outline.',tiles,faces:tiles.map(s=>symbols.find(g=>g===s||outline[g]===s))};
  }
  return {rule:'pairs',prompt:v===29?'Memorise pairs. Find all three within five turns.':'Select matching pairs until the tray is empty.',tiles:faces,faces,hidden:v===29,turns:v===29?5:3};
 }
 throw Error('Unknown championship variant');
}
function minimumCoins(values,target){
 const dp=Array(target+1).fill(Infinity);dp[0]=0;
 for(const value of values)for(let n=target;n>=value;n--)dp[n]=Math.min(dp[n],dp[n-value]+1);
 return dp[target];
}
function validate(p,actions){
 if(!Array.isArray(actions)||!actions.length||actions.length>20||
  actions.some(i=>!Number.isInteger(i)||i<0||i>=p.tiles.length))return false;
 if(p.rule==='order')return actions.length===p.solution.length && actions.every((a,i)=>a===p.solution[i]);
 if(p.rule==='sum')return actions.length===p.count*p.targets.length && p.targets.every((target,i)=>{
  const group=actions.slice(i*p.count,(i+1)*p.count);
  return new Set(group).size===group.length && group.reduce((n,j)=>n+p.values[j],0)===target;
 });
 if(p.rule==='change')return actions.length<=p.budget && (p.repeat||new Set(actions).size===actions.length) &&
  actions.reduce((n,i)=>n+p.values[i],p.start)===p.target && (!p.optimal||actions.length===minimumCoins(p.values,p.target));
 if(p.rule==='pairs'){
  if(actions.length%2 || actions.length>2*(p.turns||3))return false;
  const found=new Set();
  for(let i=0;i<actions.length;i+=2){
   const a=actions[i],b=actions[i+1];
   if(a===b||found.has(a)||found.has(b))return false;
   if(p.faces[a]===p.faces[b]){found.add(a);found.add(b);}
  }
  return found.size===p.faces.length;
 }
 return false;
}
function display(p){
 const {solution,faces,rule,...publicFields}=p;
 return {...publicFields,kind:rule,steps:solution?.length,tiles:p.hidden?p.tiles.map((_,i)=>String(i+1)):p.tiles,
  ...(p.hidden?{reveal:p.faces,grid:true,flash:true}:{})};
}
module.exports={names,instructions,puzzle,validate,display};
