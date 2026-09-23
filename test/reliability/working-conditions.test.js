// One repeatable matrix; every condition must have its own assertion and result.
const fs=require('fs'),path=require('path'),cp=require('child_process'),assert=require('assert/strict');
const root=path.resolve(__dirname,'../..'),out=path.join(root,'logs/reliability/conditions');fs.mkdirSync(out,{recursive:true});
const cases=[],suites=[];
for(const name of ['handoff','viewer','runtime']){
 const report=path.join(out,name+'.json');if(fs.existsSync(report))fs.unlinkSync(report);
 const result=cp.spawnSync(process.execPath,[path.join(__dirname,'conditions-'+name+'.test.js')],{cwd:root,encoding:'utf8',timeout:240000,maxBuffer:8*1024*1024});
 fs.writeFileSync(path.join(out,name+'.log'),(result.stdout||'')+(result.stderr||'')+(result.error?String(result.error):''));
 suites.push({name,status:result.status===0?'passed':'failed'});
 if(fs.existsSync(report))cases.push(...JSON.parse(fs.readFileSync(report,'utf8')).cases);
}
let complete=false;try{assert.equal(cases.length,50);assert.deepEqual(cases.map(c=>c.id).sort(),Array.from({length:50},(_,i)=>'C'+String(i+1).padStart(2,'0')));complete=true;}catch{}
const status=complete&&suites.every(s=>s.status==='passed')&&cases.every(c=>c.status==='passed')?'passed':'failed';
fs.writeFileSync(path.join(out,'report.json'),JSON.stringify({status,complete,suites,cases},null,2));
fs.writeFileSync(path.join(out,'matrix.md'),'# Fifty working conditions\n\n| ID | Working condition | Result |\n|---|---|---|\n'+cases.map(c=>`| ${c.id} | ${c.name} | ${c.status} |`).join('\n')+'\n');
console.log(JSON.stringify({status,conditions:cases.length,suites,report:path.join(out,'report.json')}));process.exitCode=status==='passed'?0:1;
