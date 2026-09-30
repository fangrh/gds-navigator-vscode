/* Small, protocol-only component catalog chooser. It owns no map state. */
(function (root) {
    'use strict';
    function mount(config) {
        if (!config || !config.container || typeof config.postMessage !== 'function') throw new Error('ComponentChooser requires container and postMessage');
        const container = config.container, post = config.postMessage, onInsert = typeof config.onInsert === 'function' ? config.onInsert : function () {};
        let requestSerial = 0, catalogRequest = null, previewRequest = null, previewKey = null;
        let catalog = [], selected = null, preview = null, largePreview = null, placeWhenReady = false;
        const thumbnails = new Map(), visibleNames = new Set(); let thumbnailRequest = null, thumbnailTimer = null, thumbnailDeadline = null;
        const rows = new Map(), svgCache = new Map(), MAX_SVG_CACHE = 64; let emptyMessage = null;
        const onPlace = typeof config.onPlace === 'function' ? config.onPlace : onInsert;
        const cache = new Map(), MAX_CACHE = 24;
        const el = (tag, text) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; return node; };
        const button = (text) => { const node = el('button', text); node.type = 'button'; return node; };
        const status = el('div'); status.setAttribute('role', 'status');
        const search = document.createElement('input'); search.type = 'search'; search.placeholder = 'Search components'; search.setAttribute('aria-label', 'Search components');
        const category = document.createElement('select'); category.setAttribute('aria-label', 'Filter component category');
        const list = el('div'); list.setAttribute('role', 'listbox');
        const detail = el('div');
        const settings = document.createElement('textarea'); settings.setAttribute('aria-label', 'Component settings JSON'); settings.rows = 5;
        const previewButton = button('Preview component'); previewButton.disabled = true;
        const insertButton = button('Insert at view center'); insertButton.hidden = true;
        const placeButton = button('Place on canvas'); placeButton.hidden = true; placeButton.addEventListener('click', () => { if(preview) onPlace(preview); });
        const heading = el('strong', 'Component catalog');
        const refresh = button('Refresh'); refresh.setAttribute('aria-label', 'Refresh component library');
        refresh.title = 'Reload built-in and project components from gds_components.py';
        refresh.addEventListener('click', () => { if (typeof config.onRefresh === 'function') config.onRefresh(); invalidateCache(); open(); });
        const close = button('×'); close.setAttribute('aria-label', 'Close catalog'); close.title = 'Close catalog'; close.addEventListener('click', () => { container.hidden = true; });
        const shell = el('div'); shell.className = 'component-chooser';
        const top = el('div'); top.style.display = 'flex'; top.style.justifyContent = 'space-between'; top.style.alignItems = 'center'; top.append(heading, category, refresh, close);
        shell.append(top, search, status, list, detail); container.textContent = ''; container.appendChild(shell);
        detail.appendChild(el('div', 'Choose a factory to inspect its parameters.'));
        function message(text, isError) { status.textContent = text || ''; status.dataset.level = isError ? 'error' : 'info'; }
        function signature(item) { return '(' + (item.parameters || []).map(p => p.name + (p.required ? '' : '=' + (Object.prototype.hasOwnProperty.call(p, 'default') ? JSON.stringify(p.default) : '…'))).join(', ') + ')'; }
        function defaults() { return {}; }
        function settingsKey(item, value) { return item.name + '|' + JSON.stringify(value); }
        function categoryName(item) { if (item.category || item.group || item.kind) return String(item.category || item.group || item.kind); const name = String(item.name || 'Other'); return name.split(/[._-]/)[0] || 'Other'; }
        function setCategories() { const names = Array.from(new Set(catalog.map(categoryName))).sort((a, b) => a.localeCompare(b)); category.textContent = ''; const all = el('option', 'All categories'); all.value = ''; category.appendChild(all); category.value = ''; names.forEach(name => { const option = el('option', name); option.value = name; category.appendChild(option); }); }
        function geometrySvg(geojson, large) {
            const cacheKey = geojson && (typeof geojson === 'object' ? geojson : null);
            const cachedSet = cacheKey && svgCache.get(cacheKey), cached = cachedSet && cachedSet[large ? 'large' : 'thumb'];
            if (cached) return cached.cloneNode(true);
            const features = geojson && Array.isArray(geojson.features) ? geojson.features : [], points = [], paths = [];
            function visit(coords) { if (!Array.isArray(coords)) return; if (typeof coords[0] === 'number') { points.push(coords); return; } coords.forEach(visit); }
            features.forEach(f => { const g = f && f.geometry; if (g && g.coordinates) { visit(g.coordinates); paths.push(g); } });
            if (!points.length) return el('div', 'Geometry unavailable');
            let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity; points.forEach(p => { const x = Number(p[0]), y = Number(p[1]); if (Number.isFinite(x) && Number.isFinite(y)) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); } }); if (!Number.isFinite(minX)) return el('div', 'Geometry unavailable');
            const pad = Math.max(maxX - minX, maxY - minY, 1) * 0.08, width = Math.max(maxX - minX + pad * 2, 1), height = Math.max(maxY - minY + pad * 2, 1);
            const svg = document.createElementNS ? document.createElementNS('http://www.w3.org/2000/svg', 'svg') : el('div'); svg.setAttribute('viewBox', `${minX - pad} ${minY - pad} ${width} ${height}`); svg.setAttribute('aria-label', large ? 'Component geometry preview' : 'Component geometry thumbnail'); svg.style.width = large ? '100%' : '96px'; svg.style.height = large ? '180px' : '64px';
            paths.forEach(g => {
                const polygons = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
                polygons.forEach(rings => {
                    const d = rings.map(line => line.filter(p => Number.isFinite(p[0]) && Number.isFinite(p[1])).map((p,i) => `${i ? 'L' : 'M'} ${p[0]} ${maxY + minY - p[1]}`).join(' ') + ' Z').join(' ');
                    const path = document.createElementNS ? document.createElementNS('http://www.w3.org/2000/svg', 'path') : el('span');
                    path.setAttribute('d',d); path.setAttribute('fill','rgba(80,180,220,.35)'); path.setAttribute('fill-rule','evenodd'); path.setAttribute('stroke','#49b7d6'); path.setAttribute('stroke-width','1'); path.setAttribute('vector-effect','non-scaling-stroke'); svg.appendChild(path);
                });
            });
            if (cacheKey) {
                const set = svgCache.get(cacheKey) || {};
                set[large ? 'large' : 'thumb'] = svg;
                svgCache.set(cacheKey, set);
                while (svgCache.size > MAX_SVG_CACHE) svgCache.delete(svgCache.keys().next().value);
            }
            return svg;
        }
        function applyThumbnail(item, result, target) { const thumb = target || item._thumbnail, geojson = result && result.geojson; if (thumb && thumb.__componentGeojson !== geojson) { thumb.textContent = ''; thumb.appendChild(geometrySvg(geojson, false)); thumb.__componentGeojson = geojson; } }
        const observer = typeof IntersectionObserver === 'function' ? new IntersectionObserver(entries => {
            entries.forEach(entry => { const name=entry.target.dataset.name; if(entry.isIntersecting) visibleNames.add(name); else visibleNames.delete(name); }); scheduleThumbnails();
        }, {root:list, rootMargin:'80px'}) : null;
        function scheduleThumbnails(){ if(thumbnailTimer) clearTimeout(thumbnailTimer); thumbnailTimer=setTimeout(loadThumbnails,40); }
        function loadThumbnails(){
            thumbnailTimer=null;if(thumbnailRequest||container.hidden)return;
            const names=Array.from(visibleNames).filter(name=>!thumbnails.has(name)).slice(0,8);if(!names.length)return;
            const requestId='thumb-'+String(++requestSerial);thumbnailRequest={requestId,names};
            names.forEach(name=>{const item=catalog.find(x=>x.name===name);if(item&&item._thumbnail)item._thumbnail.textContent='Loading shape…';});
            thumbnailDeadline=setTimeout(()=>{if(thumbnailRequest&&thumbnailRequest.requestId===requestId){names.forEach(name=>thumbnails.set(name,{error:'Preview timed out; click to retry'}));thumbnailRequest=null;renderList();}},50000);
            post({type:'requestComponentThumbnails',requestId,names});
        }
        function renderList() {
            const query = search.value.trim().toLowerCase(), wanted = category.value;
            const matches = catalog.filter(item => (!wanted || categoryName(item) === wanted) && (!query || item.name.toLowerCase().includes(query) || String(item.description || '').toLowerCase().includes(query))).slice(0, 500);
            const wantedNames = new Set(matches.map(item => item.name));
            rows.forEach((entry, name) => { if (!wantedNames.has(name)) { if (observer) observer.unobserve(entry.row); visibleNames.delete(name); entry.row.remove(); rows.delete(name); } });
            if (!matches.length) { list.textContent = ''; emptyMessage = el('div', catalog.length ? 'No matching components.' : 'No components loaded.'); emptyMessage.className = 'component-catalog-empty'; list.appendChild(emptyMessage); return; }
            if (emptyMessage) { list.textContent = ''; emptyMessage = null; }
            matches.forEach((item, index) => {
                let entry = rows.get(item.name);
                if (!entry) {
                    const row = button(), thumb = el('span', 'Shape preview'); row.dataset.name=item.name; thumb.className = 'component-card-thumb'; row.className = 'component-card'; row.setAttribute('role', 'option'); row.addEventListener('click', () => select(item));
                    const name = el('span', item.name); name.className = 'component-card-name'; row.append(thumb, name); entry = { item, row, thumb }; rows.set(item.name, entry);
                }
                entry.item = item; item._thumbnail = entry.thumb; entry.row.title = item.description || item.name; entry.row.setAttribute('aria-selected', String(item === selected));
                const cached = cache.get(settingsKey(item, defaults(item))), icon = thumbnails.get(item.name);
                if (cached) applyThumbnail(item, cached, entry.thumb); else if(icon&&icon.geojson)applyThumbnail(item,icon,entry.thumb); else if(icon&&icon.error){entry.thumb.textContent=(item.parameters||[]).some(p=>p.required)?'Settings required':'Preview unavailable';entry.thumb.title=icon.error;}
                if (list.children[index] !== entry.row) { if (typeof list.insertBefore === 'function') list.insertBefore(entry.row, list.children[index] || null); else list.appendChild(entry.row); }
                if (observer) observer.observe(entry.row); else if (visibleNames.size < 8) visibleNames.add(item.name);
            });
            scheduleThumbnails();
        }
        function updateSelectedRow() { rows.forEach(entry => entry.row.setAttribute('aria-selected', String(entry.item === selected))); }
        function showLargePreview(result) { if (!largePreview) { largePreview = el('div'); detail.appendChild(largePreview); } largePreview.textContent = ''; largePreview.appendChild(geometrySvg(result.geojson, true)); }
        function requestPreview(item, parsed, automatic) {
            const key = settingsKey(item, parsed), cached = cache.get(key); if (cached) { preview = cached; previewKey = key; previewRequest = null; showLargePreview(cached); applyThumbnail(item, cached); insertButton.hidden = false; placeButton.hidden=false; if(placeWhenReady){placeWhenReady=false;onPlace(cached);} if (!automatic) message('Preview ready.'); return; }
            const requestId = String(++requestSerial); previewRequest = requestId; previewKey = key; preview = null; insertButton.hidden = true; message(automatic ? 'Loading geometry thumbnail…' : 'Building preview…'); post({ type: 'previewComponent', requestId, name: item.name, settings: parsed });
        }
        function select(item) {
            selected = item; updateSelectedRow(); placeWhenReady=true; placeButton.hidden=true; previewRequest = null; previewKey = null; preview = null; previewButton.disabled = false; insertButton.hidden = true; const initial = defaults(item); settings.value = JSON.stringify(initial, null, 2); detail.textContent = ''; largePreview = null;
            detail.appendChild(el('h4', item.name)); largePreview=el('div'); detail.appendChild(largePreview); detail.appendChild(el('p', item.description || 'No documentation available.')); if (item.library) detail.appendChild(el('p', 'Project component · gds_components.py')); detail.appendChild(el('p', signature(item))); const labels = el('div'); (item.parameters || []).forEach(p => labels.appendChild(el('div', p.required ? `${p.name} (required)` : `${p.name}: ${Object.prototype.hasOwnProperty.call(p, 'default') ? JSON.stringify(p.default) : 'default unavailable'}`))); detail.appendChild(labels); detail.appendChild(settings); detail.appendChild(previewButton); detail.appendChild(placeButton); detail.appendChild(insertButton);
            const missing = (item.parameters || []).some(p => p.required && !Object.prototype.hasOwnProperty.call(initial, p.name)); if (missing) detail.appendChild(el('div', 'Enter required settings to load geometry.')); else requestPreview(item, initial, true);
        }
        function open() { container.hidden = false; search.focus(); if (catalog.length) { renderList(); return; } const requestId = String(++requestSerial); catalogRequest = requestId; catalog = []; selected = null; preview = null; renderList(); message('Loading component catalog…'); post({ type: 'requestComponentCatalog', requestId }); }
        previewButton.addEventListener('click', () => { if (!selected) return; let parsed; try { parsed = JSON.parse(settings.value || '{}'); } catch { message('Settings must be valid JSON.', true); return; } if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { message('Settings must be a JSON object.', true); return; } placeWhenReady=false;requestPreview(selected, parsed, false); });
        settings.addEventListener('input', () => { preview = null; placeWhenReady=false; placeButton.hidden=true; previewRequest = null; previewKey = null; insertButton.hidden = true; }); insertButton.addEventListener('click', () => { if (preview) onInsert(preview); }); search.addEventListener('input', renderList); category.addEventListener('change', renderList);
        function handleMessage(msg) {
            if (!msg || typeof msg !== 'object') return false;
            if(msg.type==='componentThumbnails'&&thumbnailRequest&&msg.requestId===thumbnailRequest.requestId){
                clearTimeout(thumbnailDeadline);const items=msg.result&&msg.result.items||[];
                thumbnailRequest.names.forEach(name=>{const value=items.find(x=>x.name===name)||{error:'Shape unavailable'}; thumbnails.set(name,value); const entry=rows.get(name); if(entry){ if(value.geojson) applyThumbnail(entry.item,value,entry.thumb); else {entry.thumb.textContent=(entry.item.parameters||[]).some(p=>p.required)?'Settings required':'Preview unavailable'; entry.thumb.title=value.error||'';} }});thumbnailRequest=null;scheduleThumbnails();return true;
            }
            if(msg.type==='componentError'&&thumbnailRequest&&msg.requestId===thumbnailRequest.requestId){clearTimeout(thumbnailDeadline);thumbnailRequest.names.forEach(name=>{const value={error:msg.error}; thumbnails.set(name,value); const entry=rows.get(name); if(entry){entry.thumb.textContent=(entry.item.parameters||[]).some(p=>p.required)?'Settings required':'Preview unavailable';entry.thumb.title=msg.error;}});thumbnailRequest=null;scheduleThumbnails();return true;}

            if (msg.type === 'componentCatalog' && msg.requestId === catalogRequest) { catalog = msg.result && Array.isArray(msg.result.components) ? msg.result.components.slice().sort((a, b) => String(a.name).localeCompare(String(b.name))) : []; setCategories(); renderList(); const warnings = msg.result && msg.result.warnings || []; message(`${catalog.length} components available.${warnings.length ? ' ' + warnings.join(' ') : ''}`, warnings.length > 0); return true; }
            if (msg.type === 'componentPreview' && msg.requestId === previewRequest) { preview = msg.result; previewRequest = null; if (preview) { cache.set(previewKey, preview); while (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value); applyThumbnail(selected, preview); } insertButton.hidden = !preview; placeButton.hidden=!preview; if (preview) showLargePreview(preview); message(preview ? 'Click the canvas to place; Tab edits placement.' : 'Preview was empty.'); if(preview&&placeWhenReady){placeWhenReady=false;onPlace(preview);} return true; }
            if (msg.type === 'componentError' && (msg.requestId === catalogRequest || msg.requestId === previewRequest)) { message(String(msg.error || 'Component request failed.'), true); return true; } return false;
        }
        function invalidateCache() { cache.clear();thumbnails.clear();svgCache.clear();visibleNames.clear();clearTimeout(thumbnailTimer);clearTimeout(thumbnailDeadline);thumbnailRequest=null;placeWhenReady=false;placeButton.hidden=true; catalog = []; catalogRequest = null; previewRequest = null; previewKey = null; selected = null; preview = null; previewButton.disabled=true; insertButton.hidden = true; detail.textContent = ''; largePreview = null; rows.forEach(entry => { if(observer) observer.unobserve(entry.row); entry.row.remove(); }); rows.clear(); renderList(); }
        container.hidden = true; return { open, handleMessage, cancelPendingPlacement:()=>{placeWhenReady=false;}, invalidateCache };
    }
    root.ComponentChooser = { mount };
})(globalThis);
