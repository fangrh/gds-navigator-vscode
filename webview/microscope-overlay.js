/* Image rendering and compact, versioned state. No alignment decisions here. */
(function(root) {
    'use strict';
    const cache = new WeakMap();
    const options = () => ({ markerAppearance: 'yellow', markerLayers: ['1/0','8/0','9/0'] });
    const display = () => ({ mode: 'image', threshold: 40, color: '#00ffff', width: 1, border: false });
    function transform(state, width, height) {
        if (!state.markerTransform) {
            const r=state.rotDeg*Math.PI/180,c=Math.cos(r)*state.umPerPx,s=Math.sin(r)*state.umPerPx;
            return [c,-s,state.cx-c*width/2+s*height/2,-s,-c,state.cy+s*width/2+c*height/2,0,0,1];
        }
        const base=state.markerPose,angle=-(state.rotDeg-base.rotDeg)*Math.PI/180,scale=state.umPerPx/base.umPerPx;
        const c=Math.cos(angle)*scale,s=Math.sin(angle)*scale;
        const left=[c,-s,state.cx-c*base.cx+s*base.cy,s,c,state.cy-s*base.cx-c*base.cy,0,0,1],h=Array(9).fill(0);
        for(let row=0;row<3;row++)for(let col=0;col<3;col++)for(let j=0;j<3;j++)h[row*3+col]+=left[row*3+j]*state.markerTransform[j*3+col];
        return h;
    }
    function colorRgb(hex) { return [parseInt(hex.slice(1,3),16),parseInt(hex.slice(3,5),16),parseInt(hex.slice(5,7),16)]; }
    function validDisplay(d) {
        return !!d && typeof d==='object' && ['image','contours','image-contours'].indexOf(d.mode)>=0 && Number.isInteger(d.threshold) && d.threshold>=1 && d.threshold<=255 &&
            typeof d.color==='string' && /^#[0-9a-fA-F]{6}$/.test(d.color) && Number.isInteger(d.width) && d.width>=1 && d.width<=4 && typeof d.border==='boolean';
    }
    function drawDisplay(warped,ow,oh,d,borderMask) {
        if (d.mode==='image' && !d.border) return warped;
        const out=new Uint8ClampedArray(warped), rgb=colorRgb(d.color), radius=d.width-1;
        const lum=(i)=>((warped[i]*299+warped[i+1]*587+warped[i+2]*114)/1000);
        function edgeAt(x,y) {
            const i=4*(y*ow+x); if (warped[i+3]===0) return false;
            if (d.border && borderMask[y*ow+x]) return true;
            if (d.mode==='image') return false;
            let gx=0,gy=0;
            let hasTransparent=false;
            for(let ky=-1;ky<=1;ky++)for(let kx=-1;kx<=1;kx++) {
                const xx=Math.max(0,Math.min(ow-1,x+kx)), yy=Math.max(0,Math.min(oh-1,y+ky)), ni=4*(yy*ow+xx);
                if(warped[ni+3]===0) { hasTransparent=true; continue; }
                const weight=(kx===0?0:kx)*(ky===0?2:1); gx+=lum(ni)*weight;
                const yweight=(ky===0?0:ky)*(kx===0?2:1); gy+=lum(ni)*yweight;
            }
            if (hasTransparent) return false;
            return Math.hypot(gx,gy)>=d.threshold;
        }
        if (d.mode==='contours') out.fill(0);
        for(let y=0;y<oh;y++)for(let x=0;x<ow;x++)if(edgeAt(x,y)) {
            for(let dy=-radius;dy<=radius;dy++)for(let dx=-radius;dx<=radius;dx++) {
                const xx=x+dx,yy=y+dy;if(xx<0||yy<0||xx>=ow||yy>=oh)continue; const i=4*(yy*ow+xx);
                if(warped[i+3]===0) continue;
                out[i]=rgb[0];out[i+1]=rgb[1];out[i+2]=rgb[2];out[i+3]=warped[i+3];
            }
        }
        return out;
    }
    function render(image,state) {
        const w=image.naturalWidth,h=image.naturalHeight,H=transform(state,w,h),key=JSON.stringify(H);
        let entry=cache.get(image);
        const d=state.display===undefined?display():state.display;
        if(!validDisplay(d)) throw new Error('Invalid image display state');
        const displayKey=JSON.stringify(d);
        if(entry && entry.key===key && entry.displayKey===displayKey)return entry.output;
        const api=root.NumberedMarkerAlignment;
        const corners=[[0,0],[w,0],[w,h],[0,h]].map(p=>api.project(H,p));
        const extent=[Math.min(...corners.map(p=>p[0])),Math.min(...corners.map(p=>p[1])),Math.max(...corners.map(p=>p[0])),Math.max(...corners.map(p=>p[1]))];
        if(!extent.every(Number.isFinite)||!Number.isFinite(state.umPerPx)||state.umPerPx<=0)throw new Error('Invalid image placement');
        if(!entry){const source=document.createElement('canvas');source.width=w;source.height=h;const ctx=source.getContext('2d');ctx.drawImage(image,0,0);entry={pixels:ctx.getImageData(0,0,w,h).data};}
        const ow=Math.max(1,Math.min(2400,Math.ceil((extent[2]-extent[0])/state.umPerPx))),oh=Math.max(1,Math.min(2400,Math.ceil((extent[3]-extent[1])/state.umPerPx)));
        if(!entry.warped || entry.key!==key || entry.warpedWidth!==ow || entry.warpedHeight!==oh) {
            const dst=new Uint8ClampedArray(ow*oh*4),src=entry.pixels,inv=api.inverse(H);
            for(let y=0;y<oh;y++)for(let x=0;x<ow;x++){
                const p=api.project(inv,[extent[0]+(x+.5)*(extent[2]-extent[0])/ow,extent[3]-(y+.5)*(extent[3]-extent[1])/oh]);
                const sx=p[0]-.5,sy=p[1]-.5,x0=Math.floor(sx),y0=Math.floor(sy),fx=sx-x0,fy=sy-y0;
                if(x0<0||y0<0||x0+1>=w||y0+1>=h)continue;
                for(let ch=0;ch<4;ch++)dst[4*(y*ow+x)+ch]=(1-fy)*((1-fx)*src[4*(y0*w+x0)+ch]+fx*src[4*(y0*w+x0+1)+ch])+fy*((1-fx)*src[4*((y0+1)*w+x0)+ch]+fx*src[4*((y0+1)*w+x0+1)+ch]);
            }
            entry.warped=dst;entry.borderMask=null;entry.warpedWidth=ow;entry.warpedHeight=oh;
        }
        if(d.border&&!entry.borderMask){
            const points=corners.map(p=>[(p[0]-extent[0])*ow/(extent[2]-extent[0]),(extent[3]-p[1])*oh/(extent[3]-extent[1])]);
            const segments=points.map((a,i)=>{const b=points[(i+1)%4],dx=b[0]-a[0],dy=b[1]-a[1];return {a,dx,dy,length2:dx*dx+dy*dy};});
            const mask=new Uint8Array(ow*oh);
            for(let y=0;y<oh;y++)for(let x=0;x<ow;x++){
                if(!entry.warped[4*(y*ow+x)+3])continue;
                for(const s of segments){
                    const px=x+.5-s.a[0],py=y+.5-s.a[1],t=s.length2?Math.max(0,Math.min(1,(px*s.dx+py*s.dy)/s.length2)):0;
                    if((px-t*s.dx)**2+(py-t*s.dy)**2<=4){mask[y*ow+x]=1;break;}
                }
            }
            entry.borderMask=mask;
        }
        const canvas=document.createElement('canvas');canvas.width=ow;canvas.height=oh;const ctx=canvas.getContext('2d'),dst=ctx.createImageData(ow,oh);dst.data.set(drawDisplay(entry.warped,ow,oh,d,entry.borderMask));ctx.putImageData(dst,0,0);
        entry.key=key;entry.displayKey=displayKey;entry.output={canvas,extent,transform:H,url:canvas.toDataURL('image/png')};cache.set(image,entry);return entry.output;
    }
    function serialize(state) {
        return {version:1,imageSizePx:[state.img.naturalWidth,state.img.naturalHeight],cx:state.cx,cy:state.cy,umPerPx:state.umPerPx,rotDeg:state.rotDeg,
            opacity:state.opacity,visible:state.visible!==false,locked:state.locked!==false,
            markerTransform:state.markerTransform?state.markerTransform.slice():null,markerPose:state.markerPose?{...state.markerPose}:null,
            quality:{...(state.quality||{status:'unverified',boundaryRmsPx:null,markerCount:0})},options:JSON.parse(JSON.stringify(state.options||options())),display:{...(state.display||display())}};
    }
    function validSaved(saved, width, height) {
        if(!saved||saved.version!==1||!Array.isArray(saved.imageSizePx)||saved.imageSizePx.length!==2||saved.imageSizePx[0]!==width||saved.imageSizePx[1]!==height)return false;
        if(width<1||height<1||width*height>16000000)return false;
        for(const key of ['cx','cy','umPerPx','rotDeg','opacity'])if(!Number.isFinite(saved[key]))return false;
        if(saved.umPerPx<=0||saved.opacity<0||saved.opacity>1||typeof saved.visible!=='boolean'||typeof saved.locked!=='boolean')return false;
        const hasH=Array.isArray(saved.markerTransform),hasPose=saved.markerPose!==null&&typeof saved.markerPose==='object';
        if((saved.markerTransform===null)!==(!hasH)||(saved.markerPose===null)!==(!hasPose)||hasH!==hasPose)return false;
        if(hasH){
            if(saved.markerTransform.length!==9||!saved.markerTransform.every(Number.isFinite))return false;
            const h=saved.markerTransform,d=h[0]*(h[4]*h[8]-h[5]*h[7])-h[1]*(h[3]*h[8]-h[5]*h[6])+h[2]*(h[3]*h[7]-h[4]*h[6]);
            if(!Number.isFinite(d)||Math.abs(d)<1e-12)return false;
            for(const p of [[0,0],[width,0],[width,height],[0,height]]){const z=h[6]*p[0]+h[7]*p[1]+h[8];if(!Number.isFinite(z)||z<=1e-12)return false;}
        }
        if(hasPose){const p=saved.markerPose;if(!Number.isFinite(p.cx)||!Number.isFinite(p.cy)||!Number.isFinite(p.umPerPx)||!Number.isFinite(p.rotDeg)||p.umPerPx<=0)return false;}
        const q=saved.quality;if(!q||!['aligned','adjusted','unverified'].includes(q.status)||!(q.boundaryRmsPx===null||(Number.isFinite(q.boundaryRmsPx)&&q.boundaryRmsPx>=0&&q.boundaryRmsPx<=2))||!Number.isInteger(q.markerCount)||q.markerCount<0||q.markerCount>10000)return false;
        if(q.status==='aligned'&&(!hasH||!hasPose||q.boundaryRmsPx===null||q.markerCount<3))return false;
        const o=saved.options;if(!o||!['yellow','bright','dark'].includes(o.markerAppearance)||!Array.isArray(o.markerLayers)||o.markerLayers.length<1||o.markerLayers.length>16||!o.markerLayers.every(x=>typeof x==='string'&&/^\d+\/\d+$/.test(x)&&x!=='4/0'))return false;
        if(saved.display!==undefined&&!validDisplay(saved.display))return false;
        return true;
    }
    function restore(state,saved) {
        if(!state||!state.img||!validSaved(saved,state.img.naturalWidth,state.img.naturalHeight))throw new Error('Invalid saved image state');
        // Validate everything before mutating state, then copy mutable fields so a
        // caller cannot alter the active placement through the saved payload.
        if(saved.markerTransform)root.NumberedMarkerAlignment.inverse(saved.markerTransform);
        const next={...saved,imageSizePx:saved.imageSizePx.slice(),markerTransform:saved.markerTransform?saved.markerTransform.slice():null,markerPose:saved.markerPose?{...saved.markerPose}:null,quality:{...saved.quality},options:{markerAppearance:saved.options.markerAppearance,markerLayers:saved.options.markerLayers.slice()},display:{...(saved.display||display())}};
        Object.assign(state,next);return state;
    }
    root.MicroscopeOverlay={render,transform,serialize,restore,defaultOptions:options,defaultDisplay:display,validateDisplay:validDisplay,validateSaved:(saved,width,height)=>validSaved(saved,width,height)};
})(globalThis);
