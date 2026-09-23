const http=require('http'),fs=require('fs'),path=require('path');
const{execFileSync}=require('child_process');
const puppeteer=require('puppeteer-core');
const ROOT='D:/gds-navigator-vscode',PORT=8840;
const srv=http.createServer((q,r)=>{const fp=path.normalize(path.join(ROOT,decodeURIComponent(new URL(q.url,'http://x').pathname)));fs.readFile(fp,(e,d)=>{if(e){r.writeHead(404);r.end();return;}r.writeHead(200);r.end(d);});});
srv.listen(PORT,'127.0.0.1',async()=>{
  execFileSync(process.execPath,[path.join(ROOT,'scripts','make-standalone.js')],{stdio:'ignore'});
  const b=await puppeteer.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true,args:['--no-first-run'],protocolTimeout:1200000});
  const pg=await b.newPage();
  await pg.goto(`http://127.0.0.1:${PORT}/webview/test-standalone.html?data=../test/fixtures/chip285_markers_geo`,{waitUntil:'load',timeout:60000});
  await pg.waitForFunction(()=>window.__viewerReady===true&&window.allFeatures,{timeout:30000,polling:100});
  const b64=fs.readFileSync(path.join(ROOT,'test','fixtures','nbse2_sample1-1_micro.jpg')).toString('base64');
  const out=await pg.evaluate(async(dataUrl)=>{
    window.__ALIGN_VERBOSE=false;
    insertMicroImage(dataUrl,'probe');
    await new Promise((res)=>{const t0=Date.now();(function poll(){if(microImg&&microImg.name==='probe')res();else if(Date.now()-t0>10000)res();else setTimeout(poll,40);})();});
    elementCoarsePose(); // populates window.__elDigitRefine with closures
    const ref=window.__elDigitRefine;
    // coarse grid over the design-origin region, then top-1 local refine
    const grid=[];
    for(let cx=-400;cx<=600;cx+=100)for(let cy=-400;cy<=700;cy+=100){
      const r=ref({umPerPx:0.465,rotDeg:0,cx,cy});
      grid.push({cx,cy,sc:r.digitConsensus});
    }
    grid.sort((a,b)=>b.sc-a.sc);
    return grid.slice(0,12);
  },'data:image/jpeg;base64,'+b64);
  console.log(JSON.stringify(out));
  await b.close();srv.close();
});
