#!/usr/bin/env node
'use strict';
// Known transforms render the actual GDS font, not glyphs invented to fit the decoder.
const fs=require('fs'),path=require('path'),assert=require('assert/strict'),puppeteer=require('puppeteer-core');
const {parseGds}=require('./align-markers-direct');
const ROOT=path.resolve(__dirname,'../..'),OUT=path.join(ROOT,'logs/numbered-markers/tests');
const IDS=['0,0','0,-1','1,0','1,-1'].sort();
const centers=[[-200,-200],[0,-200],[-200,-400],[0,-400]];
function inverse(a){const b=[a[4]*a[8]-a[5]*a[7],a[2]*a[7]-a[1]*a[8],a[1]*a[5]-a[2]*a[4],a[5]*a[6]-a[3]*a[8],a[0]*a[8]-a[2]*a[6],a[2]*a[3]-a[0]*a[5],a[3]*a[7]-a[4]*a[6],a[1]*a[6]-a[0]*a[7],a[0]*a[4]-a[1]*a[3]],d=a[0]*b[0]+a[1]*b[3]+a[2]*b[6];return b.map(x=>x/d);}
function project(h,p){const z=h[6]*p[0]+h[7]*p[1]+h[8];return [(h[0]*p[0]+h[1]*p[1]+h[2])/z,(h[3]*p[0]+h[4]*p[1]+h[5])/z];}
function truth(deg,perspective=false){const t=deg*Math.PI/180,a=.5*Math.cos(t),b=.5*Math.sin(t),g=perspective?.000045:0,h=perspective?-.000055:0,z=1+360*g+360*h;return [a,b,-100*z-360*(a+b),b,-a,-300*z-360*(b-a),g,h,1];}
function error(found,expected){const inv=inverse(found);return Math.max(...[[160,160],[560,160],[160,560],[560,560],[360,360]].map(p=>{const q=project(inv,project(expected,p));return Math.hypot(q[0]-p[0],q[1]-p[1]);}));}
async function main(){
    fs.mkdirSync(OUT,{recursive:true});
    const browserPath=process.env.GDS_BROWSER||['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Google/Chrome/Application/chrome.exe','/usr/bin/chromium','/usr/bin/google-chrome'].find(fs.existsSync);
    assert(browserPath,'Edge/Chrome required; set GDS_BROWSER');
    const fixture=JSON.parse(fs.readFileSync(path.join(ROOT,'test/fixtures/jj_pad_center_50_geo.json'),'utf8'));
    const features=fixture.features;
    const samples=features.filter(f=>[1,8,9].includes(Number(f.properties.layer))).map(f=>{
        const ring=f.geometry.coordinates[0],xs=ring.map(p=>p[0]),ys=ring.map(p=>p[1]),b=[Math.min(...xs),Math.min(...ys),Math.max(...xs),Math.max(...ys)];
        const group=centers.findIndex(p=>b[0]>=p[0]-11&&b[2]<=p[0]+65&&b[1]>=p[1]-60&&b[3]<=p[1]+11);
        return {f,group,isPad:Math.abs(b[2]-b[0]-20)<.01&&Math.abs(b[3]-b[1]-20)<.01};
    }).filter(s=>s.group>=0);
    assert(samples.length>20,'Actual marker geometry must be available');
    const browser=await puppeteer.launch({executablePath:browserPath,headless:true,protocolTimeout:120000});
    const report={cases:[],status:'running'};
    try {
        const page=await browser.newPage();await page.addScriptTag({path:path.join(ROOT,'webview/numbered-marker-alignment.js')});
        async function synthetic(spec){return page.evaluate(async({samples,features,spec})=>{
            const c=document.createElement('canvas');c.width=720;c.height=720;const ctx=c.getContext('2d');ctx.fillStyle='#aaa';ctx.fillRect(0,0,720,720);
            for(const sample of samples){if(spec.blank||sample.group===spec.missing||spec.unreadable&&!sample.isPad)continue;
                ctx.beginPath();sample.f.geometry.coordinates[0].forEach((p,i)=>{const h=spec.inverse,z=h[6]*p[0]+h[7]*p[1]+h[8],x=(h[0]*p[0]+h[1]*p[1]+h[2])/z,y=(h[3]*p[0]+h[4]*p[1]+h[5])/z;if(i)ctx.lineTo(x,y);else ctx.moveTo(x,y);});ctx.closePath();ctx.fillStyle='#e7ee30';ctx.fill();
            }
            if(spec.distractors){ctx.fillStyle='#00ff00';ctx.fillRect(285,285,140,140);ctx.fillStyle='#303030';ctx.fillRect(20,20,55,60);}
            const image=new Image();image.src=c.toDataURL();await image.decode();
            const refs=features.filter(f=>Number(f.properties.layer)!==4);
            if(spec.distractors)refs.push({type:'Feature',properties:{layer:4,data_type:0},geometry:{type:'Polygon',coordinates:[[[-300,-100],[100,-100],[100,-500],[-300,-500],[-300,-100]]]}});
            return {result:await NumberedMarkerAlignment.align({image,features:refs}),png:c.toDataURL()};
        },{samples,features,spec});}
        for(const spec of [{name:'rotation-0',deg:0},{name:'rotation-12',deg:12},{name:'rotation-90',deg:90},{name:'rotation-180',deg:180},{name:'perspective',deg:12,perspective:true},{name:'missing-marker',deg:0,missing:3}]){
            const h=truth(spec.deg,spec.perspective),{result:r,png}=await synthetic({...spec,inverse:inverse(h)});
            const entry={name:spec.name,...r};report.cases.push(entry);
            fs.writeFileSync(path.join(OUT,spec.name+'.png'),Buffer.from(png.split(',')[1],'base64'));
            assert.equal(r.status,'aligned',spec.name+': '+r.reason);
            assert.deepEqual(r.markers.map(m=>m.label).sort(),spec.missing===3?IDS.filter(x=>x!=='1,-1'):IDS);
            entry.maxProbeErrorPx=error(r.transform,h);assert(entry.maxProbeErrorPx<2,spec.name+' transform error '+entry.maxProbeErrorPx);
            assert(r.boundaryRmsPx<=2&&r.markers.every(m=>m.boundaryRmsPx<=4));
        }
        const a=(await synthetic({inverse:inverse(truth(0))})).result,b=(await synthetic({inverse:inverse(truth(0)),distractors:true})).result;
        assert.equal(b.status,'aligned');const delta=error(a.transform,b.transform);assert(delta<.5);report.cases.push({name:'image-and-GDS-electrode-invariance',maxDeltaPx:delta});
        for(const name of ['blank','unreadable']){const {result:r}=await synthetic({inverse:inverse(truth(0)),[name]:true});assert.equal(r.status,'failed');if(name==='unreadable')assert.equal(r.photoMarkerCount,4);report.cases.push({name,status:r.status,reason:r.reason});}
        const ix=process.argv.indexOf('--image');
        if(ix>=0){assert(process.argv[ix+1],'--image requires path');const imagePath=path.resolve(process.argv[ix+1]),url='data:image/png;base64,'+fs.readFileSync(imagePath).toString('base64');
            const realFeatures=parseGds('python',path.join(ROOT,'test/fixtures/jj_pad_center_100_test.gds')).features,results=[];
            for(let i=0;i<3;i++)results.push(await page.evaluate(async({url,features})=>{const image=new Image();image.src=url;await image.decode();return NumberedMarkerAlignment.align({image,features});},{url,features:realFeatures}));
            for(const r of results){assert.equal(r.status,'aligned');assert.deepEqual(r.markers.map(m=>m.label).sort(),IDS);assert(r.boundaryRmsPx<=2&&r.markers.every(m=>m.boundaryRmsPx<=4));assert.deepEqual(r.transform,results[0].transform);}
            report.cases.push({name:'real-electrode100-three-repeats',imagePath,results});
        }
        report.status='passed';console.log(JSON.stringify({status:'passed',cases:report.cases.length,report:path.join(OUT,'report.json')}));
    }catch(e){report.status='failed';report.error=e.message;fs.writeFileSync(path.join(OUT,'failure-'+Date.now()+'.json'),JSON.stringify(report,null,2));throw e;}
    finally{fs.writeFileSync(path.join(OUT,'report.json'),JSON.stringify(report,null,2));await browser.close();}
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;});
