// Exercise the real provider's persistence protocol with a VS Code storage adapter.
const assert=require('assert/strict'),fs=require('fs'),path=require('path'),os=require('os'),crypto=require('crypto'),Module=require('module'),esbuild=require('esbuild');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gds-persistence-')),bundle=path.join(dir,'provider.cjs');
async function main(){
    esbuild.buildSync({entryPoints:[path.join(__dirname,'../../src/gdsEditor.ts')],bundle:true,platform:'node',format:'cjs',external:['vscode'],outfile:bundle});
    const original=Module._load;let GdsEditorProvider;
    try{Module._load=function(name,...args){if(name==='vscode')return {window:{createTextEditorDecorationType:()=>({})},OverviewRulerLane:{Right:4}};return original.call(this,name,...args);};({GdsEditorProvider}=require(bundle));}finally{Module._load=original;}
    const values=new Map(),messages=[];let updates=0;
    const provider=new GdsEditorProvider({extensionUri:{fsPath:dir},workspaceState:{get:k=>values.get(k),update:async(k,v)=>{if(++updates%2)await new Promise(r=>setTimeout(r,10));if(v===undefined)values.delete(k);else values.set(k,v);}}},{},{appendLine:()=>{}});
    const imagePath=path.join(dir,'image.png');fs.writeFileSync(imagePath,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64'));
    const hash=crypto.createHash('sha256').update(fs.readFileSync(imagePath)).digest('hex');
    const entry={gdsPath:path.join(dir,'chip.gds'),gdsHash:'gds-a',currentImageId:hash,currentImageHash:hash,currentImagePath:imagePath,loading:false,panel:{webview:{postMessage:async m=>{messages.push(m);return true;}}}};
    const state={version:1,imageSizePx:[1,1],cx:1,cy:2,umPerPx:.5,rotDeg:0,opacity:1,visible:true,locked:true,markerTransform:null,markerPose:null,quality:{status:'unverified',boundaryRmsPx:null,markerCount:0},options:{markerAppearance:'yellow',markerLayers:['1/0','8/0','9/0']}};
    const save=(s,extra={})=>provider.saveImageState(entry,{imageId:hash,layoutHash:'gds-a',state:s,revision:1,...extra});
    await Promise.all([save(state),save({...state,cx:7},{revision:2})]);
    assert.equal([...values.values()][0].state.cx,7,'storage updates reordered');
    await save({...state,cx:99},{imageId:'stale'});await save({...state,cx:99},{layoutHash:'gds-old'});
    assert.equal([...values.values()][0].state.cx,7,'stale input overwrote state');
    await save({...state,umPerPx:NaN});assert(messages.some(m=>m.type==='imageNotice'));
    messages.length=0;await provider.restoreSavedImage(entry,'gds-a');
    assert.equal(messages.find(m=>m.type==='loadImage').savedState.cx,7,'matching saved state not restored');
    fs.appendFileSync(imagePath,'changed');messages.length=0;await provider.restoreSavedImage(entry,'gds-a');
    assert.equal(values.size,0);assert(!messages.some(m=>m.type==='loadImage'));assert(messages.some(m=>m.type==='imageNotice'));
    await save(state);messages.length=0;await provider.restoreSavedImage(entry,'gds-changed');
    assert.equal(values.size,0);assert(!messages.some(m=>m.type==='loadImage'));
    entry.currentImageId=hash;await save(state);await provider.clearImageState(entry,{imageId:hash});await save(state);
    assert.equal(values.size,0,'late save resurrected removed image');
    console.log('alignment persistence protocol: save ordering, stale inputs, restore, changed files, remove passed');
}
main().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>{
    const target=path.resolve(dir),parent=path.resolve(os.tmpdir());
    if(path.dirname(target)!==parent||!path.basename(target).startsWith('gds-persistence-'))throw new Error('Unexpected test cleanup path');
    fs.rmSync(target,{recursive:true,force:true});
});
