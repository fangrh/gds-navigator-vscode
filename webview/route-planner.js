(function (root, factory) {
    var api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.RoutePlanner = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
    'use strict';
    var EPS = 1e-9;
    function finite(n) { return typeof n === 'number' && Number.isFinite(n); }
    function pt(p) { return Array.isArray(p) && p.length === 2 && finite(p[0]) && finite(p[1]); }
    function d2(a,b){var x=a[0]-b[0],y=a[1]-b[1];return x*x+y*y;}
    function dist(a,b){return Math.sqrt(d2(a,b));}
    function orient(a,b,c){return (b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);}
    function onSeg(a,b,p){return Math.abs(orient(a,b,p))<=EPS && p[0]>=Math.min(a[0],b[0])-EPS&&p[0]<=Math.max(a[0],b[0])+EPS&&p[1]>=Math.min(a[1],b[1])-EPS&&p[1]<=Math.max(a[1],b[1])+EPS;}
    function segHit(a,b,c,d){var o1=orient(a,b,c),o2=orient(a,b,d),o3=orient(c,d,a),o4=orient(c,d,b);if(((o1>EPS&&o2<-EPS)||(o1<-EPS&&o2>EPS))&&((o3>EPS&&o4<-EPS)||(o3<-EPS&&o4>EPS)))return true;return (Math.abs(o1)<=EPS&&onSeg(a,b,c))||(Math.abs(o2)<=EPS&&onSeg(a,b,d))||(Math.abs(o3)<=EPS&&onSeg(c,d,a))||(Math.abs(o4)<=EPS&&onSeg(c,d,b));}
    function segDist(a,b,p){var vx=b[0]-a[0],vy=b[1]-a[1],l=vx*vx+vy*vy;if(l<=EPS)return dist(a,p);var t=((p[0]-a[0])*vx+(p[1]-a[1])*vy)/l;t=Math.max(0,Math.min(1,t));return dist([a[0]+t*vx,a[1]+t*vy],p);}
    function edgeDist(a,b,c,d){if(segHit(a,b,c,d))return 0;return Math.min(segDist(a,b,c),segDist(a,b,d),segDist(c,d,a),segDist(c,d,b));}
    function ringInside(p,ring){var inside=false;for(var i=0,j=ring.length-1;i<ring.length;j=i++){var a=ring[i],b=ring[j];if(onSeg(a,b,p))return true;if((a[1]>p[1])!==(b[1]>p[1])&&p[0]<(b[0]-a[0])*(p[1]-a[1])/(b[1]-a[1])+a[0])inside=!inside;}return inside;}
    function obstacleInside(p,o){return ringInside(p,o.rings[0])&&!o.rings.slice(1).some(function(r){return ringInside(p,r);});}
    function normalizeObstacles(input){if(input===undefined)return [];if(!Array.isArray(input))throw new TypeError('obstacles must be an array');return input.map(function(o){if(!o||!Array.isArray(o.rings)||!o.rings.length)throw new TypeError('obstacle rings are required');var rings=o.rings.map(function(r){if(!Array.isArray(r)||r.length<3||r.some(function(p){return !pt(p);}))throw new TypeError('obstacle ring must contain finite points');return r.map(function(p){return [p[0],p[1]];});});return {rings:rings,id:o.id};});}
    function clearSegment(a,b,obstacles,radius,collision){if(collision){var clear=collision.clear(a,b,radius);if(clear!==undefined)return clear;}for(var oi=0;oi<obstacles.length;oi++){var o=obstacles[oi];if(obstacleInside(a,o)||obstacleInside(b,o))return false;for(var ri=0;ri<o.rings.length;ri++){var r=o.rings[ri];for(var i=0;i<r.length;i++){if(edgeDist(a,b,r[i],r[(i+1)%r.length])<=radius+EPS)return false;}}}return true;}
    function createCollision(obs){try{return root&&root.GdsGeometryKernel?root.GdsGeometryKernel.create(obs):null;}catch(_){return null;}}
    function checkSegments(points,obs,radius,collision){if(!Array.isArray(points)||points.length<1||points.some(function(p){return !pt(p);})||!finite(radius)||radius<0)return false;for(var i=1;i<points.length;i++)if(!clearSegment(points[i-1],points[i],obs,radius,collision))return false;return true;}
    function isClear(points,obstacles,radius){if(!Array.isArray(points)||points.length<1||points.some(function(p){return !pt(p);})||!finite(radius)||radius<0)return false;var obs;try{obs=normalizeObstacles(obstacles);}catch(_){return false;}var collision=createCollision(obs);try{return checkSegments(points,obs,radius,collision);}finally{if(collision)collision.dispose();}}
    function pointClear(p,obs,r,collision){return clearSegment(p,p,obs,r,collision);}
    function compact(ps){var out=[];ps.forEach(function(p){if(!out.length||d2(out[out.length-1],p)>EPS*EPS)out.push([p[0],p[1]]);while(out.length>=3){var a=out[out.length-3],b=out[out.length-2],c=out[out.length-1];if(Math.abs(orient(a,b,c))<=EPS&&((b[0]-a[0])*(c[0]-b[0])+(b[1]-a[1])*(c[1]-b[1])>=-EPS))out.splice(out.length-2,1);else break;}});return out;}
    function refDistance(p,ref){if(!ref||ref.length<2)return 0;var best=Infinity;for(var i=1;i<ref.length;i++)best=Math.min(best,segDist(ref[i-1],ref[i],p));return best;}
    function plan(spec){
        var stats={expanded:0,cells:0},collision=null;
        try{
            if(!spec||typeof spec!=='object'||!pt(spec.start)||!pt(spec.end))return {ok:false,error:'start and end must be finite 2D points',stats:stats};if(d2(spec.start,spec.end)<=EPS*EPS)return {ok:false,error:'start and end must be distinct',stats:stats};
            var style=spec.style===undefined?'manhattan':spec.style;if(style!=='manhattan'&&style!=='octilinear')return {ok:false,error:'style must be manhattan or octilinear',stats:stats};
            var width=spec.width===undefined?0:spec.width,clearance=spec.clearance===undefined?0:spec.clearance;if(!finite(width)||width<0||!finite(clearance)||clearance<0)return {ok:false,error:'width and clearance must be non-negative',stats:stats};
            var radius=width/2+clearance,obs=normalizeObstacles(spec.obstacles),ref=spec.reference;if(ref!==undefined&&(!Array.isArray(ref)||ref.some(function(p){return !pt(p);})))return {ok:false,error:'reference must contain finite 2D points',stats:stats};
            var grid=spec.gridSize===undefined?0:spec.gridSize;if(grid!==0&&(!finite(grid)||grid<=0))return {ok:false,error:'gridSize must be positive',stats:stats};
            var maxCells=spec.maxCells===undefined?40000:spec.maxCells;if(!Number.isInteger(maxCells)||maxCells<1)return {ok:false,error:'maxCells must be a positive integer',stats:stats};var maxExpanded=spec.maxExpanded===undefined?Math.min(100000,maxCells*8):spec.maxExpanded;if(!Number.isInteger(maxExpanded)||maxExpanded<1)return {ok:false,error:'maxExpanded must be a positive integer',stats:stats};
            collision=createCollision(obs);
            if(!pointClear(spec.start,obs,radius,collision)||!pointClear(spec.end,obs,radius,collision))return {ok:false,error:'blocked endpoint',stats:stats};
            var anchors=[spec.start,spec.end].concat(ref||[]),minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity;anchors.forEach(function(p){minX=Math.min(minX,p[0]);maxX=Math.max(maxX,p[0]);minY=Math.min(minY,p[1]);maxY=Math.max(maxY,p[1]);});
            var span=Math.max(maxX-minX,maxY-minY,1),baseGrid=grid||Math.max(span/180,Math.max(radius,1)/2),pad=Math.max(span*0.5,radius*3,baseGrid*8);minX-=pad;maxX+=pad;minY-=pad;maxY+=pad;
            grid=grid||Math.max(span/180,Math.max(radius,1)/2);var nx=Math.ceil((maxX-minX)/grid)+1,ny=Math.ceil((maxY-minY)/grid)+1;stats.cells=nx*ny;if(stats.cells>maxCells)return {ok:false,error:'search budget exceeded: grid has '+stats.cells+' cells',stats:stats};
            function coord(ix,iy){return [minX+ix*grid,minY+iy*grid];}function nearest(p){return [Math.max(0,Math.min(nx-1,Math.round((p[0]-minX)/grid))),Math.max(0,Math.min(ny-1,Math.round((p[1]-minY)/grid)))];}
            var s=nearest(spec.start),t=nearest(spec.end),key=function(x,y){return x+','+y};
            function heuristic(a,b){var dx=Math.abs(a[0]-b[0]),dy=Math.abs(a[1]-b[1]);return style==='manhattan'?(dx+dy)*grid:Math.max(dx,dy)*grid+(Math.SQRT2-1)*Math.min(dx,dy)*grid;}
            var startKey=key(s[0],s[1]),goalKey=key(t[0],t[1]),open=[{x:s[0],y:s[1],g:0,f:heuristic(s,t)}],best=new Map([[startKey,0]]),came=new Map(),closed=new Set();
            var dirs=style==='manhattan'?[[1,0],[-1,0],[0,1],[0,-1]]:[[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,1],[1,-1],[-1,-1]];
            function pop(){var bi=0;for(var i=1;i<open.length;i++)if(open[i].f<open[bi].f||open[i].f===open[bi].f&&(open[i].y<open[bi].y||open[i].y===open[bi].y&&open[i].x<open[bi].x))bi=i;return open.splice(bi,1)[0];}
            var found=null;while(open.length){var cur=pop(),ck=key(cur.x,cur.y);if(closed.has(ck))continue;closed.add(ck);stats.expanded++;if(stats.expanded>maxExpanded)return {ok:false,error:'search budget exceeded: expansion cap reached',stats:stats};if(ck===goalKey){found=cur;break;}for(var di=0;di<dirs.length;di++){var dx=dirs[di][0],dy=dirs[di][1],x=cur.x+dx,y=cur.y+dy;if(x<0||x>=nx||y<0||y>=ny)continue;var nk=key(x,y);if(closed.has(nk))continue;var a=coord(cur.x,cur.y),b=coord(x,y);if(!pointClear(b,obs,radius,collision)||!clearSegment(a,b,obs,radius,collision))continue;var step=dist(a,b),mid=[(a[0]+b[0])/2,(a[1]+b[1])/2],g=cur.g+step*(1+(ref?Math.min(0.75,refDistance(mid,ref)/(span+1)):0));if(g>=(best.get(nk)??Infinity)-EPS)continue;best.set(nk,g);came.set(nk,ck);open.push({x:x,y:y,g:g,f:g+heuristic([x,y],t)});}}
            if(!found)return {ok:false,error:'no collision-free route',stats:stats};
            var cells=[],k=goalKey;while(true){var parts=k.split(',').map(Number);cells.push(coord(parts[0],parts[1]));if(k===startKey)break;k=came.get(k);}cells.reverse();
            function connector(from,to){var candidates=[ [from,[to[0],from[1]],to], [from,[from[0],to[1]],to] ];for(var ci=0;ci<candidates.length;ci++){var c=compact(candidates[ci]);if(checkSegments(c,obs,radius,collision))return c.slice(1);}return null;}
            var lead=connector(spec.start,cells[0]),tail=connector(cells[cells.length-1],spec.end);if(!lead||!tail)return {ok:false,error:'no collision-free endpoint connector',stats:stats};var points=[spec.start].concat(lead,cells.slice(1),tail,[spec.end]);points=compact(points);
            function reduce(route){var changed=true;while(changed){changed=false;for(var i=0;i<route.length-2&&!changed;i++){for(var j=route.length-1;j>=i+3;j--){var a=route[i],b=route[j],c1=[a,[b[0],a[1]],b],c2=[a,[a[0],b[1]],b],chosen=null;for(var ci=0;ci<2;ci++){var c=compact(ci?c2:c1);if((style==='manhattan'||c.every(function(p,n){if(n===0)return true;var dx=Math.abs(p[0]-c[n-1][0]),dy=Math.abs(p[1]-c[n-1][1]);return dx<=EPS||dy<=EPS||Math.abs(dx-dy)<=EPS;}))&&checkSegments(c,obs,radius,collision)){chosen=c;break;}}if(chosen){route=route.slice(0,i).concat(chosen,route.slice(j+1));changed=true;break;}}}}return route;}
            if(!ref)points=reduce(points);if(points.some(function(p,i){if(i===0)return false;var dx=Math.abs(p[0]-points[i-1][0]),dy=Math.abs(p[1]-points[i-1][1]);return dx>EPS&&dy>EPS&&(style==='manhattan'||Math.abs(dx-dy)>EPS);}))return {ok:false,error:'internal geometry validation failed',stats:stats};if(!checkSegments(points,obs,radius,collision))return {ok:false,error:'final route collision validation failed',stats:stats};return {ok:true,points:points,stats:stats};
        }catch(e){return {ok:false,error:e.message||String(e),stats:stats};}finally{if(collision)collision.dispose();}
    }
    return {plan:plan,isClear:isClear};
}));
