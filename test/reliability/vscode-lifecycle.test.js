// Real VS Code + rendered webview journeys, isolated from user windows and designs.
const fs=require('fs'),path=require('path'),os=require('os'),cp=require('child_process'),assert=require('assert');
const puppeteer=require('puppeteer-core');
const setupEnvMode=process.argv.includes('--setup-env');
const provenanceRoot=process.env.GDS_VERIFY_PROJECT;
const autoEnvMode=process.argv.includes('--auto-env')||setupEnvMode;
const root=path.resolve(__dirname,'../..'),routeMode=process.argv.includes('--routes'),instructionMode=process.argv.includes('--instructions'),primitiveMode=process.argv.includes('--primitives'),usageMode=process.argv.includes('--usage'),fileLinksMode=process.argv.includes('--file-links'),workOrdersMode=process.argv.includes('--work-orders'),multiImageMode=process.argv.includes('--multi-image'),handoffMode=routeMode||instructionMode||process.argv.includes('--handoff')||multiImageMode||primitiveMode,output=path.join(root,'logs/reliability',provenanceRoot?'user-provenance-vscode':autoEnvMode?'auto-env-vscode':workOrdersMode?'work-orders-vscode':usageMode?'usage-vscode':routeMode?'routes-vscode':instructionMode?'instructions-vscode':primitiveMode?'primitives-vscode':fileLinksMode?'file-links-vscode':multiImageMode?'multi-image-vscode':handoffMode?'handoff-vscode':'vscode');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,timeout=60000){const end=Date.now()+timeout;let error;while(Date.now()<end){try{const v=await fn();if(v)return v;}catch(e){error=e;}await sleep(150);}throw new Error('Timed out: '+(error?.message||String(fn)));}
async function main(){
 fs.mkdirSync(output,{recursive:true});
 fs.writeFileSync(path.join(output,'report.json'),JSON.stringify({status:'running',startedAt:new Date().toISOString()}));
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gds-vscode-')),workspace=path.join(dir,'workspace'),bridge=path.join(dir,'bridge');
 fs.mkdirSync(workspace);fs.mkdirSync(bridge);
 const driver=path.join(dir,'driver');fs.mkdirSync(driver);fs.writeFileSync(path.join(driver,'package.json'),JSON.stringify({name:'gds-test-driver',publisher:'local',version:'0.0.1',engines:{vscode:'^1.75.0'},activationEvents:['*'],main:'main.js'}));
 fs.writeFileSync(path.join(driver,'main.js'),fs.readFileSync(path.join(__dirname,'vscode-host.js'),'utf8')+'\nexports.activate = () => { exports.run().then(() => require("vscode").commands.executeCommand("workbench.action.closeWindow")); };');fs.mkdirSync(path.join(workspace,'.vscode'));
 fs.writeFileSync(path.join(workspace,'.vscode/settings.json'),JSON.stringify({...(autoEnvMode?{}:{'gdsNavigator.pythonPath':path.join(provenanceRoot||root,'.venv-fork/Scripts/python.exe')}),'window.restoreWindows':'none','workbench.startupEditor':'none','security.workspace.trust.enabled':false}));
 const files=Array.from({length:provenanceRoot||usageMode||workOrdersMode?2:10},(_,i)=>path.join(workspace,`chip-${i+1}.gds`));
 files.forEach((file,i)=>{const source=provenanceRoot?path.join(provenanceRoot,`jj_pad_center_${i===0?50:100}_test.gds`):path.join(root,handoffMode?'logs/reliability/handoff-demo/layout.gds':'test/fixtures/jj_pad_center_100_test.gds');fs.copyFileSync(source,file);if(handoffMode||provenanceRoot)fs.copyFileSync(source.replace(/\.gds$/,'.provenance.json'),file.replace(/\.gds$/,'.provenance.json'));});
 const builder=path.join(workspace,'generate-layout.py');
 if(fileLinksMode){
   files[0]=path.join(dir,'external output.gds');
   fs.writeFileSync(builder,`from pathlib import Path\nPath(${JSON.stringify(files[0])}).write_bytes(Path(${JSON.stringify(path.join(root,'test/fixtures/jj_pad_center_100_test.gds'))}).read_bytes())\n`);
 }
 const exe=process.env.VSCODE_EXE||'C:/Program Files/Microsoft VS Code/Code.exe';
 const records=[];let id=0;
 async function request(action,extra={}){const req={id:++id,action,...extra};fs.writeFileSync(path.join(bridge,'request.json'),JSON.stringify(req));return until(()=>{const r=JSON.parse(fs.readFileSync(path.join(bridge,'response.json'),'utf8'));if(r.id!==req.id)return false;if(r.error)throw new Error(r.error);return {value:r.result};});}
 for(let cycle=0;cycle<(setupEnvMode?3:provenanceRoot||usageMode||workOrdersMode||handoffMode?1:3);cycle++){
   for(const name of ['ready.json','request.json','response.json'])try{fs.unlinkSync(path.join(bridge,name));}catch{}
   const port=19330+cycle;
   const child=cp.spawn(exe,[workspace,'--new-window','--disable-workspace-trust','--skip-welcome','--skip-release-notes',`--user-data-dir=${path.join(dir,'profile')}`,`--extensions-dir=${path.join(dir,'extensions')}`,`--extensionDevelopmentPath=${root}`,`--extensionDevelopmentPath=${driver}`,`--remote-debugging-port=${port}`],{env:{...process.env,...(autoEnvMode?{VIRTUAL_ENV:path.join(root,'.venv-fork')}:{}),GDS_TEST_BRIDGE:bridge},windowsHide:true,stdio:['ignore','pipe','pipe']});
   let log='';child.stdout.on('data',b=>log+=b);child.stderr.on('data',b=>log+=b);
   let browser;
   try {
     await until(()=>fs.existsSync(path.join(bridge,'ready.json')),90000);
     browser=await until(()=>puppeteer.connect({browserURL:`http://127.0.0.1:${port}`,defaultViewport:null}));
     async function reconnect(){await browser.disconnect();browser=await puppeteer.connect({browserURL:`http://127.0.0.1:${port}`,defaultViewport:null,protocolTimeout:15000});}
     async function frameFor(file){return until(async()=>{for(const page of await browser.pages())for(const frame of page.frames()){try{if(await frame.evaluate(p=>typeof currentGdsPath!=='undefined'&&currentGdsPath.toLowerCase()===p.toLowerCase()&&typeof allFeatures!=='undefined'&&allFeatures.length>0,file))return frame;}catch{}}return false;});}
     for(let i=0;i<files.length;i++){
       if(fileLinksMode&&i===0&&cycle===0){await request('source',{file:builder});await request('build');}
       else await request('open',{file:files[i]});
       await reconnect();let frame=await frameFor(files[i]);
       if(provenanceRoot){
         await sleep(500);await reconnect();frame=await frameFor(files[i]);
         assert.equal(await frame.$eval('#mode-indicator',e=>e.textContent),'Provenance: ON');
         const detail=await frame.evaluate(()=>{
           const feature=allFeatures.find(f=>String(f.get('layer'))==='4/0')||allFeatures[0];replaceSelection([feature]);onSelectionChanged();
           return {features:allFeatures.length,tracked:allFeatures.filter(f=>f.get('provenance')?.file).length,source:feature.get('provenance')};
         });
         assert.equal(detail.features,1818);assert.equal(detail.tracked,1818);assert(detail.source.file.includes(`generate_jj_pad_center_${i===0?50:100}.py`));
         await frame.click('#copy-btn');await until(async()=>{const text=(await request('clipboard')).value;return text.includes('GDS_PROVENANCE')&&text.includes('generate_jj_pad_center_');});
         fs.writeFileSync(path.join(output,`provenance-${i}.yaml`),(await request('clipboard')).value);
         await until(()=>frame.evaluate(()=>{
           if(map.getView().getAnimating())return false;
           for(const canvas of document.querySelectorAll('.ol-layer canvas')){
             const context=canvas.getContext('2d');if(!context)continue;
             const pixels=context.getImageData(0,0,canvas.width,canvas.height).data;let colored=0;
             for(let j=0;j<pixels.length;j+=16)if(pixels[j+3]>128&&Math.max(pixels[j],pixels[j+1],pixels[j+2])-Math.min(pixels[j],pixels[j+1],pixels[j+2])>40)colored++;
             if(colored>100)return true;
           }
           return false;
         }));
         await frame.page().screenshot({path:path.join(output,`provenance-${i}.png`)});
         records.push({scenario:'actual-user-layout-provenance',status:'passed',...detail});
         continue;
       }
       if(setupEnvMode&&i===0){
         if(cycle===0){
           const page=frame.page();
           await until(()=>page.evaluate(()=>document.body.innerText.includes('Set up GDS Python')));
           await request('notifications');
           await until(()=>page.evaluate(()=>Array.from(document.querySelectorAll('.monaco-button')).some(e=>e.textContent.trim()==='Use this environment')));
           await page.screenshot({path:path.join(output,'project-environment-prompt.png')});
           await page.evaluate(()=>Array.from(document.querySelectorAll('.monaco-button')).find(e=>e.textContent.trim()==='Use this environment').click());
           await until(()=>fs.existsSync(path.join(workspace,'.gds-navigator/environment.json')));
           const saved=JSON.parse(fs.readFileSync(path.join(workspace,'.gds-navigator/environment.json'),'utf8'));
           assert.equal(path.resolve(saved.python).toLowerCase(),path.join(root,'.venv-fork/Scripts/python.exe').toLowerCase());
           assert(fs.readFileSync(path.join(workspace,'AGENTS.md'),'utf8').includes('gds-python.cmd'));
           assert(fs.existsSync(path.join(workspace,'gds-python.cmd')));
           await until(()=>JSON.parse(fs.readFileSync(path.join(workspace,'.vscode/settings.json'),'utf8'))['gdsNavigator.pythonPath']===saved.python);
           await page.screenshot({path:path.join(output,'project-environment-saved.png')});
         }else{
           assert(fs.existsSync(path.join(workspace,'.gds-navigator/environment.json')));
           await sleep(2500);
           assert(!await frame.page().evaluate(()=>Array.from(document.querySelectorAll('.monaco-button')).some(e=>e.textContent.trim()==='Use this environment')),'setup prompt repeated after reopen');
         }
       }
       if(setupEnvMode&&cycle>0){
         await frame.evaluate(()=>{replaceSelection([allFeatures[0]]);onSelectionChanged();});
         await frame.click('#copy-btn');
         await until(async()=>{const text=(await request('clipboard')).value;return text.includes('GDS_PROVENANCE')&&text.includes('.venv-fork');});
         records.push({scenario:'saved-environment-window-reopen',cycle,file:i,status:'passed'});
         continue;
       }
       if(workOrdersMode){
         if(i===0){
           await sleep(500);await reconnect();frame=await frameFor(files[i]);
           console.log('Review journey: context menu and bookmark');
           await frame.evaluate(()=>{replaceSelection([allFeatures[0]]);document.getElementById('map').focus();});
           await frame.page().keyboard.down('Shift');await frame.page().keyboard.press('F10');await frame.page().keyboard.up('Shift');
           await frame.waitForSelector('#canvas-context-menu',{visible:true});
           assert(await frame.$eval('#canvas-context-menu [data-action="new-work-order"]',e=>!e.hidden));
           await frame.click('#canvas-context-menu [data-action="new-work-order"]');
           assert.equal(await frame.evaluate(()=>document.activeElement.id),'intent-text');
           await until(()=>frame.$eval('#review-status',e=>e.textContent.includes('loaded')));
           await frame.evaluate(()=>reviewTools.open('bookmarks'));
           await frame.type('#review-bookmark-name','Keep pad view');await frame.click('#review-bookmark-save');
           await until(()=>frame.$eval('#review-status',e=>e.textContent.includes('saved')));
           console.log('Review journey: bookmark saved');
         }
         if(i===1)assert.equal(await frame.$$('#review-bookmark-list input').then(x=>x.length),0,'bookmark leaked to another GDS');
         const requirement=i===0?'Keep file A open for the next validated edit.':'Complete file B independently after checking this requirement.';
         await frame.evaluate((text)=>{replaceSelection([allFeatures[0]]);onSelectionChanged();document.getElementById('intent-text').value=text;document.getElementById('intent-text').dispatchEvent(new Event('input',{bubbles:true}));},requirement);
         await frame.click('#queue-instruction');
         await until(()=>frame.evaluate(()=>document.getElementById('queue-instruction').disabled===false));
         await frame.evaluate(()=>{const panel=document.getElementById('instruction-list');if(panel.hidden)document.getElementById('instruction-list-btn').click();});
         await until(()=>frame.evaluate(()=>document.querySelectorAll('#instruction-records article').length===1));
         const card=await frame.$('#instruction-records article');
         const orderId=await card.evaluate(el=>el.dataset.workOrderId);
         assert(orderId&&/^INS-/.test(orderId),'work-order reference missing');
         assert((await card.evaluate(el=>el.innerText)).includes(requirement),'requirement missing from acknowledged card');
         if(i===0){
           const targetId=await frame.evaluate(()=>allFeatures[0].get('elementId'));
           await frame.click('#instruction-records article .work-order-title');
           await until(()=>frame.evaluate(id=>selectedFeatures.getLength()===1&&selectedFeatures.item(0).get('elementId')===id&&document.getElementById('workflow-status').textContent.includes('Highlighted'),targetId));
           const commentText='A comment persisted with file A only.';
           await frame.type('#instruction-records article .work-order-comment-input',commentText);
           await frame.click('#instruction-records article .work-order-comment-submit');
           await until(()=>frame.evaluate(text=>document.querySelector('#instruction-records article').innerText.includes(text),commentText));
           await frame.click('#instruction-records article button[data-action="copyRef"]');
           const copied=await until(async()=>{const value=(await request('clipboard')).value;fs.writeFileSync(path.join(output,'file-a-copy-ref-raw.txt'),value||'');return value.includes(orderId)&&value.includes(requirement)?value:false;});
           const parsedCopy=JSON.parse(cp.execFileSync('python',['-c','import sys,yaml,json;print(json.dumps(yaml.safe_load(sys.stdin.read())))'],{input:copied,encoding:'utf8',env:{...process.env,PYTHONUTF8:'1'}}));
           assert.equal(path.normalize(parsedCopy.document.path).toLowerCase(),path.normalize(files[0]).toLowerCase(),'clipboard reference targeted another GDS');
           assert.equal(parsedCopy.instructions[0].id,orderId);assert.equal(parsedCopy.instructions[0].requirement,requirement);
           fs.writeFileSync(path.join(output,'file-a-copy-ref.yaml'),copied);
           records.push({scenario:'file-a-add-select-requirement-ack-copy-ref',status:'passed',id:orderId});
         } else {
           await frame.click('#instruction-records article button[data-action="done"]');
           await until(()=>frame.evaluate(id=>{const el=document.querySelector(`[data-work-order-id="${id}"]`);return el?.dataset.status==='done';},orderId));
           await frame.$eval('#work-order-search',(el,text)=>{el.value=text;el.dispatchEvent(new Event('input',{bubbles:true}));},requirement.slice(0,18));
           await until(()=>frame.evaluate(()=>document.querySelectorAll('#instruction-records article').length===1&&document.querySelector('#instruction-records article').dataset.status==='done'));
           await frame.select('#work-order-filter','open');
           await until(()=>frame.evaluate(()=>document.querySelector('#instruction-records').textContent.includes('No matching orders')));
           await frame.select('#work-order-filter','all');
           await frame.$eval('#work-order-search',el=>{el.value='';el.dispatchEvent(new Event('input',{bubbles:true}));});
           records.push({scenario:'file-b-independent-fifo-done-search-filter',status:'passed',id:orderId});
         }
         await request('close');await request('open',{file:files[i]});await reconnect();frame=await frameFor(files[i]);await frame.evaluate(()=>{const panel=document.getElementById('instruction-list');if(panel.hidden)document.getElementById('instruction-list-btn').click();});
         await until(()=>frame.evaluate(()=>document.querySelectorAll('#instruction-records article').length===1));
         assert.equal(await frame.evaluate(()=>document.querySelector('#instruction-records article').dataset.status),i===0?'open':'done');
         if(i===0)assert((await frame.evaluate(()=>document.querySelector('#instruction-records article').innerText)).includes('A comment persisted with file A only.'));
         if(i===1)assert(!(await frame.evaluate(()=>document.querySelector('#instruction-records article').innerText)).includes('A comment persisted with file A only.'),'comment crossed into another GDS');
         if(i===1){await frame.evaluate(()=>{map.updateSize();map.renderSync();});await sleep(500);await frame.page().screenshot({path:path.join(output,'work-orders-persistence-b.png')});}
         if(i===1){
           await request('open',{file:files[0]});await reconnect();const frameA=await frameFor(files[0]);await frameA.evaluate(()=>{const panel=document.getElementById('instruction-list');if(panel.hidden)document.getElementById('instruction-list-btn').click();});
           await until(()=>frameA.evaluate(()=>document.querySelectorAll('#instruction-records article').length===1));
           assert.equal(await frameA.evaluate(()=>document.querySelector('#instruction-records article').dataset.status),'open');
           assert((await frameA.evaluate(()=>document.querySelector('#instruction-location').textContent)).includes('chip-1.gds'),'GDS queue crossed documents');
           await frameA.page().screenshot({path:path.join(output,'work-orders-persistence-a.png')});
           // Draw with the real toolbar, rebuild the same GDS through Python, then reopen.
           const originalOrder=await frameA.evaluate(()=>lastWorkOrderMessage.records[0].id);
           await frameA.click('.work-order-title');
           await frameA.click('.tool-btn[data-mode="rectangle"]');
           const canvas=await (await frameA.$('#map')).boundingBox();
           await frameA.page().mouse.click(canvas.x+canvas.width*.60,canvas.y+canvas.height*.30);
           await frameA.page().mouse.move(canvas.x+canvas.width*.72,canvas.y+canvas.height*.42);
           await frameA.page().mouse.click(canvas.x+canvas.width*.72,canvas.y+canvas.height*.42);
           await until(()=>frameA.evaluate(()=>drawSource.getFeatures().length===1&&lastWorkOrderMessage.records.length===2));
           const beforeBuild=await frameA.evaluate(()=>({hash:currentLayoutHash,annotation:drawSource.getFeatures()[0].get('annotationId'),geometry:exactGeometry(drawSource.getFeatures()[0]),orders:lastWorkOrderMessage.records.map(r=>r.id)}));
           fs.writeFileSync(builder,`import klayout.db as kdb\np = ${JSON.stringify(files[0])}\nl = kdb.Layout()\nl.read(p)\nl.top_cell().shapes(l.layer(77, 0)).insert(kdb.Box(120000,120000,121000,121000))\nl.write(p)\n`);
           if(autoEnvMode)fs.appendFileSync(builder,`import sys, json, gdsfactory.provenance as provenance\nfrom pathlib import Path\nPath(${JSON.stringify(path.join(workspace,'environment-used.json'))}).write_text(json.dumps({'executable': sys.executable, 'provenance': callable(getattr(provenance.ProvenanceTracker, 'write_sidecar', None))}))\n`);
           await request('source',{file:builder});await request('build');await request('open',{file:files[0]});await reconnect();let rebuilt=await frameFor(files[0]);
           await until(()=>rebuilt.evaluate(old=>currentLayoutHash!==old&&drawSource.getFeatures().length===1,beforeBuild.hash));
           if(autoEnvMode){const used=JSON.parse(fs.readFileSync(path.join(workspace,'environment-used.json'),'utf8'));assert(used.provenance,'auto-selected interpreter lacks provenance');assert.equal(path.resolve(used.executable).toLowerCase(),path.join(root,'.venv-fork/Scripts/python.exe').toLowerCase());fs.writeFileSync(path.join(output,'environment-used.json'),JSON.stringify(used,null,2));}
           if(autoEnvMode&&!setupEnvMode){
             const page=rebuilt.page(),input='.quick-input-widget input';
             await request('environmentPicker');await page.waitForSelector(input,{visible:true});
             await page.type(input,'Enter Python path');await page.keyboard.press('Enter');
             await until(()=>page.$eval('.quick-input-widget',e=>e.textContent.includes('Full path')));
             await page.type(input,path.join(root,'.venv-fork/Scripts/python.exe'));await page.keyboard.press('Enter');
             await until(()=>page.$eval('.statusbar',e=>e.textContent.includes('GDS Python: manual')));
             await page.screenshot({path:path.join(output,'manual-python.png')});
             await request('environmentPicker');await page.waitForSelector(input,{visible:true});
             await page.type(input,'Automatic');await page.keyboard.press('Enter');
             await until(()=>page.$eval('.statusbar',e=>e.textContent.includes('GDS Python: auto · provenance')));
             await page.screenshot({path:path.join(output,'automatic-python.png')});
           }
           await until(()=>rebuilt.evaluate(id=>lastWorkOrderMessage?.records.find(r=>r.id===id)?.tracking?.status==='relinked',originalOrder));
           await until(()=>rebuilt.$eval('#review-diff-info',e=>/1 added/.test(e.textContent)));
           assert.equal(await rebuilt.$eval('#review-bookmark-list input',e=>e.value),'Keep pad view','bookmark lost after rebuild');
           await rebuilt.evaluate(()=>reviewTools.open('compare'));await rebuilt.click('#review-diff-show');
           await rebuilt.page().screenshot({path:path.join(output,'review-after-rebuild.png')});
           assert.deepEqual(await rebuilt.evaluate(()=>exactGeometry(drawSource.getFeatures()[0])),beforeBuild.geometry,'rebuild changed drawing geometry');
           assert.equal(await rebuilt.evaluate(()=>drawSource.getFeatures()[0].get('annotationId')),beforeBuild.annotation);
           assert.deepEqual(await rebuilt.evaluate(()=>lastWorkOrderMessage.records.map(r=>r.id)),beforeBuild.orders);
           assert(await rebuilt.evaluate(id=>lastWorkOrderMessage.records.find(r=>r.id===id).comments.length===1,originalOrder));
           await rebuilt.evaluate(()=>{if(document.getElementById('instruction-list').hidden)document.getElementById('instruction-list-btn').click();edaWorkbench.activate('changes');});
           await rebuilt.click(`[data-work-order-id="${originalOrder}"] .work-order-title`);
           assert.deepEqual(await rebuilt.evaluate(()=>selectedFeatures.getArray().map(f=>f.get('elementId'))),await rebuilt.evaluate(id=>lastWorkOrderMessage.records.find(r=>r.id===id).tracking.targetIds,originalOrder));
           await request('close');await request('open',{file:files[0]});await reconnect();rebuilt=await frameFor(files[0]);
           await until(()=>rebuilt.evaluate(id=>drawSource.getFeatures().some(f=>f.get('annotationId')===id),beforeBuild.annotation));
           await rebuilt.evaluate(()=>{if(document.getElementById('instruction-list').hidden)document.getElementById('instruction-list-btn').click();map.updateSize();map.renderSync();});await sleep(300);
           await request('hidePanel');await reconnect();rebuilt=await frameFor(files[0]);await rebuilt.click('#fit-btn');await sleep(600);await rebuilt.evaluate(()=>{map.updateSize();map.renderSync();});
           await rebuilt.page().screenshot({path:path.join(output,'work-orders-after-rebuild.png')});
           records.push({scenario:'real-python-rebuild-preserves-drawings-orders-comments-and-target-links',status:'passed'});

         }
         continue;
       }
       if(fileLinksMode&&i===0){
         assert.equal(path.normalize(await frame.evaluate(()=>currentPythonFile)).toLowerCase(),path.normalize(builder).toLowerCase());
         await frame.click('#open-python');
         await until(async()=> (await request('tabs')).value.includes('generate-layout.py'));
         await request('open',{file:files[i]});await reconnect();frame=await frameFor(files[i]);
         await frame.click('#related-files');
         await until(async()=>{for(const page of await browser.pages()){if(await page.evaluate(()=>document.body.innerText.includes('Related files — Python, layouts and images')))return true;}return false;});
         await frame.page().screenshot({path:path.join(output,`related-files-cycle-${cycle+1}.png`)});
         await frame.page().keyboard.press('Escape');
       }
       if(handoffMode)await until(()=>frame.evaluate(()=>{
         if(!Number.isFinite(map.getView().getResolution())||map.getView().getAnimating())return false;
         for(const canvas of document.querySelectorAll('.ol-layer canvas')){const ctx=canvas.getContext('2d');if(!ctx)continue;const data=ctx.getImageData(0,0,canvas.width,canvas.height).data;let colored=0;for(let n=0;n<data.length;n+=16){if(data[n+3]>128&&Math.max(data[n],data[n+1],data[n+2])-Math.min(data[n],data[n+1],data[n+2])>40)colored++;}if(colored>100)return true;}return false;
       }));
       if(i===0&&!handoffMode){
         if(cycle===0){await request('image',{file:path.join(root,'test/fixtures/electrode100-microscope.png')});await until(()=>frame.evaluate(()=>!!microImg&&!!microLayer));await frame.evaluate(()=>autoAlignMicroImage());}
         await until(()=>frame.evaluate(()=>microImg?.quality?.status==='aligned'));
         await sleep(500); // Allow prior layout fit animations to settle before checking restored pixels.
         assert(await frame.evaluate(()=>microLayer.getZIndex()<(vectorLayer.getZIndex()||0)));
         try { await until(()=>frame.evaluate(()=>{
           if(!Number.isFinite(map.getView().getResolution()))return false;
           for(const c of document.querySelectorAll('.ol-layer canvas')){const ctx=c.getContext('2d');if(!ctx)continue;const d=ctx.getImageData(0,0,c.width,c.height).data;let green=0;for(let n=0;n<d.length;n+=32){if(d[n]<150&&d[n+1]>180&&d[n+2]<150&&d[n+3]>128)green++;}if(green>Math.max(30,Math.min(400,c.width*c.height/500)))return true;}return false;
         })); } catch (error) {
           fs.writeFileSync(path.join(output,`image-render-diagnostic-cycle-${cycle+1}.json`),JSON.stringify(await frame.evaluate(()=>({
             image:microImg&&{cx:microImg.cx,cy:microImg.cy,quality:microImg.quality,visible:microImg.visible,opacity:microImg.opacity,display:microImg.display},
             mapSize:map.getSize(),resolution:map.getView().getResolution(),layerExtent:microLayer?.getSource()?.getImageExtent(),
             canvases:[...document.querySelectorAll('.ol-layer canvas')].map(c=>({width:c.width,height:c.height})),
           })),null,2));
           await frame.page().screenshot({path:path.join(output,`image-render-diagnostic-cycle-${cycle+1}.png`)});
           throw error;
         }
       }
       if(usageMode&&i===0){
         const automaticPath=path.join(workspace,'.gds-navigator','usage-report.json');
         await until(()=>{if(!fs.existsSync(automaticPath))return false;const report=JSON.parse(fs.readFileSync(automaticPath,'utf8'));return report.totalEvents>0&&report.malformedEvents===0;},20000);
         records.push({scenario:'automatic-report-without-agent-or-review-command',status:'passed'});
         const page=frame.page(); await frame.click('#usage-logs'); await sleep(700); await page.screenshot({path:path.join(output,'usage-menu.png')}); await request('escapeQuickPick');
         await frame.evaluate(()=>document.getElementById('fit-btn').click()); await frame.evaluate(()=>document.getElementById('route-btn').click()); await page.keyboard.press('Escape'); await sleep(700);
         const usageDir=path.join(workspace,'.gds-navigator','usage'); const readEvents=()=>fs.readdirSync(usageDir).filter(n=>n.startsWith('session-')&&n.endsWith('.jsonl')).flatMap(n=>fs.readFileSync(path.join(usageDir,n),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse));
         await request('reviewUsage'); await until(()=>fs.existsSync(path.join(workspace,'.gds-navigator','usage-report.json'))); let events=readEvents(); assert(events.some(e=>e.action==='ui.control'&&e.control==='fit-btn'&&e.documentId));
         await request('open',{file:files[i]}); await reconnect(); frame=await frameFor(files[i]);
         const fitCount=()=>readEvents().filter(e=>e.action==='ui.control'&&e.control==='fit-btn').length; const pausedCount=fitCount(); await request('usageEnabled',{value:false,file:workspace}); await frame.evaluate(()=>document.getElementById('fit-btn').click()); await sleep(700); await request('reviewUsage'); assert.equal(fitCount(),pausedCount,'paused logging emitted a fit event');
         await request('usageEnabled',{value:true,file:workspace}); await request('open',{file:files[i]}); await reconnect(); frame=await frameFor(files[i]); await frame.evaluate(()=>document.getElementById('fit-btn').click()); await sleep(700); await request('reviewUsage'); assert(fitCount()>pausedCount,'resumed logging did not emit a fit event');
         records.push({scenario:'real-usage-menu-controls-report-pause-resume',status:'passed',events:events.length,documentIds:[...new Set(events.filter(e=>e.documentId).map(e=>e.documentId))]});
       }
       if(usageMode&&i===1){ await frame.evaluate(()=>document.getElementById('fit-btn').click()); await sleep(700); await request('reviewUsage'); const usageDir=path.join(workspace,'.gds-navigator','usage'); const events=fs.readdirSync(usageDir).filter(n=>n.startsWith('session-')&&n.endsWith('.jsonl')).flatMap(n=>fs.readFileSync(path.join(usageDir,n),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)); assert(new Set(events.filter(e=>e.documentId).map(e=>e.documentId)).size>=2,'usage identities did not distinguish both documents'); }
       if(usageMode) continue;
       if(cycle===0&&i===0){
         const page=frame.page();const outer=await page.evaluate(()=>{const f=Array.from(document.querySelectorAll('iframe')).find(f=>f.src.startsWith('vscode-webview:')&&f.getBoundingClientRect().width>0);if(!f)throw Error('Visible webview not found');const r=f.getBoundingClientRect();return {x:r.x,y:r.y};});
         const button=await frame.evaluate(()=>{const r=document.querySelector('.tool-btn[data-mode=rectangle]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};});
         await page.mouse.click(outer.x+button.x,outer.y+button.y);const inner=await frame.evaluate(()=>{const r=document.getElementById('map').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};});const box={...inner,x:outer.x+inner.x,y:outer.y+inner.y};
         await page.mouse.click(box.x+box.width*.55,box.y+box.height*.35);await page.mouse.move(box.x+box.width*.7,box.y+box.height*.55);await page.mouse.click(box.x+box.width*.7,box.y+box.height*.55);
         await until(()=>frame.evaluate(()=>drawSource.getFeatures().length===1));
       }
       await frame.evaluate(({cycle,i})=>{
         if(cycle===0){var f=i===0?drawSource.getFeatures()[0]:new ol.Feature({geometry:new ol.geom.Polygon([[[1.000123,2],[9,2],[9,8],[1.000123,2]]])});f.set('isDrawn',true);f.set('annotationId','test-annotation-'+i);f.set('shapeType','polygon');f.set('intent',{action:'move',text:'File '+i,targetIds:[allFeatures[0].get('elementId')],snapshot:currentLayoutHash});if(i!==0)drawSource.addFeature(f);persistAnnotations();}
         if(drawSource.getFeatures().length!==1)throw Error('Annotation restore or file isolation failure');
         selectedFeatures.clear();selectedFeatures.push(allFeatures[0]);selectedFeatures.push(drawSource.getFeatures()[0]);
         postSelectedComponents(selectedFeatures.getArray());
       },{cycle,i});
       if(routeMode&&i===0){
         await frame.click('#route-btn');const canvas=await (await frame.$('#map')).boundingBox();
         for(const [x,y] of [[.2,.2],[.35,.3],[.45,.2]])await frame.page().mouse.click(canvas.x+canvas.width*x,canvas.y+canvas.height*y);
         await frame.page().keyboard.press('Enter');
         await until(()=>frame.evaluate(()=>drawSource.getFeatures().some(f=>f.get('route'))));
         assert(await frame.evaluate(()=>{var f=drawSource.getFeatures().find(f=>f.get('route'));return ManhattanRoute.validate(f.getGeometry().getCoordinates())&&f.get('intent').targetIds.length>0;}));
         await frame.evaluate(()=>{map.getTargetElement().focus();});await frame.page().keyboard.press('Tab');
         await frame.$eval('#route-width',el=>{el.value='3.25';});await frame.click('#route-apply');
         await until(()=>frame.evaluate(()=>drawSource.getFeatures().find(f=>f.get('route'))?.get('route').width===3.25));
         await frame.click('#copy-btn');
         await until(async()=>{const text=(await request('clipboard')).value;return text.includes('route_convention')&&text.includes('Manhattan centerline')&&text.includes('3.25');});
         fs.writeFileSync(path.join(output,'route.yaml'),(await request('clipboard')).value);
         await frame.page().screenshot({path:path.join(output,'manhattan-route.png')});
         const routeId=await frame.evaluate(()=>drawSource.getFeatures().find(f=>f.get('route')).get('annotationId'));
         await request('close');await request('open',{file:files[i]});await reconnect();frame=await frameFor(files[i]);
         await until(()=>frame.evaluate(id=>drawSource.getFeatures().some(f=>f.get('annotationId')===id&&f.get('route')?.width===3.25),routeId));
         await frame.evaluate(id=>{replaceSelection([drawSource.getFeatures().find(f=>f.get('annotationId')===id)]);onSelectionChanged();deleteDrawn();},routeId);
         await until(()=>frame.evaluate(()=>drawSource.getFeatures().length===1));
         records.push({scenario:'actual-route-button-waypoints-tuning-copy-editor-reopen',status:'passed'});
       }
       if(instructionMode&&i===0){
         assert.equal(await frame.$('#insert-gds-shape'),null);
         assert(await frame.evaluate(()=>document.getElementById('instruction-bar').getBoundingClientRect().top>=document.getElementById('map-row').getBoundingClientRect().bottom-1));
         await frame.evaluate(()=>{replaceSelection([drawSource.getFeatures()[0]]);onSelectionChanged();map.getTargetElement().focus();});
         await frame.page().keyboard.press('Tab');
         await until(()=>frame.evaluate(()=>shapeProperties.isOpen()));
         await frame.evaluate(()=>{document.querySelector('#shape-properties [data-field=rotation]').value='30';Array.from(document.querySelectorAll('#shape-properties button')).find(b=>b.textContent==='Apply').click();});
         assert.equal(await frame.evaluate(()=>drawSource.getFeatures()[0].get('editRotation')),30);
         await frame.click('#shape-properties button[aria-label="Close shape properties"]');
         await frame.click('#instruction-list-btn');
         await until(()=>frame.evaluate(()=>document.querySelectorAll('#instruction-records article').length>0));
         await frame.click('#copy-open-instructions');
         await until(async()=> (await request('clipboard')).value.includes('gds-navigator.instructions'));
         fs.writeFileSync(path.join(output,'open-instructions.yaml'),(await request('clipboard')).value);
         await frame.click('#instructions-close');
         await frame.click('#shape-menu-btn');
         await until(()=>frame.evaluate(()=>document.querySelectorAll('#component-catalog [role=option]').length>100));
         await frame.type('#component-catalog input[type=search]','bend_circular');
         await frame.evaluate(()=>{const b=Array.from(document.querySelectorAll('#component-catalog [role=option]')).find(b=>b.textContent.startsWith('bend_circular('));if(!b)throw Error('Factory absent');b.click();});
         await frame.evaluate(()=>Array.from(document.querySelectorAll('#component-catalog button')).find(b=>b.textContent==='Preview component').click());
         await until(()=>frame.evaluate(()=>Array.from(document.querySelectorAll('#component-catalog button')).some(b=>b.textContent==='Insert at view center'&&!b.hidden)));
         await frame.evaluate(()=>Array.from(document.querySelectorAll('#component-catalog button')).find(b=>b.textContent==='Insert at view center').click());
         await until(()=>frame.evaluate(()=>drawSource.getFeatures().some(f=>f.get('factory')?.name==='bend_circular')));
         await frame.click('#instruction-list-btn');
         await until(()=>frame.evaluate(()=>Array.from(document.querySelectorAll('#instruction-records pre')).some(p=>p.textContent.includes('bend_circular'))));
         await frame.page().screenshot({path:path.join(output,'factory-instruction-review.png')});
         await frame.evaluate(()=>Array.from(document.querySelectorAll('#instruction-records button[data-action=revert]')).at(-1).click());
         await until(()=>frame.evaluate(()=>drawSource.getFeatures().length===1&&!drawSource.getFeatures().some(f=>f.get('factory'))));
         await frame.click('#instructions-close');
         records.push({scenario:'bottom-composer-real-catalog-FIFO-reference-copy-and-proposal-revert',status:'passed'});
       }
       if(handoffMode&&i===0){
         const expected=await frame.evaluate(()=>{const pad=allFeatures.find(f=>f.get('provenance').instance_name==='pad_r1_c2');selectedFeatures.clear();selectedFeatures.push(pad);onSelectionChanged();document.getElementById('intent-action').value='move';document.getElementById('intent-text').value='Move only pad_r1_c2 +3 um in x, 0 um in y.';return {id:pad.get('elementId'),geometry:exactGeometry(pad)};});
         async function exported(text){await request('copy');return until(async()=>{const {value}=await request('clipboard');if(!value.includes(text))return false;return JSON.parse(cp.execFileSync('python',['-c','import sys,yaml,json;print(json.dumps(yaml.safe_load(sys.stdin.read())))'],{input:value,encoding:'utf8',env:{...process.env,PYTHONUTF8:'1'}}));});}
         const direct=await exported('Move only pad_r1_c2');assert.deepEqual(direct.request.target_ids,[expected.id]);assert.deepEqual(direct.elements[0].provenance.loop_index,[1,2]);assert.equal(direct.elements.length,1);
         fs.writeFileSync(path.join(output,'direct-instance.yaml'),(await request('clipboard')).value);
         await frame.evaluate(id=>{const d=drawSource.getFeatures()[0];d.set('intent',{action:'move',text:'Move the linked pad into this region.',targetIds:[id],snapshot:currentLayoutHash});selectedFeatures.clear();selectedFeatures.push(d);onSelectionChanged();},expected.id);
         const linked=await exported('Move the linked pad');assert.equal(linked.elements.length,0);assert.deepEqual(linked.referenced_elements[0].geometry,expected.geometry);assert.equal(linked.handoff.status,'context_complete');
         fs.writeFileSync(path.join(output,'drawing-only.yaml'),(await request('clipboard')).value);
         records.push({scenario:'real-fork-single-instance-and-drawing-only-handoff',status:'passed'});
       }
       await request('copy');
       await until(async()=>{const {value}=await request('clipboard');fs.writeFileSync(path.join(output,'last-clipboard-check.json'),JSON.stringify({file:files[i],cycle,i,clipboard:value},null,2));return typeof value==='string'&&value.toLowerCase().includes(files[i].replace(/\\/g,'\\\\').toLowerCase())&&value.includes('test-annotation-'+i);});
       if(primitiveMode&&i===0){
         await frame.click('#shape-menu-btn');await frame.click('[data-shape=taper]');
         await frame.evaluate(()=>{document.getElementById('primitive-length').value='25.123456';document.getElementById('primitive-width1').value='3.5';document.getElementById('primitive-width2').value='12.75';document.getElementById('primitive-layer').value='4/2';document.getElementById('primitive-rotation').value='-35';});
         await frame.click('#primitive-center');
         await until(()=>frame.evaluate(()=>drawSource.getFeatures().length===2&&selectedFeatures.getLength()===1));
         await request('copy');
         const yaml=(await until(async()=>{const {value}=await request('clipboard');return value.includes('construction_recipe')?{value}:false;})).value;
         fs.writeFileSync(path.join(output,'taper-request.yaml'),yaml);
         const doc=JSON.parse(cp.execFileSync('python',['-c','import sys,json,yaml; print(json.dumps(yaml.safe_load(sys.stdin.read())))'],{input:yaml,encoding:'utf8',windowsHide:true}));
         const proposal=doc.annotations[0];assert.equal(proposal.action,'add');assert.equal(proposal.instruction,'');assert.equal(doc.request.text,'');assert.equal(proposal.primitive.kind,'taper');assert.equal(proposal.primitive.length,25.123456);assert.deepEqual(proposal.construction_recipe.layer,[4,2]);assert.deepEqual(proposal.construction_recipe.points,proposal.geometry.coordinates[0]);
         const id=proposal.id;
         await request('close');await request('open',{file:files[i]});await reconnect();frame=await frameFor(files[i]);
         await until(()=>frame.evaluate(()=>drawSource.getFeatures().length===2));
         await frame.evaluate(id=>{const f=drawSource.getFeatures().find(f=>f.get('annotationId')===id);replaceSelection([f]);onSelectionChanged();},id);
         await request('copy');await until(async()=>{const {value}=await request('clipboard');return value===yaml;});
         records.push({scenario:'taper-exact-clipboard-and-reopen',status:'passed',annotationId:id});
       }
       if(multiImageMode&&i===0){
         const image=path.join(root,'test/fixtures/electrode100-microscope.png');
         await request('image',{file:image});await until(()=>frame.evaluate(()=>microImages.length===1));
         await request('image',{file:image});await until(()=>frame.evaluate(()=>microImages.length===2));
         await frame.evaluate(()=>{const slider=document.getElementById('image-opacity');slider.value='42';slider.dispatchEvent(new Event('input',{bubbles:true}));});
         await frame.select('#image-display','image-contours');
         await frame.evaluate(()=>{const threshold=document.getElementById('image-contour-threshold');threshold.value='65';threshold.dispatchEvent(new Event('change',{bubbles:true}));});
         await frame.select('#image-contour-width','2');
         await frame.evaluate(()=>{const color=document.getElementById('image-contour-color');color.value='#ff8800';color.dispatchEvent(new Event('change',{bubbles:true}));});
         await frame.click('#image-border');
         await frame.click('#image-lower');
         assert.deepEqual(await frame.evaluate(()=>Array.from(document.querySelectorAll('.image-stack-row')).map(row=>row.dataset.imageId)),await frame.evaluate(()=>microImages.slice().reverse().map(item=>item.imageId)));
         await frame.click('#image-stack .image-stack-row:first-child input');
         assert.equal(await frame.evaluate(()=>microImages[1].visible),false,'independent layer visibility');
         await frame.click('#image-stack .image-stack-row:last-child button');
         const selectedPose=await frame.evaluate(()=>[microImg.cx,microImg.cy,microImg.umPerPx,microImg.rotDeg]);
         await frame.select('#image-display','contours');
         assert.deepEqual(await frame.evaluate(()=>[microImg.cx,microImg.cy,microImg.umPerPx,microImg.rotDeg]),selectedPose,'display changed placement');
         await until(()=>frame.evaluate(()=>imageSaveStatus==='Saved in this workspace'));
         const expected=await frame.evaluate(()=>microImages.map(x=>({id:x.imageId,opacity:x.opacity,visible:x.visible!==false,cx:x.cx,cy:x.cy,scale:x.umPerPx,display:{...MicroscopeOverlay.defaultDisplay(),...x.display}})));
         assert.equal(new Set(expected.map(x=>x.id)).size,2,'same-file insertions need distinct identities');
         await request('close');await request('open',{file:files[i]});await reconnect();frame=await frameFor(files[i]);
         await until(()=>frame.evaluate(()=>microImages.length===2));
         assert.deepEqual(await frame.evaluate(()=>microImages.map(x=>({id:x.imageId,opacity:x.opacity,visible:x.visible!==false,cx:x.cx,cy:x.cy,scale:x.umPerPx,display:{...MicroscopeOverlay.defaultDisplay(),...x.display}}))),expected);
         assert.equal(await frame.evaluate(()=>drawSource.getFeatures().length),1,'drawn element missing after reopen');
         assert(await frame.evaluate(()=>microImages.every(x=>x._layer.getZIndex()<(vectorLayer.getZIndex()||0))));
         records.push({scenario:'two-images-and-drawing-reopened',status:'passed',images:expected});
       }
       if([0,4,9].includes(i)){records.push({cycle:cycle+1,files:i+1,clipboard:true,annotations:true});await frame.page().screenshot({path:path.join(output,`cycle-${cycle+1}-files-${i+1}.png`)});}
     }
     if(!usageMode&&!workOrdersMode&&!provenanceRoot){
     // Close and reopen a real editor; persisted drawing and clipboard must still match.
     const lastFile=files[files.length-1]; await request('close');await request('open',{file:lastFile});await reconnect();const frame=await frameFor(lastFile);
     assert.equal(await frame.evaluate(()=>drawSource.getFeatures().length),1);
     if(cycle===0&&!usageMode){
       const beforeBuildHash=await frame.evaluate(()=>currentLayoutHash);
       const script=path.join(workspace,'build.py');fs.writeFileSync(script,"import gdsfactory as gf\nc = gf.components.rectangle(size=(37, 19))\nc.write_gds('chip-10.gds')\n");
       await request('source',{file:script});await request('build');await request('open',{file:lastFile});await reconnect();
       const built=await frameFor(lastFile);await until(()=>built.evaluate(previous=>allFeatures.length<10&&currentLayoutHash!==previous,beforeBuildHash));
       assert(await built.evaluate(()=>drawSource.getFeatures()[0].get('intent').snapshot!==currentLayoutHash));
     }
     }
     fs.writeFileSync(path.join(output,`cycle-${cycle+1}.log`),log);
   }finally{
     if(browser)await browser.disconnect();
     fs.writeFileSync(path.join(bridge,'request.json'),JSON.stringify({id:++id,action:'stop'}));
     await Promise.race([new Promise(r=>child.once('exit',r)),sleep(15000)]);
     if(child.exitCode===null)child.kill();
     fs.writeFileSync(path.join(output,`cycle-${cycle+1}.log`),log);
   }
 }
 fs.writeFileSync(path.join(output,'report.json'),JSON.stringify({status:'passed',workspace,records},null,2));
 console.log(JSON.stringify({status:'passed',records:records.length,output}));
}
main().catch(e=>{const failure={status:'failed',error:String(e.stack||e),time:new Date().toISOString()};fs.mkdirSync(output,{recursive:true});fs.writeFileSync(path.join(output,'failure-'+Date.now()+'.json'),JSON.stringify(failure,null,2));fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(failure,null,2));console.error(e);process.exitCode=1;});
