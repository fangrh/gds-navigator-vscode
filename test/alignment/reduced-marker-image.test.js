#!/usr/bin/env node
'use strict';
const fs=require('fs'),path=require('path'),assert=require('assert/strict'),puppeteer=require('puppeteer-core');
const {parseGds}=require('./align-markers-direct'); const ROOT=path.resolve(__dirname,'../..');
const IDS=['0,0','0,-1','1,0','1,-1'].sort();
function browserPath(){return process.env.GDS_BROWSER||['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Google/Chrome/Application/chrome.exe','/usr/bin/chromium','/usr/bin/google-chrome'].find(fs.existsSync)}
(async()=>{let browser;try{
 const executablePath=browserPath();assert(executablePath,'Edge/Chrome required; set GDS_BROWSER');
 const imagePath=path.join(ROOT,'test/fixtures/electrode100-reduced.png'),gdsPath=path.join(ROOT,'test/fixtures/jj_pad_center_100_test.gds');
 const url='data:image/png;base64,'+fs.readFileSync(imagePath).toString('base64'),base=parseGds('python',gdsPath).features;
 browser=await puppeteer.launch({executablePath,headless:true,protocolTimeout:120000}); const page=await browser.newPage(); await page.addScriptTag({path:path.join(ROOT,'webview/numbered-marker-alignment.js')});
 async function align(features,imageUrl=url){return page.evaluate(async({url,features})=>{const image=new Image();image.src=url;await image.decode();return NumberedMarkerAlignment.align({image,features})},{url:imageUrl,features})}
 const results=[];for(let i=0;i<3;i++)results.push(await align(base));
 for(const result of results){assert.equal(result.status,'aligned',result.reason);assert.deepEqual(result.markers.map(m=>m.label).sort(),IDS);assert(result.boundaryRmsPx<=2);assert(result.validationBoundaryRmsPx<=2);assert(result.markers.every(m=>m.boundaryRmsPx<=4));}
 assert.deepEqual(results[1].transform,results[0].transform);assert.deepEqual(results[2].transform,results[0].transform);
 const mutated=base.concat([{type:'Feature',properties:{layer:4,data_type:0},geometry:{type:'Polygon',coordinates:[[[-1000,-1000],[1000,-1000],[1000,1000],[-1000,1000],[-1000,-1000]]]}}]);
 const changed=await align(mutated);assert.equal(changed.status,'aligned');assert.deepEqual(changed.markers.map(m=>m.label).sort(),IDS);assert.deepEqual(changed.transform,results[0].transform);
 const maskedUrl=await page.evaluate(async url=>{const image=new Image();image.src=url;await image.decode();const c=document.createElement('canvas');c.width=image.naturalWidth;c.height=image.naturalHeight;const x=c.getContext('2d');x.drawImage(image,0,0);x.fillStyle='#aaa';for(const r of [[45,55,115,100],[275,55,345,100],[45,295,120,345],[275,295,350,345]])x.fillRect(...r);return c.toDataURL();},url);
 const unreadable=await align(base,maskedUrl);assert.equal(unreadable.status,'failed');assert.equal(unreadable.photoMarkerCount,4);assert(unreadable.validationBoundaryRmsPx<=2 || unreadable.validationBoundaryRmsPx===undefined);
 const blank=await page.evaluate(async()=>{const c=document.createElement('canvas');c.width=398;c.height=348;const image=new Image();image.src=c.toDataURL();await image.decode();return NumberedMarkerAlignment.align({image,features:[]})});assert.equal(blank.status,'failed');
 console.log(JSON.stringify({status:'passed',identities:IDS,repetitions:3,nonmarkerInvariant:true,unreadableFails:true,unreadablePhotoMarkerCount:unreadable.photoMarkerCount}));
}catch(error){console.error(error.stack);process.exitCode=1}finally{if(browser)await browser.close()}})();
