/* Numbered square-marker registration. No electrode or whole-image fallback.
 * Coordinates: row-major H maps native image pixels (y down) to GDS um (y up).
 * Browser module shared by the extension and the command-line runner. */
(function (root) {
    'use strict';
    const DEFAULT_LAYERS = ['1/0', '8/0', '9/0'];
    const MAX_IMAGE_PIXELS = 16_000_000;
    const MAX_FEATURES = 250_000;
    const MAX_VERTICES = 3_000_000;
    const APPEARANCES = new Set(['yellow', 'bright', 'dark']);
    const project = (h, p) => {
        const z = h[6] * p[0] + h[7] * p[1] + h[8];
        if (!Number.isFinite(z) || Math.abs(z) < 1e-12) throw new Error('Invalid marker transform denominator');
        return [(h[0] * p[0] + h[1] * p[1] + h[2]) / z,
            (h[3] * p[0] + h[4] * p[1] + h[5]) / z];
    };
    function inverse(a) {
        if (!Array.isArray(a) || a.length !== 9) throw new Error('Invalid marker transform');
        const b = [a[4]*a[8]-a[5]*a[7], a[2]*a[7]-a[1]*a[8], a[1]*a[5]-a[2]*a[4],
            a[5]*a[6]-a[3]*a[8], a[0]*a[8]-a[2]*a[6], a[2]*a[3]-a[0]*a[5],
            a[3]*a[7]-a[4]*a[6], a[1]*a[6]-a[0]*a[7], a[0]*a[4]-a[1]*a[3]];
        const d = a[0]*b[0]+a[1]*b[3]+a[2]*b[6];
        if (!a.every(Number.isFinite) || !Number.isFinite(d) || Math.abs(d) < 1e-15) throw new Error('Invalid or singular marker transform');
        return b.map(x => x/d);
    }
    const dist = (a,b) => Math.hypot(a[0]-b[0],a[1]-b[1]);
    const median = a => a.slice().sort((x,y)=>x-y)[Math.floor(a.length/2)];
    function canvas(w,h) { const c=typeof document === 'undefined' ? new OffscreenCanvas(w,h) : document.createElement('canvas'); c.width=w;c.height=h;return c; }
    function normalizeOptions(options) {
        options = options || {};
        const appearance = options.markerAppearance === undefined ? 'yellow' : options.markerAppearance;
        if (!APPEARANCES.has(appearance)) throw new Error('Unsupported marker appearance: ' + appearance);
        const selected = options.markerLayers === undefined ? DEFAULT_LAYERS : options.markerLayers;
        if (!Array.isArray(selected) || !selected.length || selected.length > 16 || selected.some(v => typeof v !== 'string' || !/^\d+\/\d+$/.test(v) || v === '4/0')) throw new Error('markerLayers must be 1-16 layer/data_type strings and cannot include 4/0');
        return {markerAppearance: appearance, markerLayers: [...new Set(selected)]};
    }
    function validateFeatures(features) {
        if (!Array.isArray(features)) return 'features must be an array';
        if (features.length > MAX_FEATURES) return 'Feature count exceeds resource limit';
        let vertices = 0;
        for (const f of features) {
            if (!f || !f.properties || typeof f.properties !== 'object' || !f.geometry || typeof f.geometry !== 'object') return 'Malformed feature properties or geometry';
            const type = f.geometry.type, polygons = type === 'Polygon' ? [f.geometry.coordinates] : type === 'MultiPolygon' ? f.geometry.coordinates : [];
            if (type !== 'Polygon' && type !== 'MultiPolygon') continue;
            if (!Array.isArray(polygons)) return 'Malformed polygon coordinates';
            for (const rings of polygons) {
                if (!Array.isArray(rings) || !rings.length) return 'Malformed polygon rings';
                for (const ring of rings) {
                    if (!Array.isArray(ring) || ring.length < 4) return 'Malformed polygon ring';
                    vertices += ring.length;
                    if (vertices > MAX_VERTICES) return 'Vertex count exceeds resource limit';
                    for (const p of ring) if (!Array.isArray(p) || p.length < 2 || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) return 'Non-finite polygon coordinate';
                }
            }
        }
        return null;
    }
    function shapes(features, options) {
        const layers = new Set(options.markerLayers),
            seen=new Set(), out=[];
        for (const f of features) {
            const layer=String(f.properties.layer).includes('/')?String(f.properties.layer):f.properties.layer+'/'+(f.properties.data_type||0);
            if (!layers.has(layer)) continue;
            const polygons=f.geometry.type==='Polygon'?[f.geometry.coordinates]:f.geometry.type==='MultiPolygon'?f.geometry.coordinates:[];
            for (const rings of polygons) {
                const key=JSON.stringify(rings); if(seen.has(key))continue;seen.add(key);
                const xs=rings[0].map(p=>p[0]),ys=rings[0].map(p=>p[1]);
                const b=[Math.min(...xs),Math.min(...ys),Math.max(...xs),Math.max(...ys)];
                const w=b[2]-b[0],h=b[3]-b[1];
                let area=0;for(let i=1;i<rings[0].length;i++)area+=rings[0][i-1][0]*rings[0][i][1]-rings[0][i][0]*rings[0][i-1][1];
                out.push({rings,b,w,h,area:Math.abs(area/2),center:[(b[0]+b[2])/2,(b[1]+b[3])/2]});
            }
        }return out;
    }
    function labelText(parts, width) {
        // Semantic display for this GDS font's split 0, 1, comma and minus.
        // Matching itself ALWAYS uses the complete vector template, not this decoder.
        const groups=[];
        for(const p of parts.slice().sort((a,b)=>a.b[0]-b.b[0])) {
            let g=groups[groups.length-1];
            if(!g || p.b[0]>g[2]+width*.015) groups.push(p.b.slice());
            else {g[1]=Math.min(g[1],p.b[1]);g[2]=Math.max(g[2],p.b[2]);g[3]=Math.max(g[3],p.b[3]);}
        }
        return groups.map(b=>{
            const w=(b[2]-b[0])/width,h=(b[3]-b[1])/width;
            if(h<.26)return w<.16?',':'-';
            if(w<.26)return '1';
            // 0 consists of two overlapping-x half-rings in this vector font.
            const n=parts.filter(p=>p.b[0]>=b[0]-1e-6&&p.b[2]<=b[2]+1e-6).length;
            return n===2?'0':'?';
        }).join('');
    }
    function layoutMarkers(features, options) {
        const ss=shapes(features, options || {markerLayers: DEFAULT_LAYERS}), marks=[];
        for(const p of ss) {
            if(p.w<5 || p.w>100 || Math.abs(p.w/p.h-1)>.03 || p.area/(p.w*p.h)<.94)continue;
            if(marks.some(m=>dist(m.center,p.center)<.01))continue;
            const parts=ss.filter(q=>q!==p&&q.w<p.w&&q.h<p.w*.8&&
                q.b[0]>=p.center[0]+p.w*.25&&q.b[2]<=p.center[0]+p.w*3.2&&
                q.b[1]>=p.center[1]-p.w*2.8&&q.b[3]<=p.center[1]-p.w*.9);
            if(parts.length<3)continue;
            marks.push({...p,parts,label:labelText(parts,p.w)});
        }return marks;
    }
    function photoMarkers(image, options) {
        options = options || {markerAppearance: 'yellow'};
        if (!image || typeof image !== 'object') throw new Error('Image input is required');
        const w=image.naturalWidth,h=image.naturalHeight;
        if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1) throw new Error('Image has invalid dimensions');
        if (w * h > MAX_IMAGE_PIXELS) throw new Error('Image exceeds pixel resource limit');
        const appearance = options.markerAppearance;
        // The worker already decoded its ImageBitmap into a private canvas.
        // Read that canvas directly instead of making a second full-image copy.
        const decoded=typeof root.OffscreenCanvas!=='undefined'&&image instanceof root.OffscreenCanvas;
        const c=decoded?image:canvas(w,h),ctx=c.getContext('2d');if (!ctx) throw new Error('Canvas 2D context unavailable');if(!decoded)ctx.drawImage(image,0,0);
        const rgba=ctx.getImageData(0,0,w,h).data,mask=new Uint8Array(w*h),labelMask=new Uint8Array(w*h),seen=new Uint8Array(w*h),pads=[];
        for(let i=0;i<mask.length;i++) {const r=rgba[4*i],g=rgba[4*i+1],b=rgba[4*i+2],y=(r+g+b)/3;mask[i]=appearance==='bright'?(y>210?1:0):appearance==='dark'?(y<65?1:0):(Math.min(r,g)-b>65&&r>100&&g>90?1:0);labelMask[i]=appearance==='bright'?(y>190?1:0):appearance==='dark'?(y<100?1:0):(Math.min(r,g)-b>25&&r>100&&g>90?1:0);}
        for(let i=0;i<mask.length;i++) {
            if(!mask[i]||seen[i])continue;
            const stack=[i],pixels=[];seen[i]=1;let x0=w,y0=h,x1=0,y1=0,sx=0,sy=0;
            while(stack.length) {const q=stack.pop(),x=q%w,y=Math.floor(q/w);pixels.push(q);sx+=x+.5;sy+=y+.5;
                x0=Math.min(x0,x);x1=Math.max(x1,x);y0=Math.min(y0,y);y1=Math.max(y1,y);
                for(const j of [x>0?q-1:-1,x+1<w?q+1:-1,y>0?q-w:-1,y+1<h?q+w:-1])
                    if(j>=0&&mask[j]&&!seen[j]){seen[j]=1;stack.push(j);}
            }
            const bw=x1-x0+1,bh=y1-y0+1;
            if(pixels.length<100||bw/bh<.65||bw/bh>1.5||pixels.length/(bw*bh)<.65||bw>Math.min(w,h)*.2)continue;
            if(x0===0||y0===0||x1===w-1||y1===h-1)continue;
            const boundary=pixels.filter(q=>!mask[q-1]||!mask[q+1]||!mask[q-w]||!mask[q+w]).map(q=>[q%w+.5,Math.floor(q/w)+.5]);
            pads.push({center:[sx/pixels.length,sy/pixels.length],width:Math.sqrt(pixels.length),boundary});
        }
        return {w,h,mask,labelMask,pads};
    }
    const TW=96,TH=64,K=1.5;
    function normalizeLabel(a) {
        let x0=TW,y0=TH,x1=-1,y1=-1;
        for(let y=0;y<TH;y++)for(let x=0;x<TW;x++)if(a[y*TW+x]){x0=Math.min(x0,x);x1=Math.max(x1,x);y0=Math.min(y0,y);y1=Math.max(y1,y);}
        const out=new Uint8Array(a.length);if(x1<0)return out;
        const scale=30/(y1-y0+1),ww=(x1-x0+1)*scale;
        for(let y=0;y<30;y++)for(let x=0;x<ww&&x<TW-4;x++){
            const xx=Math.floor(x0+x/scale),yy=Math.floor(y0+y/scale);
            out[(y+12)*TW+x+2]=a[yy*TW+xx];
        }return out;
    }
    function template(m) {
        const c=canvas(TW,TH),ctx=c.getContext('2d');ctx.fillStyle='white';
        for(const p of m.parts){ctx.beginPath();for(const ring of p.rings)ring.forEach((v,i)=>{
            const x=((v[0]-m.center[0])*20/m.w)*K,y=(-(v[1]-m.center[1])*20/m.w-18)*K;
            if(i)ctx.lineTo(x,y);else ctx.moveTo(x,y);
        });ctx.closePath();ctx.fill('evenodd');}
        const d=ctx.getImageData(0,0,TW,TH).data;
        return normalizeLabel(Uint8Array.from({length:TW*TH},(_,i)=>d[4*i+3]>100?1:0));
    }
    function photoLabel(ph,p,angle,band) {
        const c=Math.cos(angle),s=Math.sin(angle),out=new Uint8Array(TW*TH);
        for(let y=0;y<TH;y++)for(let x=0;x<TW;x++){
            // Keep the complete template text band, including comma and minus.
            // Nearby flakes outside it must not stretch label normalization.
            if(band&&(y+.5<band[0]||y+.5>band[1]))continue;
            const u=(x+.5)/K*p.width/20,v=((y+.5)/K+18)*p.width/20;
            const xx=Math.floor(p.center[0]+c*u-s*v),yy=Math.floor(p.center[1]+s*u+c*v);
            if(xx>=0&&xx<ph.w&&yy>=0&&yy<ph.h)out[y*TW+x]=ph.labelMask[yy*ph.w+xx];
        }return normalizeLabel(out);
    }
    function dilate(a) {const b=new Uint8Array(a.length);for(let y=1;y<TH-1;y++)for(let x=1;x<TW-1;x++){
        const i=y*TW+x;if(a[i])for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++)b[i+dy*TW+dx]=1;
    }return b;}
    function matchOne(a,b) {
        const ad=dilate(a),bd=dilate(b);let na=0,nb=0,ab=0,ba=0;
        for(let i=0;i<a.length;i++){na+=a[i];nb+=b[i];ab+=a[i]*bd[i];ba+=b[i]*ad[i];}
        return na&&nb?(ab/na+ba/nb)/2*Math.min(1,Math.sqrt(Math.min(na,nb)/Math.max(na,nb))):0;
    }
    function match(a,b) {let best=matchOne(a,b);for(let i=0;i<3;i++){b=dilate(b);best=Math.max(best,matchOne(a,normalizeLabel(b)));}return best;}
    function solve(A,b) {
        const n=b.length,m=A.map((r,i)=>[...r,b[i]]);
        for(let j=0;j<n;j++){let k=j;for(let i=j+1;i<n;i++)if(Math.abs(m[i][j])>Math.abs(m[k][j]))k=i;
            if(Math.abs(m[k][j])<1e-12)return null;[m[j],m[k]]=[m[k],m[j]];
            const d=m[j][j];for(let t=j;t<=n;t++)m[j][t]/=d;
            for(let i=0;i<n;i++)if(i!==j){const v=m[i][j];for(let t=j;t<=n;t++)m[i][t]-=v*m[j][t];}
        }const out=m.map(r=>r[n]);return out.every(Number.isFinite)?out:null;
    }
    function least(rows,vals) {const n=rows[0].length,A=Array.from({length:n},()=>Array(n).fill(0)),b=Array(n).fill(0);
        rows.forEach((r,k)=>r.forEach((v,i)=>{b[i]+=v*vals[k];r.forEach((u,j)=>A[i][j]+=v*u);}));return solve(A,b);}
    function fit(pairs, perspective) {
        // Normalize image coordinates to keep projective normal equations conditioned.
        const rows=[],vals=[]; const norm=1000;
        for(const [p,q] of pairs){const x=p[0]/norm,y=p[1]/norm,X=q[0]/norm,Y=q[1]/norm;
            if(perspective){rows.push([x,y,1,0,0,0,-X*x,-X*y],[0,0,0,x,y,1,-Y*x,-Y*y]);}
            else rows.push([x,y,1,0],[-y,x,0,1]);vals.push(X,Y);
        }
        const v=least(rows,vals);if(!v)return null;
        const out=perspective?[v[0],v[1],v[2]*norm,v[3],v[4],v[5]*norm,v[6]/norm,v[7]/norm,1]:
            [v[0],v[1],v[2]*norm,v[1],-v[0],v[3]*norm,0,0,1];
        return out.every(Number.isFinite)?out:null;
    }
    function segmentDistance(p,a,b){const dx=b[0]-a[0],dy=b[1]-a[1],t=Math.max(0,Math.min(1,((p[0]-a[0])*dx+(p[1]-a[1])*dy)/(dx*dx+dy*dy)));return Math.hypot(p[0]-a[0]-t*dx,p[1]-a[1]-t*dy);}
    function residual(h,p,m,parity) {
        const inv=inverse(h),b=m.b,vs=[[b[0],b[1]],[b[2],b[1]],[b[2],b[3]],[b[0],b[3]]].map(v=>project(inv,v));
        const pts=p.boundary.filter((_,i)=>parity===undefined||i%2===parity);
        let sum=0;for(const q of pts){const d=Math.min(...vs.map((v,i)=>segmentDistance(q,v,vs[(i+1)%4])));sum+=d*d;}
        return Math.sqrt(sum/pts.length);
    }
    function metrics(h,matches,ph,lm,parity){return matches.map(v=>residual(h,ph.pads[v.pi],lm[v.mi],parity));}
    function refine(h,matches,ph,lm,perspective) {
        let current=h.slice();
        const cost=q=>{const a=metrics(q,matches,ph,lm,0);return a.reduce((s,v)=>s+v*v,0);};
        let value=cost(current);
        const deltas=perspective?[.001,.001,.3,.001,.001,.3,1e-6,1e-6]:[.001,.001,.3,.3];
        for(let level=0;level<5;level++)for(let pass=0;pass<3;pass++)for(let k=0;k<deltas.length;k++){
            for(const sign of [-1,1]){
                const q=current.slice(),step=sign*deltas[k]/Math.pow(2,level);
                if(perspective)q[k]+=step;
                else if(k===0){q[0]+=step;q[4]-=step;}else if(k===1){q[1]+=step;q[3]+=step;}else q[k===2?2:5]+=step;
                const v=cost(q);if(v<value){current=q;value=v;}
            }
        }return current;
    }
    async function align({image,features,options}={}) {
        const fail=(reason,extra={})=>({status:'failed',reason,markers:[],...extra});
        let selected;try { selected=normalizeOptions(options); } catch (e) { return fail(e.message); }
        const featureError=validateFeatures(features);if(featureError)return fail(featureError);
        let ph,lm;try { ph=photoMarkers(image,selected);lm=layoutMarkers(features,selected); } catch (e) { return fail(e.message); }
        if(ph.pads.length<3||lm.length<3)return fail('At least three complete numbered markers are required',{photoMarkerCount:ph.pads.length,layoutMarkerCount:lm.length});
        const ts=lm.map(template),width=median(lm.map(m=>m.w));
        const labelBand=[Infinity,-Infinity];
        for(const m of lm)for(const part of m.parts)for(const ring of part.rings)for(const v of ring){
            const y=(-(v[1]-m.center[1])*20/m.w-18)*K;
            labelBand[0]=Math.min(labelBand[0],y);labelBand[1]=Math.max(labelBand[1],y);
        }
        // Four template pixels cover the tested raster/pose variation. More
        // extreme perspective is unsupported unless the independent gates pass.
        labelBand[0]-=4;labelBand[1]+=4;
        const near=[];for(let i=0;i<ph.pads.length;i++)for(let j=i+1;j<ph.pads.length;j++){
            const a=ph.pads[i].center,b=ph.pads[j].center,d=dist(a,b);if(d<2*ph.pads[i].width)continue;
            let theta=Math.atan2(b[1]-a[1],b[0]-a[0]);theta=((theta+Math.PI/4)%(Math.PI/2)+Math.PI/2)%(Math.PI/2)-Math.PI/4;near.push({d,theta});
        }near.sort((a,b)=>a.d-b.d);
        if(!near.length)return fail('No separated marker centers');
        const angle=median(near.slice(0,Math.max(2,ph.pads.length)).map(v=>v.theta));
        const hypotheses=[],labelCandidates=[];
        const nominalScale=width/median(ph.pads.map(p=>p.width));
        // Rasterized square widths are biased by thresholding and perspective.
        // Seed scale from center separations too; labels still select absolute
        // position and orientation, and independent boundaries gate the fit.
        const scales=[nominalScale], separations=new Set();
        for(let i=0;i<lm.length;i++)for(let j=i+1;j<lm.length;j++)separations.add(Math.round(dist(lm[i].center,lm[j].center)*1000)/1000);
        for(const pair of near)for(const separation of separations){
            const candidate=separation/pair.d;
            if(candidate>nominalScale*.85&&candidate<nominalScale*1.15&&!scales.some(v=>Math.abs(v/candidate-1)<.002))scales.push(candidate);
        }
        for(let turn=0;turn<4;turn++){
            const theta=angle+turn*Math.PI/2,c=Math.cos(theta),s=Math.sin(theta);
            const scores=ph.pads.map(p=>{const a=photoLabel(ph,p,theta,labelBand);return ts.map(t=>match(a,t));});
            labelCandidates.push({theta,pads:ph.pads.map((p,i)=>({center:p.center,width:p.width,best:scores[i].map((score,j)=>({score,label:lm[j].label,center:lm[j].center})).sort((a,b)=>b.score-a.score).slice(0,3)}))});
            for(const scale of scales)
            for(let pi=0;pi<ph.pads.length;pi++)for(let mi=0;mi<lm.length;mi++){
                if(scores[pi][mi]<.5)continue;
                const anchor=ph.pads[pi].center,target=lm[mi].center,matches=[];
                ph.pads.forEach((p,pj)=>{
                    const dx=p.center[0]-anchor[0],dy=p.center[1]-anchor[1],q=[target[0]+scale*(c*dx+s*dy),target[1]+scale*(s*dx-c*dy)];
                    let best=-1,dd=Infinity;lm.forEach((m,mj)=>{const d=dist(m.center,q);if(d<dd){dd=d;best=mj;}});
                    if(dd<width*.75 && scores[pj][best]>.5)matches.push({pi:pj,mi:best,score:scores[pj][best]});
                });
                if(matches.length<3 || new Set(matches.map(v=>v.mi)).size!==matches.length)continue;
                const key=turn+':'+matches.map(v=>v.pi+','+v.mi).join(';');if(hypotheses.some(h=>h.key===key))continue;
                hypotheses.push({key,matches,score:matches.reduce((a,v)=>a+v.score,0)/ph.pads.length});
            }
        }
        hypotheses.sort((a,b)=>b.score-a.score);
        if(!hypotheses.length)return fail('No consistent complete-label correspondences',{labelCandidates,photoMarkerCount:ph.pads.length,layoutMarkerCount:lm.length});
        const best=hypotheses[0],margin=best.score-(hypotheses[1]?.score||0);
        const diagnostics={labelScore:best.score,labelMargin:margin,photoMarkerCount:ph.pads.length,layoutMarkerCount:lm.length,labelCandidates,selectedOptions:selected};
        if(best.score<.65||margin<.025)return fail('Numbered marker identity is ambiguous',diagnostics);
        const pairs=best.matches.map(v=>[ph.pads[v.pi].center,lm[v.mi].center]);
        let h=fit(pairs,false);if(!h)return fail('Degenerate marker geometry',diagnostics);
        h=refine(h,best.matches,ph,lm,false);
        let model='similarity',rs=metrics(h,best.matches,ph,lm),rms=a=>Math.sqrt(a.reduce((s,v)=>s+v*v,0)/a.length);
        if(best.matches.length>=4){let hp=fit(pairs,true);if(hp){hp=refine(hp,best.matches,ph,lm,true);const rp=metrics(hp,best.matches,ph,lm,1);
            // Centers fit H; boundary pixels are independent validation observations.
            const zs=[[0,0],[ph.w,0],[0,ph.h],[ph.w,ph.h]].map(p=>hp[6]*p[0]+hp[7]*p[1]+1);
            if(Math.min(...zs)>.5&&Math.max(...zs)<2&&rms(rp)<rms(rs)*.8&&rms(rp)<=2&&Math.max(...rp)<=4){h=hp;model='projective';rs=metrics(h,best.matches,ph,lm);}
        }}
        const markers=best.matches.map((v,i)=>({label:lm[v.mi].label,imageCenter:ph.pads[v.pi].center,layoutCenter:lm[v.mi].center,labelScore:v.score,boundaryRmsPx:rs[i]}));
        const validation=metrics(h,best.matches,ph,lm,1);
        const result={...diagnostics,model,transform:h,markers,boundaryRmsPx:rms(rs),validationBoundaryRmsPx:rms(validation),imageSizePx:[ph.w,ph.h]};
        if(result.boundaryRmsPx>2||Math.max(...rs)>4||rms(validation)>2||Math.max(...validation)>4)return fail('Marker boundary residual exceeds acceptance limits',result);
        return {status:'aligned',...result};
    }
    root.NumberedMarkerAlignment={align,project,inverse,layoutMarkers,photoMarkers,fit,template,photoLabel};
})(globalThis);
