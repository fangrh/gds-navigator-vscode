'use strict';
const assert = require('assert/strict'), fs = require('fs'), os = require('os'), path = require('path');
const { buildSync } = require('esbuild');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gds-tracking-'));
const bundle = path.join(root, 'queue.cjs');
buildSync({ entryPoints: [path.join(__dirname, '../../src/instructionQueue.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: bundle });
const { InstructionQueue } = require(bundle);
const results = [];
function scenario(name, fn) { try { fn(); results.push({name,status:'passed'}); } catch(e) { results.push({name,status:'failed',error:e.message}); } }
function fixture() { const dir=fs.mkdtempSync(path.join(root,'case-')); const q=new InstructionQueue(dir); const source=path.join(dir,'source.py'); fs.writeFileSync(source,'x = 1\r\n'); const r=q.add({gdsPath:path.join(dir,'chip.gds'),request:{text:'Move selected pad',action:'move'},components:[]}); return {dir,q,source,id:r.id}; }
function failSave(q, action) {
  const original=fs.renameSync, before=fs.readFileSync(q.location), records=q.list();
  fs.renameSync=function(a,b){if(b===q.location)throw Error('Injected journal write failure');return original.apply(this,arguments);};
  try { assert.throws(action,/Injected/); } finally { fs.renameSync=original; }
  assert.deepEqual(fs.readFileSync(q.location),before,'failed save changed journal bytes');
  assert.deepEqual(q.list(),records,'failed save left phantom tracking state in memory');
  assert.deepEqual(new InstructionQueue(path.dirname(path.dirname(q.location))).list(),records);
}
scenario('failed start restores exact state and can retry',()=>{const {q,source,id}=fixture(); failSave(q,()=>q.start(id,[source])); q.start(id,[source]); assert.deepEqual(q.get(id).history.map(h=>h.event),['created','start']);});
scenario('failed completion restores note receipts and history',()=>{const {q,source,id}=fixture();q.start(id,[source]);fs.writeFileSync(source,'x = 2\r\n');failSave(q,()=>q.captureAfter(id,'validated'));q.captureAfter(id,'validated');assert.deepEqual(q.get(id).history.map(h=>h.event),['created','start','done']);});
scenario('legacy failed transition does not invent history',()=>{const {q,id}=fixture();const data=JSON.parse(fs.readFileSync(q.location));delete data.records[0].history;fs.writeFileSync(q.location,JSON.stringify(data));q.reload();failSave(q,()=>q.setStatus(id,'done','test'));});
scenario('deleted journal reload does not resurrect old records',()=>{const {q,id}=fixture();fs.unlinkSync(q.location);assert(q.reload());assert.equal(q.get(id),undefined);assert.equal(q.list().length,0);});
scenario('malformed reload cannot expose stale record as current',()=>{const {q,id}=fixture();fs.writeFileSync(q.location,'{broken');assert.equal(q.reload(),false);assert.throws(()=>q.get(id),/malformed|unavailable/);});
scenario('empty start does not claim captured sources',()=>{const {q,id}=fixture();const before=q.get(id);assert.throws(()=>q.start(id,[]),/source|file/i);assert.deepEqual(q.get(id),before);});
scenario('terminal completion cannot be duplicated or reopened',()=>{const {q,id}=fixture();q.setStatus(id,'done');const before=q.get(id);assert.throws(()=>q.setStatus(id,'done'),/open|transition|completed/i);assert.throws(()=>q.setStatus(id,'open'),/transition|reopen|terminal/i);assert.deepEqual(q.get(id),before);});
scenario('failed undo journal write restores all source bytes',()=>{const {q,source,id}=fixture();const second=path.join(path.dirname(source),'second.py');fs.writeFileSync(second,'y = 1\n');q.start(id,[source,second]);fs.writeFileSync(source,'x = 2\r\n');fs.writeFileSync(second,'y = 2\n');q.captureAfter(id);failSave(q,()=>q.revertSources(id,'undo'));assert.equal(fs.readFileSync(source,'utf8'),'x = 2\r\n');assert.equal(fs.readFileSync(second,'utf8'),'y = 2\n');q.revertSources(id);assert.equal(fs.readFileSync(source,'utf8'),'x = 1\r\n');});
scenario('comments remain separate and failed comment is rolled back',()=>{const {q,id,dir}=fixture();const before=q.get(id);failSave(q,()=>q.comment(id,'Adjust only this pad'));q.comment(id,'Adjust only this pad');const after=new InstructionQueue(dir).get(id);assert.deepEqual(after.request,before.request);assert.deepEqual(after.context,before.context);assert.equal(after.comments[0].text,'Adjust only this pad');assert.equal(after.history.at(-1).event,'comment');assert.throws(()=>q.comment(id,' '),/Comment/);});
scenario('busy journal rejects write without taking another lock',()=>{const {q,id}=fixture();const lock=path.join(path.dirname(q.location),'.instructions.lock');fs.writeFileSync(lock,'other writer');const before=q.get(id);assert.throws(()=>q.comment(id,'busy'),/busy/);assert.deepEqual(q.get(id),before);assert.equal(fs.readFileSync(lock,'utf8'),'other writer');fs.unlinkSync(lock);q.comment(id,'retry');assert(!fs.existsSync(lock));});
scenario('interleaved writer cannot overwrite a journal save',()=>{const {q,dir,id}=fixture();const other=new InstructionQueue(dir),rename=fs.renameSync;let checked=false;fs.renameSync=function(a,b){if(b===q.location&&!checked){checked=true;assert.throws(()=>other.comment(id,'concurrent'),/busy/);}return rename.apply(this,arguments);};try{q.comment(id,'winner');}finally{fs.renameSync=rename;}assert(checked);assert.equal(new InstructionQueue(dir).get(id).comments.length,1);other.reload();other.comment(id,'retry');assert.equal(new InstructionQueue(dir).get(id).comments.length,2);});
scenario('undo rollback failure identifies files requiring recovery',()=>{const {q,source,id}=fixture();q.start(id,[source]);fs.writeFileSync(source,'x = 2\r\n');q.captureAfter(id);const rename=fs.renameSync;let failedJournal=false;fs.renameSync=function(a,b){if(b===q.location){failedJournal=true;throw Error('Injected journal failure');}if(b===source&&failedJournal)throw Error('Injected rollback failure');return rename.apply(this,arguments);};try{assert.throws(()=>q.revertSources(id),e=>e.message.includes('rollback incomplete')&&e.message.includes(source));}finally{fs.renameSync=rename;}assert.equal(q.get(id).status,'done');assert.equal(new InstructionQueue(path.dirname(source)).get(id).status,'done');});
const out=path.join(__dirname,'../../logs/reliability/work-order-tracking');fs.mkdirSync(out,{recursive:true});
const report={status:results.every(r=>r.status==='passed')?'passed':'failed',results};
fs.writeFileSync(path.join(out,'faults.json'),JSON.stringify(report,null,2));
if(report.status==='failed'&&!fs.existsSync(path.join(out,'initial-faults.json')))fs.writeFileSync(path.join(out,'initial-faults.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));process.exitCode=report.status==='passed'?0:1;
