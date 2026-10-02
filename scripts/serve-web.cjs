#!/usr/bin/env node
'use strict';
// Local development host: serves the live viewer and reuses the real domain contracts.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const ROOT = path.resolve(__dirname, '..');
const MAX_BYTES = 48 * 1024 * 1024;
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const canonical = file => process.platform === 'win32' ? file.toLowerCase() : file;
const within = (root, file) => canonical(file) === canonical(root) || canonical(file).startsWith(canonical(root + path.sep));
const clone = value => JSON.parse(JSON.stringify(value));

function services() {
    const result = require('esbuild').buildSync({ entryPoints: [path.join(ROOT, 'web/host-services.ts')], bundle: true, platform: 'node', format: 'cjs', write: false });
    const mod = { exports: {} };
    new Function('require', 'module', 'exports', '__dirname', result.outputFiles[0].text)(require, mod, mod.exports, path.join(ROOT, 'scripts'));
    return mod.exports;
}

function validateGeojson(value) {
    const depths = { Point: 0, MultiPoint: 1, LineString: 1, MultiLineString: 2, Polygon: 2, MultiPolygon: 3 };
    const coords = (v, depth) => depth === 0 ? Array.isArray(v) && v.length === 2 && v.every(Number.isFinite) : Array.isArray(v) && v.every(c => coords(c, depth - 1));
    if (!value || value.type !== 'FeatureCollection' || !Array.isArray(value.features) || !value.features.every(f => f?.type === 'Feature' && depths[f.geometry?.type] !== undefined && coords(f.geometry.coordinates, depths[f.geometry.type]))) throw new Error('Expected a valid GeoJSON FeatureCollection with finite 2D coordinates.');
}

