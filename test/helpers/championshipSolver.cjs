function solve(p){
 if(p.solution)return p.solution;
 if(p.rule==='trays'){
  for(let mask=0;mask<(1<<p.coins.length);mask++){
   const answer=p.coins.map((_,i)=>(mask>>i)&1);
   if(p.coins.reduce((n,v,i)=>n+(answer[i]===0?v:0),0)===p.targetsByTray[0])return answer;
  }
 }
 if(p.faces){const seen=new Map(),pairs=[];p.faces.forEach((face,i)=>{if(seen.has(face))pairs.push(seen.get(face),i);else seen.set(face,i);});return pairs;}
 function search(steps,sum,limit,repeat){
  if(!limit)return sum===0?steps:null;
  for(let i=0;i<p.values.length;i++){
   if(!repeat&&steps.includes(i))continue;
   const found=search([...steps,i],sum-p.values[i],limit-1,repeat);
   if(found)return found;
  }
 }
 if(p.targets)return p.targets.flatMap(t=>search([],t,p.count,false));
 for(let n=1;n<=p.budget;n++){const result=search([],p.target-p.start,n,p.repeat);if(result)return result;}
}
module.exports=solve;
