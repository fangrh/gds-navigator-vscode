(function () {
  'use strict';
  var currentPath = '', generation = 0, loading = false, state = {}, queue = Promise.resolve();
  var readyResolve, ready = new Promise(function (resolve) { readyResolve = resolve; });
  var debug = window.__gdsDebug = { sent: [], received: [], errors: [], timings: [] };
  window.__sent = debug.sent; window.__pageErrors = debug.errors;

  function compact(value, depth) {
    if (typeof value === 'string') return value.length > 300 ? value.slice(0, 100) + '… (' + value.length + ' chars)' : value;
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return { length: value.length, sample: depth < 2 ? value.slice(0, 2).map(function (x) { return compact(x, depth + 1); }) : undefined };
    if (depth >= 3) return { keys: Object.keys(value).slice(0, 12) };
    var result = {}; Object.keys(value).slice(0, 24).forEach(function (key) { result[key] = compact(value[key], depth + 1); }); return result;
  }
  function record(kind, value) {
    var entries = debug[kind]; entries.push(kind === 'errors' ? String(value) : compact(value, 0));
    if (entries.length > 200) entries.shift();
  }
  function status(text) { var el = document.getElementById('browser-host-status'); if (el) el.textContent = text || ''; }
  function fail(error) { var text = String(error && error.message || error); record('errors', text); status('Browser host: ' + text); }
  async function json(url, data) {
    var response = await fetch(url, data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    var result = await response.json(); if (!response.ok) throw Error(result.error || 'HTTP ' + response.status); return result;
  }
  function deliver(messages, expected) {
    if (expected !== undefined && expected !== generation) return;
    (messages || []).forEach(function (message) { record('received', message); window.dispatchEvent(new MessageEvent('message', { data: message })); });
  }
  function download(file) {
    var anchor = document.createElement('a'); anchor.download = file.name || 'gds-download';
    anchor.href = file.dataUrl || URL.createObjectURL(new Blob([file.text || ''], { type: file.mime || 'application/octet-stream' }));
    anchor.click(); if (!file.dataUrl) setTimeout(function () { URL.revokeObjectURL(anchor.href); }, 1000);
  }
  async function responseActions(body, message, expected) {
    if (expected !== generation) return;
    if (body.clipboard) {
      try {
        if (!navigator.clipboard) throw Error('Clipboard unavailable. Allow clipboard access in this browser.');
        await navigator.clipboard.writeText(body.clipboard.text);
        deliver([body.clipboard.instruction ? { type: 'instructionCopied' } : { type: 'copyResult', ok: true, handoff: body.clipboard.handoff }], expected);
      } catch (error) {
        deliver([body.clipboard.instruction ? { type: 'instructionError', requestId: message.requestId, error: error.message } : { type: 'copyResult', ok: false, error: error.message }], expected);
        if (expected === generation) status('Clipboard: ' + error.message);
      }
    }
    if (expected !== generation) return;
    if (body.download) download(body.download);
    if (body.notice) status(body.notice);
    deliver(body.messages, expected);
  }
  function post(message) {
    record('sent', message);
    if (message.type === 'webviewReady') return Promise.resolve();
    if (message.type === 'insertImage') { document.getElementById('browser-host-image')?.click(); return Promise.resolve(); }
    // These notifications have no host result. Keep them in the local bounded trace.
    if (['viewerContext', 'selectComponents', 'usageEvent', 'usageEvents', 'debugInfo', 'debugError', 'imageTransform', 'imageAligned'].includes(message.type)) return Promise.resolve();
    var readOnly = ['requestComponentCatalog', 'requestComponentThumbnails', 'previewComponent'].includes(message.type);
    if (!currentPath) return ready.then(function () { return post(message); });
    var expected = generation, documentPath = currentPath, start = performance.now();
    if (loading && !readOnly) return Promise.resolve();
    var run = async function () {
      var body = await json('/api/message', { documentPath: documentPath, message: message });
      record('timings', { kind: 'message', type: message.type, ms: performance.now() - start });
      await responseActions(body, message, expected); return body;
    };
    // Catalog work is independent; mutation ordering remains deterministic.
    if (readOnly) return run().catch(function (error) { if (expected === generation) { deliver([{ type: 'componentError', requestId: message.requestId, error: error.message }], expected); fail(error); } });
    var task = queue.catch(function () {}).then(run);
    queue = task.catch(function (error) { if (expected === generation) fail(error); });
    return queue;
  }
  async function load(file) {
    if (!file) throw Error('Choose a layout first.');
    var expected = ++generation, start = performance.now(); loading = true;
    status('Loading ' + file + '…'); deliver([{ type: 'layoutLoading' }], expected);
    // Existing queued writes retain their captured document and complete before the switch.
    await queue;
    try {
      var body = await json('/api/load', { path: file });
      if (expected !== generation) return;
      var loaded = body.messages.find(function (m) { return m.type === 'loadGds'; });
      if (!loaded) throw Error('Host did not return a layout.');
      currentPath = loaded.gdsPath;
      try { state = JSON.parse(localStorage.getItem('gds-navigator:' + currentPath) || '{}'); } catch (_) { state = {}; }
      loading = false;
      deliver(body.messages, expected);
      var select = document.getElementById('browser-host-files');
      if (select) {
        if (!Array.from(select.options).some(function (o) { return o.value === currentPath; })) { var option = new Option(currentPath.split(/[\\/]/).pop(), currentPath); select.add(option); }
        select.value = currentPath;
      }
      record('timings', { kind: 'load', path: currentPath, ms: performance.now() - start });
      status('Loaded ' + currentPath); readyResolve();
    } catch (error) { if (expected === generation) { loading = false; deliver([{ type: 'rebuildError' }], expected); fail(error); } throw error; }
  }
  var api = {
    postMessage: post,
    getState: function () { return state; },
    setState: function (value) { state = value || {}; if (currentPath) try { localStorage.setItem('gds-navigator:' + currentPath, JSON.stringify(state)); } catch (error) { status('Browser UI preferences could not be saved: ' + error.message); } }
  };
  window.acquireVsCodeApi = function () { return api; };
  window.__gdsReady = ready; window.__gdsFlush = debug.flush = function () { return queue; };
  debug.load = load; debug.exportTrace = function () { return JSON.stringify({ path: currentPath, sent: debug.sent, received: debug.received, errors: debug.errors, timings: debug.timings }, null, 2); };

  function readFile(file) {
    return new Promise(function (resolve, reject) { var reader = new FileReader(); reader.onload = function () { resolve(reader.result); }; reader.onerror = function () { reject(reader.error); }; reader.readAsDataURL(file); });
  }
  function toolbar() {
    var bar = document.createElement('div'); bar.id = 'browser-host-toolbar';
    bar.innerHTML = '<strong>Browser dev</strong><select id="browser-host-files" aria-label="Layout file"></select><button id="browser-host-reload">Reload layout</button><button id="browser-host-upload-button">Open file…</button><input id="browser-host-upload" type="file" accept=".gds,.json,.geojson" hidden><button id="browser-host-image-button">Microscope…</button><input id="browser-host-image" type="file" accept="image/png,image/jpeg,image/webp" hidden><button id="browser-host-session">Download session</button><details><summary>Diagnostics</summary><pre id="browser-host-diagnostics"></pre></details><span id="browser-host-status" role="status"></span>';
    // Outside the canvas/inspector so the layout selector stays accessible when panels collapse.
    document.body.prepend(bar);
    document.getElementById('run-btn').title = 'Reload generated layout (run the Python generator in a terminal)';
    json('/api/config').then(async function (config) {
      var select = document.getElementById('browser-host-files');
      config.files.forEach(function (file) { select.add(new Option(file.name, file.path)); });
      await load(config.defaultFile);
    }).catch(fail);
    document.getElementById('browser-host-files').onchange = function (event) { load(event.target.value).catch(function () {}); };
    document.getElementById('browser-host-reload').onclick = function () { load(currentPath).catch(function () {}); };
    document.getElementById('browser-host-session').onclick = function () { post({ type: 'exportSession' }); };
    ['upload', 'image'].forEach(function (kind) {
      var input = document.getElementById('browser-host-' + kind);
      document.getElementById('browser-host-' + kind + '-button').onclick = function () { input.click(); };
      input.onchange = async function () {
        var file = input.files[0]; if (!file) return;
        try {
          if (file.size > (kind === 'image' ? 20 : 32) * 1024 * 1024) throw Error('File exceeds the browser import size limit.');
          var dataUrl = await readFile(file);
          if (kind === 'image') await post({ type: 'importImage', fileName: file.name, dataUrl: dataUrl });
          else { var result = await json('/api/upload', { name: file.name, base64: dataUrl.split(',')[1] }); await load(result.path); }
        } catch (error) { fail(error); } finally { input.value = ''; }
      };
    });
    var details = bar.querySelector('details'); details.addEventListener('toggle', function () { if (details.open) bar.querySelector('pre').textContent = debug.exportTrace(); });
  }
  window.addEventListener('error', function (event) { record('errors', event.message); });
  window.addEventListener('unhandledrejection', function (event) { record('errors', event.reason?.message || event.reason); });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', toolbar); else toolbar();
}());
