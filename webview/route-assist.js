/* Canvas guidance, obstacle preview and cancellable routing. Geometry stays in the planner. */
(function(root){
    'use strict';
    function mount(c){
        const $=id=>document.getElementById(id), ol=c.ol;
        const source=new ol.source.Vector(), layer=new ol.layer.Vector({source,zIndex:90,style:(f,resolution)=>f.get('kind')==='route'?[new ol.style.Style({stroke:new ol.style.Stroke({color:'rgba(71,230,174,.28)',width:Math.max(1,Math.min(2048,f.get('width')/resolution)),lineJoin:'round',lineCap:'butt'})}),new ol.style.Style({stroke:new ol.style.Stroke({color:'#47e6ae',width:2})})]:new ol.style.Style({
            stroke:new ol.style.Stroke({color:f.get('kind')==='mask'?'rgba(255,80,90,.6)':f.get('kind')==='guide'?'#ffd166':'#47e6ae',width:f.get('kind')==='route'?3:1.5,lineDash:f.get('kind')==='guide'?[6,5]:undefined}),
            fill:new ol.style.Fill({color:'rgba(255,60,80,.24)'})})});
        c.map.addLayer(layer);
        let active=false, reference=[], preview=null, worker=null, timer=null, serial=0;
        const guides=[undefined,2].map(maxPoints=>new ol.interaction.Draw({type:'LineString',stopClick:true,maxPoints,
            freehandCondition:e=>maxPoints!==2&&e.originalEvent.shiftKey,
            style:new ol.style.Style({stroke:new ol.style.Stroke({color:'#ffd166',width:2,lineDash:[6,5]})})}));
        guides.forEach(g=>{g.setActive(false);c.map.addInteraction(g);});let guide=guides[0];
        const assisted=()=>$('route-method').value!=='manual';
        const message=t=>{$('route-error').textContent=t;};
        function stop(){serial++;if(worker)worker.terminate();worker=null;clearTimeout(timer);timer=null;$('route-plan').disabled=false;}
        function invalidate(){stop();preview=null;$('route-use').disabled=true;source.getFeatures().filter(f=>f.get('kind')!=='guide').forEach(f=>source.removeFeature(f));}
        function reset(){invalidate();reference=[];guides.forEach(g=>{g.abortDrawing();g.setActive(false);});source.clear();}
        function addGeometry(geometry,kind){const f=new ol.Feature(geometry);f.set('kind',kind);source.addFeature(f);return f;}
        function drawReference(){reset();if(!active)c.start();guide.setActive(true);c.manual.setActive(false);message($('route-method').value==='auto'?'Click start and end, then Enter.':'Draw reference waypoints, or hold Shift and drag a line. Enter finishes.');c.map.getTargetElement().focus();}
        function spec(){const s=c.settings();s.clearance=Number($('route-clearance').value);s.gridSize=Number($('route-grid').value);
            s.avoidGds=$('route-avoid-gds').checked;s.avoidImages=$('route-avoid-images').checked;s.imageThreshold=Number($('route-threshold').value);s.imageMode=$('route-image-mode').value;
            if(!Number.isFinite(s.clearance)||s.clearance<0||!Number.isFinite(s.gridSize)||s.gridSize<=0)throw Error('Use nonnegative clearance and a positive search grid.');return s;}
        function fingerprint(){return JSON.stringify({context:c.context(),spec:spec(),gds:$('route-avoid-gds').checked,images:$('route-avoid-images').checked,threshold:$('route-threshold').value,mode:$('route-image-mode').value,
            geometry:c.features().map(f=>[f.getId(),f.getRevision(),f.getGeometry()?.getRevision()]),imagesState:c.images().map(i=>[i.imageId,i.img.src,root.MicroscopeOverlay.serialize(i)])});}
        function geometryObstacles(features){
            const out=[];
            features.forEach(f=>{const g=f.getGeometry();if(!g)return;const type=g.getType();
                if(type==='Polygon')out.push({rings:g.getCoordinates()});
                else if(type==='MultiPolygon')g.getCoordinates().forEach(rings=>out.push({rings}));
                else if(type==='Circle'){const center=g.getCenter(),r=g.getRadius()/Math.cos(Math.PI/32),ring=[];for(let n=0;n<=32;n++)ring.push([center[0]+r*Math.cos(n*2*Math.PI/32),center[1]+r*Math.sin(n*2*Math.PI/32)]);out.push({rings:[ring]});}
                else if(type==='LineString'){
                    // A bounding box per segment is conservative for existing annotation strokes.
                    const pts=g.getCoordinates(),half=(f.get('route')?.width||0)/2+1e-7;
                    for(let n=1;n<pts.length;n++){const a=pts[n-1],b=pts[n],x0=Math.min(a[0],b[0])-half,y0=Math.min(a[1],b[1])-half,x1=Math.max(a[0],b[0])+half,y1=Math.max(a[1],b[1])+half;out.push({rings:[[[x0,y0],[x1,y0],[x1,y1],[x0,y1],[x0,y0]]]});}
                }
            });return out;
        }
        function collect(){
            const obstacles=$('route-avoid-gds').checked?geometryObstacles(c.features()):[],imagePolygons=[],warnings=[];
            let images=0,pixels=0;const names=[];
            if($('route-avoid-images').checked){
                const threshold=Number($('route-threshold').value);if(!Number.isInteger(threshold)||threshold<1||threshold>255)throw Error('Edge threshold must be an integer from 1 to 255.');
                for(const state of c.images()){
                    if(state.visible===false)continue;images++;names.push(state.name||'Image');
                    if(images>8)throw Error('At most eight visible images can be routed together. Hide unrelated images.');
                    const image=state.img,w=image.naturalWidth,h=image.naturalHeight;
                    if(!w||!h)throw Error('Wait for image loading before routing.');
                    const scale=Math.min(1,192/Math.max(w,h)),sw=Math.max(1,Math.ceil(w*scale)),sh=Math.max(1,Math.ceil(h*scale));
                    const canvas=document.createElement('canvas');canvas.width=sw;canvas.height=sh;const ctx=canvas.getContext('2d',{willReadFrequently:true});ctx.drawImage(image,0,0,sw,sh);
                    const mask=root.RouteImageMask.fromPixels({data:ctx.getImageData(0,0,sw,sh).data,width:sw,height:sh,threshold,mode:$('route-image-mode').value});
                    pixels+=mask.counts.occupied;warnings.push(...mask.warnings.map(t=>(state.name||'Image')+': '+t));
                    const H=root.MicroscopeOverlay.transform(state,w,h);
                    const signs=[[0,0],[w,0],[w,h],[0,h]].map(p=>H[6]*p[0]+H[7]*p[1]+H[8]);
                    if(signs.some(v=>!Number.isFinite(v)||Math.abs(v)<1e-10)||Math.min(...signs)<0&&Math.max(...signs)>0)throw Error('Image transform crosses a projective horizon. Realign the image.');
                    const polys=root.RouteImageMask.toObstacles(mask,(x,y)=>root.NumberedMarkerAlignment.project(H,[x*w/sw,y*h/sh]));
                    if(polys.failures?.length)throw Error('Image mask transform failed. Realign the image.');
                    imagePolygons.push(...polys);obstacles.push(...polys);
                }
            }
            if(obstacles.length>20000)throw Error('Too many obstacle pieces. Reduce image detail or route a smaller layout.');
            return {obstacles,imagePolygons,summary:`${obstacles.length-imagePolygons.length} layout pieces; ${images} visible images${names.length?' ('+names.join(', ')+')':''}, ${pixels} blocked mask cells (image analysis up to 192 px). ${warnings.join(' ')}`};
        }
        function showMask(data){source.getFeatures().filter(f=>f.get('kind')==='mask').forEach(f=>source.removeFeature(f));data.imagePolygons.forEach(p=>addGeometry(new ol.geom.Polygon(p.rings),'mask'));}
        function mask(){try{invalidate();const data=collect();showMask(data);message(data.summary);}catch(e){message(e.message);}}
        function plan(){
            invalidate();try{
                if(!active)return;
                if(reference.length<2)throw Error('Draw a reference or choose two endpoints first.');
                const s=spec(),data=collect(),signature=fingerprint(),token=serial;
                showMask(data);message('Finding route… '+data.summary);$('route-plan').disabled=true;
                const code=root.routePlannerWorkerSource+'\nself.onmessage=function(e){self.postMessage(RoutePlanner.plan(e.data));};';
                const url=URL.createObjectURL(new Blob([code],{type:'text/javascript'}));
                try{worker=new Worker(url);}finally{URL.revokeObjectURL(url);}
                timer=setTimeout(()=>{stop();message('Routing reached the time limit. Increase the search grid or shorten the reference.');},15000);
                worker.onerror=()=>{stop();message('Routing worker failed; no route was created.');};
                worker.onmessage=e=>{if(token!==serial)return;const result=e.data;stop();
                    try{if(fingerprint()!==signature)throw Error('Layout, images or settings changed. Find the route again.');
                        if(!result.ok)throw Error(result.error+' Try a larger grid, different guide or clear endpoints.');
                        if(!root.ManhattanRoute.validate(result.points,s.style))throw Error('Planner returned invalid angle constraints.');
                        preview={points:result.points,spec:s,signature};addGeometry(new ol.geom.LineString(result.points),'route').set('width',s.width);$('route-use').disabled=false;
                        $('route-points').value=JSON.stringify(result.points);message('Green route ready. Use route to save. '+data.summary);
                    }catch(error){message(error.message);}
                };
                worker.postMessage({...s,start:reference[0],end:reference[reference.length-1],reference:s.method==='guided'?reference:undefined,obstacles:data.obstacles,maxCells:40000});
            }catch(error){stop();message(error.message);}
        }
        guides.forEach(g=>g.on('drawend',e=>{reference=e.feature.getGeometry().simplify(Math.max(.001,Number($('route-grid').value)||1)*.2).getCoordinates().map(p=>p.slice());
            if($('route-method').value==='auto'&&reference.length>2)reference=[reference[0],reference[reference.length-1]];
            source.clear();addGeometry(new ol.geom.LineString(reference),'guide');guide.setActive(false);if(reference.length>1000){message('Reference has too many turns. Draw a shorter guide.');return;}setTimeout(plan,0);
        }));
        function setActive(value){active=value;reset();guide=$('route-method').value==='auto'?guides[1]:guides[0];guide.setActive(value&&assisted());if(value){c.manual.setActive(!assisted());$('route-assist-controls').hidden=!assisted();$('route-finish').hidden=false;
            $('route-order').disabled=assisted();
            $('route-help').textContent=assisted()?($('route-method').value==='auto'?'Click two endpoints. Review the preview, then Use route.':'Draw a reference with clicks or Shift-drag. Enter finishes. The router can leave the guide to avoid obstacles.'):'Click waypoints; Enter finishes, Backspace removes the last point, Escape cancels.';
            message($('route-help').textContent);}}
        $('route-method').addEventListener('change',()=>{if(!active)c.start();else setActive(true);});
        $('route-style').addEventListener('change',()=>{invalidate();if(active&&!assisted()){$('route-order').dispatchEvent(new Event('change'));}});
        ['route-width','route-layer','route-clearance','route-grid','route-avoid-gds','route-avoid-images','route-image-mode','route-threshold'].forEach(id=>$(id).addEventListener('input',invalidate));
        $('route-redraw').onclick=drawReference;$('route-mask').onclick=mask;$('route-plan').onclick=plan;
        $('route-cancel-preview').onclick=()=>{reset();message('Preview cancelled. Draw a new reference to continue.');};
        $('route-use').onclick=()=>{try{if(!preview)throw Error('Find a route first.');if(fingerprint()!==preview.signature){invalidate();throw Error('Layout, image placement or settings changed. Find the route again.');}const saved=preview;reset();c.commit(saved.points,saved.spec);}catch(e){message(e.message);}};
        document.addEventListener('keydown',e=>{if(!active||/INPUT|TEXTAREA|SELECT|BUTTON/.test(e.target.tagName)||e.target.isContentEditable)return;if(e.key==='Backspace'){e.preventDefault();if(assisted())guide.removeLastPoint();else c.manual.removeLastPoint();}});
        return {setActive,isAssisted:assisted,finish:()=>guide.finishDrawing(),invalidate,reset,plan,collect,getReference:()=>reference.map(p=>p.slice())};
    }
    root.RouteAssist={mount};
})(globalThis);
