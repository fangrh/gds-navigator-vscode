/* Docked EDA workspace. Reuses the existing controls and their event handlers. */
(function(root){
    'use strict';
    function mount(config){
        const doc=document,body=doc.body,$=id=>doc.getElementById(id);
        if($('eda-header'))return;
        const create=(tag,id,text)=>{const el=doc.createElement(tag);if(id)el.id=id;if(text)el.textContent=text;return el;};
        const button=(id,text,title,fn)=>{const el=create('button',id,text);el.type='button';el.title=title;el.setAttribute('aria-label',title);el.onclick=fn;return el;};
        const panels={images:[$('image-controls')],properties:[$('shape-properties'),$('route-controls')],components:[$('primitive-controls')],changes:[$('instruction-list')],review:[$('review-tools')]};
        const labels={images:'Images',properties:'Properties',components:'Components',changes:'Work orders',review:'Review'};
        let stored={};try{stored=config.api?.getState?.()?.workbench||{};}catch(_){}
        let active=Object.hasOwn(labels,stored.active)?stored.active:'images';
        let collapsed=typeof stored.collapsed==='boolean'?stored.collapsed:window.innerWidth<950;
        let layersCollapsed=stored.layersCollapsed===true;
        let resizeFrame=null,stateFrame=null,disposed=false;
        let savedKey=JSON.stringify({active:stored.active,collapsed:stored.collapsed,layersCollapsed:stored.layersCollapsed});
        const header=create('header','eda-header'),identity=create('div','eda-document','GDS Navigator');
        identity.title='Current GDS layout';header.append(identity);
        const nav=doc.querySelector('nav[aria-label="GDS navigation"]');header.append(nav);
        const zoom=$('zoom-controls');zoom.setAttribute('role','toolbar');zoom.setAttribute('aria-label','Build and view controls');header.append(zoom);
        const shell=create('main','eda-body'),dock=create('aside','eda-dock');dock.setAttribute('aria-label','Layout inspector');
        const dockHeader=create('div','eda-dock-header'),title=create('strong','eda-dock-title','Inspector');
        dockHeader.append(title,button('eda-dock-close','×','Collapse inspector',()=>{collapsed=true;render();$('eda-dock-toggle').focus();}));
        const tabs=create('div','eda-tabs');tabs.setAttribute('role','tablist');tabs.setAttribute('aria-label','Inspector views');
        const content=create('div','eda-dock-content');
        content.setAttribute('role','tabpanel');content.tabIndex=0;
        const empty=create('div','eda-empty');empty.setAttribute('role','status');
        dock.append(dockHeader,tabs,content);content.append(empty);
        for(const [name,nodes] of Object.entries(panels)){
            const tab=button('eda-tab-'+name,labels[name],'Show '+labels[name].toLowerCase(),()=>{config.open?.(name);activate(name);});
            tab.setAttribute('role','tab');tabs.append(tab);
            tab.setAttribute('aria-controls','eda-dock-content');
            tab.addEventListener('keydown',event=>{const names=Object.keys(labels),index=names.indexOf(name);let next;
                if(event.key==='ArrowRight')next=names[(index+1)%names.length];if(event.key==='ArrowLeft')next=names[(index+names.length-1)%names.length];if(event.key==='Home')next=names[0];if(event.key==='End')next=names.at(-1);
                if(next){event.preventDefault();event.stopPropagation();$('eda-tab-'+next).click();$('eda-tab-'+next).focus();}
            });
            nodes.forEach(node=>content.append(node));
        }
        nav.append(button('eda-layers-toggle','Layers','Show or hide layer panel',()=>{if(window.innerWidth<=760&&!collapsed){collapsed=true;layersCollapsed=false;}else layersCollapsed=!layersCollapsed;render();}),button('eda-dock-toggle','Inspector','Show or hide inspector',()=>{collapsed=!collapsed;render();}),button('eda-reset','Reset UI','Restore default panel arrangement',()=>{layersCollapsed=false;collapsed=window.innerWidth<950;active='images';render();}));
        const status=create('footer','eda-status');status.append(create('span','eda-coordinates','X —   Y — µm'),create('span','eda-selection','0 selected'),create('span',null,'F2 · fit   Shift+F2 · selection   E / Tab · properties   Esc · cancel'));
        $('map-container').append(status);shell.append($('sidebar'),$('map-container'),dock);body.prepend(header,shell);body.classList.add('eda-workbench');
        $('draw-toolbar').setAttribute('role','toolbar');$('draw-toolbar').setAttribute('aria-label','Drawing and image tools');
        doc.querySelectorAll('.tool-btn,.zoom-btn').forEach(el=>{if(!el.hasAttribute('aria-label'))el.setAttribute('aria-label',el.title);});
        function available(node){if(node.id==='shape-properties')return !!node.querySelector('.gds-shape-properties:not([hidden])');return !node.hidden;}
        function persist(){
            stateFrame=null;const workbench={active,collapsed,layersCollapsed},key=JSON.stringify(workbench);
            if(key===savedKey)return;
            try{config.api?.setState?.({...config.api?.getState?.(),workbench});savedKey=key;}catch(_){}
        }
        function save(){if(!disposed&&stateFrame===null)stateFrame=requestAnimationFrame(persist);}
        function requestResize(){
            if(disposed||resizeFrame!==null)return;
            resizeFrame=requestAnimationFrame(()=>{resizeFrame=null;if(!disposed)config.resize?.();});
        }
        function render(){
            body.classList.toggle('dock-collapsed',collapsed);body.classList.toggle('layers-collapsed',layersCollapsed);
            $('eda-dock-toggle').setAttribute('aria-expanded',String(!collapsed));$('eda-layers-toggle').setAttribute('aria-expanded',String(!layersCollapsed&&(collapsed||window.innerWidth>760)));
            title.textContent=labels[active];
            content.setAttribute('aria-labelledby','eda-tab-'+active);
            for(const [name,nodes] of Object.entries(panels)){
                const tab=$('eda-tab-'+name);tab.setAttribute('aria-selected',String(name===active));tab.tabIndex=name===active?0:-1;
                nodes.forEach(node=>node.dataset.edaActive=String(name===active));
            }
            empty.hidden=panels[active].some(available);
            empty.textContent={images:'Insert a microscope image from the right toolbar. Images are drawn below GDS elements.',properties:'Select one element, then press E or Tab to inspect its geometry or edit a drawn proposal.',components:'Open the shape chooser from the right toolbar to search components.',changes:'Open Work orders from the right toolbar to review this GDS queue.'}[active];
            save();requestResize();
        }
        function activate(name){
            if(disposed||!Object.hasOwn(labels,name))return;
            if(active===name&&!collapsed){empty.hidden=panels[active].some(available);return;}
            active=name;collapsed=false;render();
        }
        const visibility=new Map();Object.values(panels).flat().forEach(node=>visibility.set(node,available(node)));
        const observer=new MutationObserver(()=>{
            let opened;
            for(const [name,nodes] of Object.entries(panels))for(const node of nodes){const visible=available(node);if(visible&&!visibility.get(node))opened=name;visibility.set(node,visible);}
            if(opened)activate(opened);else empty.hidden=panels[active].some(available);
        });
        Object.values(panels).flat().forEach(node=>observer.observe(node,{subtree:true,attributes:true,attributeFilter:['hidden'],childList:true}));
        ['img-insert-btn','img-move-btn','img-align-btn'].forEach(id=>$(id).addEventListener('click',()=>activate('images')));
        const resizeObserver=new ResizeObserver(requestResize);resizeObserver.observe($('map'));
        render();
        let coordinateFrame=null,latestPoint=null;
        function coordinates(point){
            if(disposed)return;
            latestPoint=point?point.slice():null;
            if(coordinateFrame!==null)return;
            coordinateFrame=requestAnimationFrame(()=>{
                coordinateFrame=null;
                const text=latestPoint?'X '+latestPoint[0].toFixed(3)+'   Y '+latestPoint[1].toFixed(3)+' µm':'X —   Y — µm';
                const label=$('eda-coordinates');if(label.textContent!==text)label.textContent=text;
            });
        }
        return {activate,isActive:name=>!collapsed&&active===name,document:(file)=>{identity.textContent=String(file||'GDS Navigator').split(/[\\/]/).pop();identity.title=String(file||'GDS Navigator');},selection:(count)=>{$('eda-selection').textContent=count+' selected';},coordinates,dispose:()=>{if(stateFrame!==null){cancelAnimationFrame(stateFrame);persist();}disposed=true;if(resizeFrame!==null)cancelAnimationFrame(resizeFrame);if(coordinateFrame!==null)cancelAnimationFrame(coordinateFrame);observer.disconnect();resizeObserver.disconnect();}};
    }
    root.EdaWorkbench={mount};
})(window);
