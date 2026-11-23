// Creates private fixtures for the paired mobile renderer; production never imports this.
const fs=require('node:fs');
const {names,puzzle,validate,display}=require('../lib/championshipGames');
const solve=require('../test/helpers/championshipSolver.cjs');
if(process.argv[2]==='verify'){
 const boards=JSON.parse(fs.readFileSync(process.argv[3])),submitted=JSON.parse(fs.readFileSync(process.argv[4]));
 if(boards.length!==30||submitted.length!==30||!boards.every((r,i)=>r.name===submitted[i].name&&validate(r.private,submitted[i].actions)))throw Error('Rendered answers failed validation');
 console.log('30/30 rendered action sequences validated');
}else{
 const boards=names.map((name,variant)=>{const p=puzzle(variant);return {name,variant,board:display(p),actions:solve(p),private:p};});
 fs.writeFileSync(process.argv[2],JSON.stringify(boards));
}