async function startServer(options = {}) {
    const root = fs.realpathSync(path.resolve(options.root || ROOT));
    const stateDir = path.resolve(options.stateDir || path.join(ROOT, 'logs/browser-dev', digest(canonical(root)).slice(0, 16)));
    fs.mkdirSync(stateDir, { recursive: true });
    const uploadDir = path.join(stateDir, 'uploads'); fs.mkdirSync(uploadDir, { recursive: true });
    const python = options.python || process.env.GDS_PYTHON || [path.join(root, '.venv-fork/Scripts/python.exe'), path.join(root, '.venv/Scripts/python.exe'), path.join(root, '.venv/bin/python')].find(fs.existsSync) || 'python';
    const s = services();
    const queue = new s.InstructionQueue(stateDir);
    const snapshots = new s.ReviewSnapshotStore(path.join(stateDir, 'snapshots'));
    const documents = new Map();
    let writes = Promise.resolve();
    const serial = fn => { const next = writes.catch(() => {}).then(fn); writes = next; return next; };
    const sample = path.join(ROOT, 'test/fixtures/jj_pad_center_50_geo.json');
    const resolveFile = value => {
        if (typeof value !== 'string' || !value || value.includes('\0')) throw new Error('Choose a file inside the configured workspace.');
        const file = fs.realpathSync(path.resolve(root, value));
        if (!within(root, file) && !within(fs.realpathSync(uploadDir), file) && file !== sample) throw new Error('File is outside the configured workspace.');
        if (!fs.statSync(file).isFile()) throw new Error('Expected a file.');
        return file;
    };
    const stateFile = file => path.join(stateDir, digest(canonical(file)) + '.json');
    const initialState = () => ({ version: 1, annotations: [], images: [], review: s.emptyReviewState() });
    function readState(file) {
        try {
            const value = JSON.parse(fs.readFileSync(stateFile(file), 'utf8'));
            if (value.version !== 1 || !s.validateAnnotations(value.annotations) || !s.validateReviewState(value.review) || !Array.isArray(value.images)) throw new Error('Invalid browser state; original file preserved.');
            return value;
        } catch (e) { if (e.code === 'ENOENT') return initialState(); throw e; }
    }
    function saveState(doc) {
        const file = stateFile(doc.file), temp = file + '.' + crypto.randomUUID() + '.tmp';
        const text = JSON.stringify(doc.state);
        if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('Browser state exceeds 48 MiB; remove an image before saving.');
        fs.writeFileSync(temp, text, { flag: 'wx' });
        try { fs.renameSync(temp, file); } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
    }
    function instructions(doc) {
        queue.reload();
        const records = queue.list(doc.file).map(record => {
            const tracking = s.trackWorkOrder(record, doc.hash, doc.catalog, doc.state.annotations);
            return { ...record, tracking, current_targets: doc.catalog.filter(c => tracking.targetIds.includes(c.provId)) };
        });
        return { type: 'instructions', gdsPath: doc.file, location: queue.location, records, nextOpen: records.find(r => r.status === 'open')?.id };
    }
    async function load(fileName) {
        const file = resolveFile(fileName);
        const ext = path.extname(file).toLowerCase();
        if (!['.gds', '.json', '.geojson'].includes(ext)) throw new Error('Open a .gds, .geojson or GeoJSON .json file.');
        if (fs.statSync(file).size > 64 * 1024 * 1024) throw new Error('Layout exceeds the 64 MiB development-host limit.');
        const raw = fs.readFileSync(file), hash = digest(raw);
        const parsed = ext === '.gds' ? await s.parseGdsFileCore(python, file, ROOT) : undefined;
        const geojson = parsed ? parsed.geojson : JSON.parse(raw.toString('utf8'));
        validateGeojson(geojson);
        if (digest(fs.readFileSync(file)) !== hash) throw new Error('Layout changed during parsing; reload it.');
        const resolveReference = s.createSourceResolver([path.dirname(file), root]);
        geojson.features.forEach((f, i) => {
            f.properties ||= {}; f.properties.element_id = s.elementId(f, i);
            resolveReference(f.properties.provenance);
            if (Array.isArray(f.properties.provenance?.call_chain)) f.properties.provenance.call_chain.forEach(resolveReference);
        });
        const state = readState(file);
        const catalog = geojson.features.map(f => ({ provId: f.properties.element_id, layer: `${f.properties.layer}/${f.properties.data_type}`, bbox: f.properties.bbox, geometry: f.geometry, provenance: f.properties.provenance || {} }));
        for (const p of geojson.ports || []) if (p.coordinate_frame === 'layout' && Array.isArray(p.center)) catalog.push({ provId: p.id, layer: Array.isArray(p.layer) ? p.layer.join('/') : p.layer, bbox: [...p.center, ...p.center], geometry: { type: 'Point', coordinates: p.center }, provenance: p.provenance || {}, port: p });
        const doc = { file, hash, geojson, catalog, state, pythonFile: ext === '.gds' ? s.deriveScriptFromSidecar(file) || '' : '' };
        documents.set(canonical(file), doc);
        const warnings = parsed?.warnings || geojson._diag?.sidecar_warnings || [];
        const full = geojson.features.length > 0 && geojson.features.every(f => typeof f.properties.provenance?.file === 'string' && Number.isInteger(f.properties.provenance.line) && f.properties.provenance.line > 0) && !warnings.length;
        const baseline = await snapshots.record(file, hash, geojson.features);
        return { messages: [
            { type: 'loadGds', geojson, gdsPath: file, pythonFile: doc.pythonFile, annotations: state.annotations, mode: parsed?.mode || (full ? 'full' : 'partial'), warnings, layoutHash: hash },
            { type: 'reviewState', gdsPath: file, layoutHash: hash, state: state.review },
            { type: 'reviewBaseline', gdsPath: file, layoutHash: hash, ...baseline }, instructions(doc),
            ...state.images.map((image, i) => ({ type: 'loadImage', dataUrl: image.dataUrl, fileName: image.fileName, imageId: image.imageId, append: true, order: i, savedState: image.state ? { ...image.state, ...(image.layoutHash !== hash ? { quality: { status: 'unverified', boundaryRmsPx: null, markerCount: 0 } } : {}) } : undefined }))
        ] };
    }
    function requireHash(doc, message) {
        if (message.layoutHash !== doc.hash || digest(fs.readFileSync(doc.file)) !== doc.hash) throw new Error('Layout changed; reload before saving or exporting.');
    }
    async function message(fileName, m) {
        const file = resolveFile(fileName), doc = documents.get(canonical(file));
        if (!doc) throw new Error('Load this layout first.');
        if (!m || typeof m.type !== 'string') throw new Error('Invalid host message.');
        const result = { messages: [] }, reply = (type, fields = {}) => result.messages.push({ type, ...fields });
        const before = clone(doc.state);
        try {
            switch (m.type) {
            case 'saveAnnotations': {
                requireHash(doc, m);
                if (!s.validateAnnotations(m.annotations)) throw new Error('Invalid annotations; saved drawings preserved.');
                doc.state.annotations = m.annotations; saveState(doc);
                if (m.recordInstruction && JSON.stringify(before.annotations) !== JSON.stringify(m.annotations)) {
                    const { changed, removed } = s.annotationChanges(before.annotations, m.annotations);
                    const components = [...(m.components || []).filter(c => !c.drawn), ...[...changed, ...removed].map(a => ({ provId: a.id, drawn: true, geometry: a.geometry, primitive: a.primitive, factory: a.factory, route: a.route, layer: a.primitive?.layer || a.layer, intent: { ...a.intent, ...(removed.includes(a) ? { action: 'delete', text: 'Remove this proposal; review whether it has already been implemented.' } : {}) } }))];
                    queue.reload();
                    try {
                        queue.add({ gdsPath: file, gdsHash: doc.hash, components, request: { action: 'inspect', text: changed.length ? 'Review browser drawing changes.' : 'Remove the proposed drawings.' }, beforeAnnotations: before.annotations, afterAnnotations: m.annotations, catalog: doc.catalog, generatingScript: doc.pythonFile, topCell: doc.geojson.top_cell });
                    } catch (error) { doc.state = before; saveState(doc); throw error; }
                    reply('instructions', instructions(doc));
                }
                reply('annotationsSaved'); break;
            }
            case 'saveReviewState':
                requireHash(doc, m);
                if (!s.validateReviewState(m.state)) throw new Error('Invalid review state.');
                doc.state.review = m.state; saveState(doc); reply('reviewStateSaved', { requestId: m.requestId, ok: true }); break;
            case 'importImage': {
                if (typeof m.dataUrl !== 'string' || m.dataUrl.length > 28 * 1024 * 1024 || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(m.dataUrl)) throw new Error('Choose a PNG, JPEG or WebP image under 20 MiB.');
                const image = { imageId: crypto.randomUUID(), fileName: path.basename(String(m.fileName || 'image.png')), dataUrl: m.dataUrl, layoutHash: doc.hash };
                doc.state.images.push(image); saveState(doc); reply('loadImage', { ...image, append: true, order: doc.state.images.length - 1 }); break;
            }
            case 'saveImageState': {
                requireHash(doc, m);
                const image = doc.state.images.find(i => i.imageId === m.imageId);
                if (!image || !s.validateAlignmentState(m.state)) throw new Error('Image state is invalid or the image was removed.');
                image.state = m.state; image.layoutHash = doc.hash; saveState(doc); reply('imageStateSaved', { imageId: m.imageId, revision: m.revision }); break;
            }
            case 'clearImageState': doc.state.images = doc.state.images.filter(i => i.imageId !== m.imageId); saveState(doc); break;
            case 'reorderImages':
                requireHash(doc, m);
                if (!Array.isArray(m.imageIds) || m.imageIds.length !== doc.state.images.length || new Set(m.imageIds).size !== m.imageIds.length || !m.imageIds.every(id => doc.state.images.some(i => i.imageId === id))) throw new Error('Invalid image order.');
                doc.state.images = m.imageIds.map(id => doc.state.images.find(i => i.imageId === id)); saveState(doc); break;
            case 'requestComponentCatalog': reply('componentCatalog', { requestId: m.requestId, result: await s.loadComponentCatalog(python, undefined, undefined, m.refresh === true) }); break;
            case 'previewComponent': reply('componentPreview', { requestId: m.requestId, result: await s.previewComponent(python, m.name, m.settings) }); break;
            case 'requestComponentThumbnails': reply('componentThumbnails', { requestId: m.requestId, result: await s.requestComponentThumbnails(python, m.names) }); break;
            case 'exportYaml': {
                requireHash(doc, m);
                if (!Array.isArray(m.components) || !m.components.length) throw new Error('Select an element first.');
                const payload = s.selectionDocument(file, doc.hash, m.components, doc.geojson.top_cell, { request: m.request, catalog: doc.catalog, generatingScript: doc.pythonFile });
                result.clipboard = { text: s.toYaml(payload) + '\n', handoff: payload.handoff }; break;
            }
            case 'instructionAction': {
                queue.reload();
                if (m.action === 'add') {
                    requireHash(doc, m);
                    if (!Array.isArray(m.components) || !m.components.length || !m.request?.text?.trim()) throw new Error('Select elements and describe the work order.');
                    const record = queue.add({ gdsPath: file, gdsHash: doc.hash, components: m.components, request: m.request, beforeAnnotations: doc.state.annotations, afterAnnotations: doc.state.annotations, generatingScript: doc.pythonFile, catalog: doc.catalog, topCell: doc.geojson.top_cell });
                    reply('instructionAdded', { requestId: m.requestId, id: record.id, gdsPath: file });
                } else if (m.action !== 'refresh') {
                    const record = m.id ? queue.get(m.id) : undefined;
                    if (m.action !== 'copyOpen' && (!record || canonical(record.gdsPath) !== canonical(file))) throw new Error('Work order does not belong to this document.');
                    if (m.action === 'comment') { queue.comment(m.id, m.text); reply('instructionCommented', { requestId: m.requestId, id: m.id }); }
                    else if (m.action === 'done') queue.setStatus(m.id, 'done', m.note);
                    else if (m.action === 'revert') throw new Error('Source-file undo is only available in the extension or work-order CLI. Browser debug mode does not modify source files.');
                    else if (['copyRef', 'copyDetails', 'copyOpen'].includes(m.action)) result.clipboard = { text: s.toYaml({ schema: 'gds-navigator.instructions', queue_file: queue.location, records: m.action === 'copyOpen' ? queue.list(file).filter(r => r.status === 'open') : [record] }), instruction: true };
                    else throw new Error('Unsupported work-order action.');
                }
                reply('instructions', instructions(doc)); break;
            }
            case 'exportReviewCapture':
                requireHash(doc, m);
                if (typeof m.pngDataUrl !== 'string' || !m.pngDataUrl.startsWith('data:image/png;base64,') || m.pngDataUrl.length > 28 * 1024 * 1024) throw new Error('Expected a PNG capture under 20 MiB.');
                result.download = { name: 'gds-review.png', dataUrl: m.pngDataUrl, mime: 'image/png' }; reply('reviewCaptureResult', { requestId: m.requestId, ok: true, path: 'browser download: gds-review.png' }); break;
            case 'exportSession': result.download = { name: path.basename(file) + '.browser-session.json', text: JSON.stringify({ documentPath: file, layoutHash: doc.hash, ...doc.state, instructions: queue.list(file) }, null, 2), mime: 'application/json' }; break;
            case 'requestSource': case 'openPython': {
                const source = resolveFile(m.type === 'requestSource' ? m.file : doc.pythonFile);
                if (!/\.(py|txt|md)$/i.test(source) || fs.statSync(source).size > 2 * 1024 * 1024) throw new Error('Source preview supports text/Python files under 2 MiB inside the configured workspace.');
                result.download = { name: path.basename(source), text: fs.readFileSync(source, 'utf8'), mime: 'text/plain' }; result.notice = `Source downloaded: ${path.basename(source)}${m.line ? ':' + m.line : ''}`; break;
            }
            case 'relatedFiles': result.notice = `Layout: ${file}\nPython: ${doc.pythonFile || 'not linked'}\nBrowser state: ${stateFile(file)}\nWork orders: ${queue.location}`; break;
            case 'associateScript': result.notice = 'Link or build generating scripts in your terminal/extension. The browser reads existing GDS and provenance sidecars.'; break;
            case 'rebuild': return { ...(await load(file)), notice: 'Reloaded the file from disk. Run your Python generator in a terminal to rebuild geometry.' };
            case 'selectComponents': case 'viewerContext': case 'debugInfo': case 'debugError': case 'usageEvent': case 'usageEvents': case 'imageTransform': case 'imageAligned': case 'webviewReady': break;
            default: result.notice = `Browser host does not support: ${m.type}`;
            }
        } catch (error) {
            if (!['requestComponentCatalog', 'requestComponentThumbnails', 'previewComponent'].includes(m.type)) doc.state = before;
            const type = ({ saveAnnotations: 'annotationsSaveFailed', saveReviewState: 'reviewStateError', saveImageState: 'imageNotice', importImage: 'imageNotice', exportYaml: 'copyResult', instructionAction: 'instructionError', exportReviewCapture: 'reviewCaptureResult', requestComponentCatalog: 'componentError', requestComponentThumbnails: 'componentError', previewComponent: 'componentError' })[m.type];
            if (!type) throw error;
            reply(type, { requestId: m.requestId, imageId: m.imageId, ok: false, error: error.message, message: error.message });
            result.notice = error.message;
        }
        return result;
    }
    function files() {
        const result = []; let visited = 0;
        function walk(dir, depth = 0) {
            if (depth > 6 || result.length >= 250 || visited > 5000) return;
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                if (++visited > 5000 || result.length >= 250) break;
                if (e.isSymbolicLink() || e.name.startsWith('.') || ['node_modules', 'logs', 'dist', 'backlog'].includes(e.name)) continue;
                const file = path.join(dir, e.name);
                if (e.isDirectory()) walk(file, depth + 1);
                else if (/\.(gds|geojson)$/i.test(e.name) || /(?:geo|geojson).*\.json$/i.test(e.name)) result.push({ path: file, name: path.relative(root, file) });
            }
        }
        walk(root);
        if (!result.some(f => f.path === sample)) result.unshift({ path: sample, name: 'Built-in sample' });
        return result;
    }
    async function body(req) {
        if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw Object.assign(new Error('Use application/json.'), { status: 415 });
        const chunks = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > MAX_BYTES) throw Object.assign(new Error('Request exceeds 48 MiB.'), { status: 413 }); chunks.push(chunk); }
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    }
    let url;
    const server = http.createServer(async (req, res) => {
        res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
        const json = (value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
        try {
            const host = req.headers.host;
            const allowed = new Set([new URL(url).host, `localhost:${server.address().port}`]);
            if (!allowed.has(host) || (req.headers.origin && ![url, `http://localhost:${server.address().port}`].includes(req.headers.origin))) return json({ error: 'Only same-origin loopback requests are allowed.' }, 403);
            const route = new URL(req.url, url).pathname;
            if (req.method === 'GET' && route === '/api/config') return json({ root, python, stateDir, files: files(), defaultFile: options.file ? resolveFile(options.file) : sample });
            if (req.method === 'POST') {
                const input = await body(req);
                if (route === '/api/load') return json(await serial(() => load(input.path)));
                if (route === '/api/message') {
                    // Catalog work cannot hold the persistence queue while Python starts.
                    const catalog = ['requestComponentCatalog', 'requestComponentThumbnails', 'previewComponent'].includes(input.message?.type);
                    return json(await (catalog ? message(input.documentPath, input.message) : serial(() => message(input.documentPath, input.message))));
                }
                if (route === '/api/upload') {
                    if (typeof input.name !== 'string' || /[\\/:<>|?*\x00-\x1f]/.test(input.name) || input.name !== path.basename(input.name) || !/\.(gds|geojson|json)$/i.test(input.name) || typeof input.base64 !== 'string' || !/^[A-Za-z0-9+/=]*$/.test(input.base64)) throw new Error('Upload a named GDS or GeoJSON file.');
                    const bytes = Buffer.from(input.base64, 'base64');
                    if (!bytes.length || bytes.length > 32 * 1024 * 1024) throw new Error('Upload must contain 1 byte to 32 MiB.');
                    const dir = path.join(uploadDir, digest(bytes)); fs.mkdirSync(dir, { recursive: true });
                    const file = path.join(dir, input.name); fs.writeFileSync(file, bytes); return json({ path: file });
                }
                return json({ error: 'Unknown endpoint.' }, 404);
            }
            if (req.method !== 'GET') return json({ error: 'Method not allowed.' }, 405);
            if (route === '/') {
                const { renderViewer } = require('./render-viewer.cjs');
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(renderViewer({ browser: true }));
            }
            if (route === '/favicon.ico') { res.writeHead(204); return res.end(); }
            const decoded = decodeURIComponent(route);
            if (!/^\/(webview\/[\w-]+\.(?:js|css)|web\/browser-host\.(?:js|css)|media\/(?:ol\.(?:js|css)|geometry-kernel\.js))$/.test(decoded)) return json({ error: 'Not found.' }, 404);
            const file = fs.realpathSync(path.join(ROOT, decoded.slice(1)));
            if (!within(ROOT, file)) return json({ error: 'Not found.' }, 404);
            const mime = path.extname(file) === '.css' ? 'text/css' : 'text/javascript';
            res.writeHead(200, { 'Content-Type': mime + '; charset=utf-8' }); fs.createReadStream(file).pipe(res);
        } catch (error) { if (!res.headersSent) json({ error: error.message }, error.status || 400); else res.end(); }
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 4173, '127.0.0.1', resolve); });
    url = `http://127.0.0.1:${server.address().port}`;
    return { server, url, close: async () => { await writes.catch(() => {}); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}

if (require.main === module) {
    const args = process.argv.slice(2), options = {};
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--help') { console.log('Usage: npm run dev:web -- [--port 4173] [--root PATH] [--file PATH] [--python EXE] [--state-dir PATH]\nLocal browser debugging; no VS Code required. Data stays in logs/browser-dev by default.'); process.exit(0); }
        const key = { '--port': 'port', '--root': 'root', '--file': 'file', '--python': 'python', '--state-dir': 'stateDir' }[args[i]];
        if (!key || !args[i + 1]) { console.error('Unknown or missing argument:', args[i]); process.exit(1); }
        options[key] = key === 'port' ? Number(args[++i]) : args[++i];
    }
    startServer(options).then(host => {
        console.log(`GDS Navigator browser: ${host.url}\nLive viewer sources; reload the page after editing. Ctrl+C stops the host.`);
        process.on('SIGINT', () => host.close().then(() => process.exit()));
        process.on('SIGTERM', () => host.close().then(() => process.exit()));
    }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { startServer, validateGeojson };
