const http=require('http'),fs=require('fs'),path=require('path');
const{execFileSync}=require('child_process');
const puppeteer=require('puppeteer-core');
const ROOT='D:/gds-navigator-vscode',PORT=8843;
const srv=http.createServer((q,r)=>{const fp=path.normalize(path.join(ROOT,decodeURIComponent(new URL(q.url,'http://x').pathname)));fs.readFile(fp,(e,d)=>{if(e){r.writeHead(404);r.end();return;}r.writeHead(200);r.end(d);});});
srv.listen(PORT,'127.0.0.1',async()=>{
  execFileSync(process.execPath,[path.join(ROOT,'scripts','make-standalone.js')],{stdio:'ignore'});
  const b=await puppeteer.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true,args:['--no-first-run']});
  const pg=await b.newPage();
  await pg.goto(`http://127.0.0.1:${PORT}/webview/test-standalone.html?data=../test/fixtures/chip285_markers_geo`,{waitUntil:'load',timeout:60000});
  await pg.waitForFunction(()=>window.__viewerReady===true&&window.allFeatures,{timeout:30000,polling:100});
  const b64=fs.readFileSync(path.join(ROOT,'test','fixtures','nbse2_sample1-1_micro.jpg')).toString('base64');
  const out=await pg.evaluate(async(dataUrl)=>{
    insertMicroImage(dataUrl,'lv');
    await new Promise((res)=>{const t0=Date.now();(function poll(){if(microImg&&microImg.name==='lv')res();else if(Date.now()-t0>10000)res();else setTimeout(poll,40);})();});
    window.__ALIGN_VERBOSE=true;
    const ph=detectPhotoElements();
    const cv=document.createElement('canvas');cv.width=microImg.img.naturalWidth;cv.height=microImg.img.naturalHeight;
    const ctx=cv.getContext('2d');
    ctx.drawImage(microImg.img,0,0);
    if(window.__elYmask){
      const ym=window.__elYmask;
      const tmp=document.createElement('canvas');tmp.width=ym.w;tmp.height=ym.h;
      const id=tmp.getContext('2d').createImageData(ym.w,ym.h);
      for(let i=0;i<ym.w*ym.h;i++){ if(ym.m[i]){ id.data[4*i]=255; id.data[4*i+1]=0; id.data[4*i+2]=0; id.data[4*i+3]=200; } }
      tmp.getContext('2d').putImageData(id,0,0);
      ctx.imageSmoothingEnabled=false;
      ctx.globalAlpha=0.7;
      ctx.drawImage(tmp,0,0,cv.width,cv.height);
      ctx.globalAlpha=1.0;
    }
    ctx.strokeStyle='#ff00ff';ctx.lineWidth=3;
    ctx.font='16px monospace'; ctx.fillStyle='#ff00ff';
    for(const L of (ph.labels||[]).filter(L=>L.nStrokes>=2&&(L.members||[]).length>=3&&(L.members||[]).length<=14)){
      ctx.strokeRect(L.u-L.w/2-4,L.v-L.h/2-4,L.w+8,L.h+8);
      ctx.fillText('h'+L.holes, L.u-L.w/2-4, L.v-L.h/2-8);
    }
    // sample RGB at known spots
    const c4=cv.getContext('2d');
    const D4=c4.getImageData(0,0,cv.width,cv.height).data;
    function sp(x,y){const i=(y*cv.width+x)*4;return [D4[i],D4[i+1],D4[i+2]];}
    const samples={
      padTop: sp(430,40), padMid: sp(370,445), padCore: sp(370,448),
      label0_1: sp(420,520), label0_0: sp(420,945), background: sp(600,320)
    };
    return { samples, nlabels: (ph.labels||[]).map(L=>({h:L.holes,n:L.nStrokes,u:Math.round(L.u),v:Math.round(L.v)})), png: cv.toDataURL('image/png') };
  },'data:image/jpeg;base64,'+b64);
  fs.writeFileSync(path.join(ROOT,'test','alignment','out','label_detect.png'),Buffer.from(out.png.split(',')[1],'base64'));
  console.log('samples:',JSON.stringify(out.samples));
  console.log('nlabels:',JSON.stringify(out.nlabels));
  await b.close();srv.close();
});
