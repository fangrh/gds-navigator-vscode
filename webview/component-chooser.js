/* Small, protocol-only component catalog chooser. It owns no map state. */
(function (root) {
    'use strict';
    function mount(config) {
        if (!config || !config.container || typeof config.postMessage !== 'function') throw new Error('ComponentChooser requires container and postMessage');
        const container = config.container, post = config.postMessage, onInsert = typeof config.onInsert === 'function' ? config.onInsert : function () {};
        let requestSerial = 0, catalogRequest = null, previewRequest = null, catalog = [], selected = null, preview = null;
        const el = (tag, text) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; return node; };
        const button = (text) => { const node = el('button', text); node.type = 'button'; return node; };
        const status = el('div'); status.setAttribute('role', 'status');
        const search = document.createElement('input'); search.type = 'search'; search.placeholder = 'Search components'; search.setAttribute('aria-label', 'Search components');
        const list = el('div'); list.setAttribute('role', 'listbox');
        const detail = el('div');
        const settings = document.createElement('textarea'); settings.value = '{}'; settings.setAttribute('aria-label', 'Component settings JSON'); settings.rows = 5;
        const previewButton = button('Preview component'); previewButton.disabled = true;
        const insertButton = button('Insert at view center'); insertButton.hidden = true;
        const heading = el('strong', 'Component catalog');
        const close = button('×'); close.setAttribute('aria-label', 'Close catalog'); close.title = 'Close catalog'; close.addEventListener('click', () => { container.hidden = true; });
        const shell = el('div'); shell.className = 'component-chooser';
        const top = el('div'); top.style.display = 'flex'; top.style.justifyContent = 'space-between'; top.style.alignItems = 'center'; top.append(heading, close); shell.append(top, search, status, list, detail); container.textContent = ''; container.appendChild(shell);
        detail.appendChild(el('div', 'Choose a factory to inspect its parameters.'));
        function message(text, isError) { status.textContent = text || ''; status.dataset.level = isError ? 'error' : 'info'; }
        function signature(item) {
            return '(' + (item.parameters || []).map(p => p.name + (p.required ? '' : '=' + (Object.prototype.hasOwnProperty.call(p, 'default') ? JSON.stringify(p.default) : '…'))).join(', ') + ')';
        }
        function renderList() {
            list.textContent = '';
            const query = search.value.trim().toLowerCase();
            const matches = catalog.filter(item => !query || item.name.toLowerCase().includes(query) || String(item.description || '').toLowerCase().includes(query));
            if (!matches.length) { list.appendChild(el('div', catalog.length ? 'No matching components.' : 'No components loaded.')); return; }
            matches.slice(0, 500).forEach(item => { const row = button(item.name + signature(item)); row.setAttribute('role', 'option'); row.title = item.description || item.name; row.addEventListener('click', () => select(item)); list.appendChild(row); });
        }
        function select(item) {
            selected = item; previewRequest = null; preview = null; previewButton.disabled = false; insertButton.hidden = true; settings.value = '{}'; detail.textContent = '';
            detail.appendChild(el('h4', item.name)); detail.appendChild(el('p', item.description || 'No documentation available.')); detail.appendChild(el('p', signature(item)));
            const labels = el('div'); (item.parameters || []).forEach(p => { const text = p.required ? `${p.name} (required)` : `${p.name}: ${Object.prototype.hasOwnProperty.call(p, 'default') ? JSON.stringify(p.default) : 'default unavailable'}`; labels.appendChild(el('div', text)); });
            detail.appendChild(labels); detail.appendChild(settings); detail.appendChild(previewButton); detail.appendChild(insertButton);
        }
        function open() {
            container.hidden = false; search.focus(); if(catalog.length){previewRequest=null;preview=null;insertButton.hidden=true;renderList();return;} const requestId = String(++requestSerial); catalogRequest = requestId; previewRequest = null; catalog = []; selected = null; preview = null; renderList(); message('Loading component catalog…');
            post({ type: 'requestComponentCatalog', requestId });
        }
        previewButton.addEventListener('click', () => {
            if (!selected) return;
            let parsed; try { parsed = JSON.parse(settings.value || '{}'); } catch { message('Settings must be valid JSON.', true); return; }
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { message('Settings must be a JSON object.', true); return; }
            const requestId = String(++requestSerial); previewRequest = requestId; insertButton.hidden = true; message('Building preview…');
            post({ type: 'previewComponent', requestId, name: selected.name, settings: parsed });
        });
        settings.addEventListener('input', () => {preview=null;previewRequest=null;insertButton.hidden=true;});
        insertButton.addEventListener('click', () => { if (preview) onInsert(preview); });
        search.addEventListener('input', renderList);
        function handleMessage(msg) {
            if (!msg || typeof msg !== 'object') return false;
            if (msg.type === 'componentCatalog' && msg.requestId === catalogRequest) { catalog = msg.result && Array.isArray(msg.result.components) ? msg.result.components : []; renderList(); message(`${catalog.length} components available.`); return true; }
            if (msg.type === 'componentPreview' && msg.requestId === previewRequest) { preview = msg.result; insertButton.hidden = !preview; message(preview ? 'Preview ready.' : 'Preview was empty.'); return true; }
            if (msg.type === 'componentError' && (msg.requestId === catalogRequest || msg.requestId === previewRequest)) { message(String(msg.error || 'Component request failed.'), true); return true; }
            return false;
        }
        container.hidden = true;
        return { open, handleMessage };
    }
    root.ComponentChooser = { mount };
})(globalThis);
