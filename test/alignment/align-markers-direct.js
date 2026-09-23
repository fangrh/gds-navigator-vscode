#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const puppeteer = require('puppeteer-core');

const ROOT = path.resolve(__dirname, '..', '..');
const PARSER = path.join(ROOT, 'python', 'parse_gds.py');
const ALIGNMENT_SCRIPT = path.join(ROOT, 'webview', 'numbered-marker-alignment.js');

function usage() { return 'Usage: node test/alignment/align-markers-direct.js --gds FILE --image FILE --out DIR [--python EXE] [--marker-appearance yellow|bright|dark] [--marker-layers 1/0,8/0,9/0]'; }
function parseArgs(argv) {
  const values = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--') || !['--gds', '--image', '--out', '--python', '--marker-appearance', '--marker-layers'].includes(arg)) throw new Error(`Unknown argument: ${arg}\n${usage()}`);
    if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw new Error(`Missing value for ${arg}\n${usage()}`);
    values[arg.slice(2)] = argv[++i];
  }
  for (const name of ['gds', 'image', 'out']) if (!values[name]) throw new Error(`Missing --${name}\n${usage()}`);
  values.python = values.python || 'python';
  values.markerAppearance = values['marker-appearance'] || 'yellow';
  if (!['yellow', 'bright', 'dark'].includes(values.markerAppearance)) throw new Error(`Unsupported --marker-appearance: ${values.markerAppearance}`);
  values.markerLayers = values['marker-layers'] ? values['marker-layers'].split(',').filter(Boolean) : ['1/0', '8/0', '9/0'];
  if (!values.markerLayers.length || values.markerLayers.length > 16 || values.markerLayers.some(layer => !/^\d+\/\d+$/.test(layer)) || values.markerLayers.includes('4/0')) throw new Error('--marker-layers must be 1-16 layer/data_type strings and cannot include 4/0');
  return values;
}
function absoluteExisting(file, label) {
  const resolved = path.resolve(file);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) throw new Error(`${label} does not exist or is not a file: ${resolved}`);
  return resolved;
}
function sha256(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function parseGds(python, gds) {
  let stdout;
  try { stdout = childProcess.execFileSync(python, [PARSER, gds], { encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024, windowsHide: true }); }
  catch (error) { throw new Error(`parse_gds.py failed: ${error.stderr ? String(error.stderr).trim() : error.message}`); }
  let parsed;
  try { parsed = JSON.parse(stdout); } catch (error) { throw new Error(`parse_gds.py produced invalid JSON: ${error.message}`); }
  if (parsed && parsed.error) throw new Error(String(parsed.error));
  if (!parsed || !Array.isArray(parsed.features)) throw new Error('parse_gds.py result has no FeatureCollection features array');
  return parsed;
}
function executablePath() {
  const candidates = [process.env.EDGE_PATH, 'C:/Program Files/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].filter(Boolean);
  for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate;
  for (const name of process.platform === 'win32' ? ['msedge.exe', 'chrome.exe'] : ['microsoft-edge', 'google-chrome', 'chromium']) {
    try { const found = childProcess.execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', [name], { encoding: 'utf8', windowsHide: true }).trim().split(/\r?\n/)[0]; if (found && fs.existsSync(found)) return found; } catch (_) { /* next browser */ }
  }
  throw new Error('Could not find Microsoft Edge or Chrome; set EDGE_PATH or CHROME_PATH');
}
function dataUrl(file) { const ext = path.extname(file).toLowerCase(); const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png'; return `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`; }
function decodeDataUrl(value) { const match = /^data:[^;]+;base64,(.*)$/.exec(value || ''); if (!match) throw new Error('Browser did not return a PNG data URL'); return Buffer.from(match[1], 'base64'); }
function realPathForComparison(file) { const resolved = path.resolve(file); if (fs.existsSync(resolved)) return fs.realpathSync.native(resolved).toLowerCase(); let parent = path.dirname(resolved), suffix = path.basename(resolved); while (!fs.existsSync(parent)) { const next = path.dirname(parent); suffix = path.join(path.basename(parent), suffix); if (next === parent) break; parent = next; } return path.join(fs.realpathSync.native(parent), suffix).toLowerCase(); }

async function run(options) {
  const gds = absoluteExisting(options.gds, 'GDS input');
  const image = absoluteExisting(options.image, 'image input');
  const outDir = path.resolve(options.out);
  const sourcePaths = [gds, image].map(realPathForComparison);
  for (const name of ['result.json', 'overlay.png', 'diagnostic.png']) {
    const output = realPathForComparison(path.join(outDir, name));
    if (sourcePaths.includes(output)) throw new Error('Output would overwrite a source input (including symlink target)');
  }
  fs.mkdirSync(outDir, { recursive: true });
  if (!fs.existsSync(ALIGNMENT_SCRIPT)) throw new Error(`Missing alignment module: ${ALIGNMENT_SCRIPT}`);
  const parsed = parseGds(options.python || 'python', gds);
  const inputs = { gds: { path: gds, sha256: sha256(gds) }, image: { path: image, sha256: sha256(image) }, parser: { python: options.python || 'python', script: PARSER, sha256: sha256(PARSER) }, solver: { path: ALIGNMENT_SCRIPT, sha256: sha256(ALIGNMENT_SCRIPT) } };
  const browser = await puppeteer.launch({ executablePath: executablePath(), headless: true, protocolTimeout: 300000, args: ['--no-first-run'] });
  let result;
  try {
    const page = await browser.newPage();
    await page.addScriptTag({ path: ALIGNMENT_SCRIPT });
    result = await page.evaluate(async ({ imageUrl, features, options }) => {
      const img = new Image(); img.src = imageUrl; await img.decode();
      try {
        if (!window.NumberedMarkerAlignment || typeof window.NumberedMarkerAlignment.align !== 'function') throw new Error('window.NumberedMarkerAlignment.align is unavailable');
        const aligned = await window.NumberedMarkerAlignment.align({ image: img, features, options });
        return { status: aligned && aligned.status ? aligned.status : 'failed', ...aligned, imageWidth: img.naturalWidth, imageHeight: img.naturalHeight };
      } catch (error) { return { status: 'failed', reason: error && error.message ? error.message : String(error), imageWidth: img.naturalWidth, imageHeight: img.naturalHeight }; }
    }, { imageUrl: dataUrl(image), features: parsed.features, options: { markerAppearance: options.markerAppearance, markerLayers: options.markerLayers } });
    const images = await page.evaluate(async ({ imageUrl, features, result }) => {
      const img = new Image(); img.src = imageUrl; await img.decode(); const W = img.naturalWidth, H = img.naturalHeight;
      function drawBase(ctx) { ctx.fillStyle = '#202124'; ctx.fillRect(0, 0, W, H); ctx.drawImage(img, 0, 0); }
      let inverse = null;
      if (result.status === 'aligned' && Array.isArray(result.transform) && result.transform.length === 9 && result.transform.every(Number.isFinite) && window.NumberedMarkerAlignment && typeof window.NumberedMarkerAlignment.inverse === 'function') {
        try { inverse = window.NumberedMarkerAlignment.inverse(result.transform); } catch (_) { inverse = null; }
      }
      function point(Hm, p) { const q = Hm[6] * p[0] + Hm[7] * p[1] + Hm[8]; return [(Hm[0] * p[0] + Hm[1] * p[1] + Hm[2]) / q, (Hm[3] * p[0] + Hm[4] * p[1] + Hm[5]) / q]; }
      function drawRing(ctx, ring, Hm) { if (!ring || ring.length < 2) return; ctx.beginPath(); ring.forEach((p, i) => { const q = point(Hm, p); if (i === 0) ctx.moveTo(q[0], q[1]); else ctx.lineTo(q[0], q[1]); }); ctx.stroke(); }
      const overlay = document.createElement('canvas'); overlay.width = W; overlay.height = H; const oc = overlay.getContext('2d'); drawBase(oc); oc.lineWidth = Math.max(1, Math.min(W, H) / 1200); oc.strokeStyle = 'rgba(255,70,70,0.8)';
      if (inverse) for (const feature of features) {
        if (!feature || !feature.properties || !feature.geometry) continue;
        const layer = String(feature.properties.layer).split('/')[0];
        oc.strokeStyle = layer === '4' ? 'rgba(0,110,255,0.95)' : 'rgba(255,70,70,0.8)';
        const geometry = feature.geometry;
        const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.type === 'MultiPolygon' ? geometry.coordinates : [];
        for (const rings of polygons) for (const ring of rings) drawRing(oc, ring, inverse);
      }
      oc.fillStyle = '#202124cc'; oc.fillRect(0, 0, W, 23); oc.font = '12px sans-serif'; oc.fillStyle = '#fff';
      oc.fillText(result.status === 'aligned' ? 'Numbered markers: red | Electrodes / layer 4: blue | Marker-only fit' : `FAILED: ${result.reason}`, 7, 16);
      const diagnostic = document.createElement('canvas'); diagnostic.width = W; diagnostic.height = H; const dc = diagnostic.getContext('2d'); drawBase(dc); dc.font = `${Math.max(12, Math.round(Math.min(W, H) / 80))}px sans-serif`; dc.textBaseline = 'top';
      for (const marker of (Array.isArray(result.markers) ? result.markers : [])) { const p = marker.imageCenter; if (!Array.isArray(p)) continue; dc.fillStyle = '#00ff80'; dc.strokeStyle = '#000'; dc.lineWidth = 2; dc.beginPath(); dc.arc(p[0], p[1], Math.max(5, Math.min(W, H) / 100), 0, 2 * Math.PI); dc.fill(); dc.stroke(); dc.fillStyle = '#fff'; dc.strokeStyle = '#000'; const label = `${marker.label == null ? '?' : marker.label} (${Number(marker.boundaryRmsPx || 0).toFixed(2)}px)`; dc.strokeText(label, p[0] + 8, p[1] + 8); dc.fillText(label, p[0] + 8, p[1] + 8); }
      if (result.status !== 'aligned') { dc.fillStyle = '#ff4040'; dc.font = 'bold 24px sans-serif'; dc.fillText(`ALIGNMENT FAILED: ${result.reason || 'unknown reason'}`, 12, 12); }
      return { overlay: overlay.toDataURL('image/png'), diagnostic: diagnostic.toDataURL('image/png') };
    }, { imageUrl: dataUrl(image), features: parsed.features, result });
    fs.writeFileSync(path.join(outDir, 'overlay.png'), decodeDataUrl(images.overlay)); fs.writeFileSync(path.join(outDir, 'diagnostic.png'), decodeDataUrl(images.diagnostic));
  } finally { await browser.close(); }
  const full = { ...result, inputs, featureCount: parsed.features.length };
  fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(full, null, 2) + os.EOL);
  return full;
}

if (require.main === module) (async () => { try { const options = parseArgs(process.argv.slice(2)); const result = await run(options); console.log(JSON.stringify({ status: result.status, reason: result.reason, boundaryRmsPx: result.boundaryRmsPx, markers: result.markers && result.markers.length, out: path.resolve(options.out) })); process.exitCode = result.status === 'aligned' ? 0 : 1; } catch (error) { console.error(`ERROR: ${error.message}`); process.exitCode = 1; } })();
module.exports = { parseArgs, parseGds, run };
