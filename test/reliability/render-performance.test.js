#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '../..');
const VIEWER = path.join(ROOT, 'webview/viewer.html');
const DRAW_START = 'var drawSource = new ol.source.Vector();';
const DRAW_END = 'var portSource = new ol.source.Vector();';
const VECTOR_START = 'var source = new ol.source.Vector();';
const VECTOR_END = '// ============================================================\n// Map setup';

// Provenance: this is the bounded probe fixture for the callback behavior
// before the style-cache optimization. Keep it local so future commits do not
// silently replace the comparator through `git show HEAD`.
const BASELINE_STYLE_FIXTURE = String.raw`
var drawSource = new ol.source.Vector();
var drawStyleDefault = new ol.style.Style({ stroke: new ol.style.Stroke({ color: '#f38ba8', width: 2 }), fill: new ol.style.Fill({ color: 'rgba(243, 139, 168, 0.1)' }) });
var drawStyleSelected = new ol.style.Style({ stroke: new ol.style.Stroke({ color: '#ffffff', width: 3 }), fill: new ol.style.Fill({ color: 'rgba(243, 139, 168, 0.3)' }) });
var drawLayer = new ol.layer.Vector({ source: drawSource, style: function(feature, resolution) {
  if (feature.get('route')) { var spec = feature.get('route'), selected = feature.get('selected'); return [
    new ol.style.Style({ stroke: new ol.style.Stroke({ color: selected ? 'rgba(137,180,250,.4)' : 'rgba(243,139,168,.3)', width: Math.max(1, Math.min(2048, spec.width / resolution)), lineCap: 'butt', lineJoin: 'miter' }) }),
    new ol.style.Style({ stroke: new ol.style.Stroke({ color: selected ? '#ffffff' : '#f38ba8', width: 2, lineDash: [6, 4], lineCap: 'butt', lineJoin: 'miter' }) })]; }
  return feature.get('selected') ? drawStyleSelected : drawStyleDefault;
} });
var source = new ol.source.Vector();
var highlightStyle = new ol.style.Style({ stroke: new ol.style.Stroke({ color: '#ffffff', width: 3 }), fill: new ol.style.Fill({ color: 'rgba(255,255,255,0.3)' }) });
var vectorLayer = new ol.layer.Vector({ source: source, style: function(feature) {
  var selected = feature.get('selected'), labelText = feature.get('label');
  if (selected) {
    if (labelText) return new ol.style.Style({ stroke: new ol.style.Stroke({ color: '#ffffff', width: 3 }), fill: new ol.style.Fill({ color: 'rgba(255,255,255,0.3)' }), text: new ol.style.Text({ text: labelText, font: '10px monospace', fill: new ol.style.Fill({ color: '#f9e2af' }), stroke: new ol.style.Stroke({ color: '#1a1a2e', width: 2 }) }) });
    return highlightStyle;
  }
  var color = feature.get('color') || '#fff', visible = feature.get('visible') !== false;
  if (!visible) return new ol.style.Style({});
  var style = new ol.style.Style({ stroke: new ol.style.Stroke({ color: color, width: 1 }), fill: new ol.style.Fill({ color: color + '80' }) });
  if (labelText) style.setText(new ol.style.Text({ text: labelText, font: '10px monospace', fill: new ol.style.Fill({ color: '#f9e2af' }), stroke: new ol.style.Stroke({ color: '#1a1a2e', width: 2 }) }));
  return style;
} });
`;

function styleSection(source) {
  source = source.replace(/\r\n/g, '\n');
  if (!source.includes(DRAW_END)) return source;
  const drawStart = source.indexOf(DRAW_START);
  const drawEnd = source.indexOf(DRAW_END, drawStart);
  const vectorStart = source.indexOf(VECTOR_START);
  const vectorEnd = source.indexOf(VECTOR_END, vectorStart);
  assert(drawStart >= 0 && drawEnd > drawStart && vectorStart >= 0 && vectorEnd > vectorStart, 'viewer style section markers missing');
  return source.slice(drawStart, drawEnd) + '\n' + source.slice(vectorStart, vectorEnd);
}

function runStyleSection(source) {
  const counts = { Style: 0, Stroke: 0, Fill: 0, Text: 0 };
  class Style {
    constructor(options) { counts.Style++; Object.assign(this, options); }
    setText(text) { this.text = text; }
  }
  class Stroke { constructor(options) { counts.Stroke++; Object.assign(this, options); } }
  class Fill { constructor(options) { counts.Fill++; Object.assign(this, options); } }
  class Text { constructor(options) { counts.Text++; Object.assign(this, options); } }
  class VectorSource {}
  class VectorLayer { constructor(options) { this.options = options; } }
  const context = {
    Map, JSON, Math,
    ol: { source: { Vector: VectorSource }, layer: { Vector: VectorLayer }, style: { Style, Stroke, Fill, Text } },
  };
  vm.runInNewContext(styleSection(source), context, { filename: VIEWER });
  const feature = values => ({ get: key => values[key] });
  const route = feature({ route: { width: 4 }, selected: false });
  const normal = feature({ selected: false, color: '#123456', visible: true, label: 'A' });
  const selected = feature({ selected: true, label: 'A' });
  const hidden = feature({ selected: false, color: '#123456', visible: false });
  const routeStyle = context.drawLayer.options.style;
  const vectorStyle = context.vectorLayer.options.style;
  counts.Style = counts.Stroke = counts.Fill = counts.Text = 0;
  for (let i = 0; i < 100; i++) {
    routeStyle(route, 2);
    vectorStyle(normal);
    vectorStyle(selected);
    vectorStyle(hidden);
  }
  const repeatedCounts = Object.assign({}, counts);
  const firstRouteStyle = routeStyle(route, 2);
  for (let i = 0; i < 96; i++) routeStyle(feature({ route: { width: i + 10 }, selected: false }), 2);
  const routeCacheEvicts = routeStyle(route, 2) !== firstRouteStyle;
  return {
    counts: repeatedCounts,
    identities: {
      route: routeStyle(route, 2) === routeStyle(route, 2),
      normal: vectorStyle(normal) === vectorStyle(normal),
      selected: vectorStyle(selected) === vectorStyle(selected),
      hidden: vectorStyle(hidden) === vectorStyle(hidden),
    },
    transitions: {
      routeSelection: routeStyle(route, 2) === routeStyle({ get: key => key === 'route' ? { width: 4 } : key === 'selected' ? true : undefined }, 2),
      normalLabel: vectorStyle(normal) === vectorStyle({ get: key => ({ selected: false, color: '#123456', visible: true, label: 'B' })[key] }),
      routeCacheEvicts,
    },
  };
}

function main() {
  const current = fs.readFileSync(VIEWER, 'utf8');
  const before = runStyleSection(BASELINE_STYLE_FIXTURE);
  const after = runStyleSection(current);
  assert(before.counts.Style > 0 && before.counts.Stroke > 0, 'baseline constructor probe was empty');
  assert(after.counts.Style < before.counts.Style, 'render style allocations did not decrease');
  assert(after.counts.Stroke < before.counts.Stroke, 'render stroke allocations did not decrease');
  assert.deepEqual(after.identities, { route: true, normal: true, selected: true, hidden: true });
  assert.equal(after.transitions.routeSelection, false, 'selection must change route style');
  assert.equal(after.transitions.normalLabel, false, 'label changes must change normal style');
  assert.equal(after.transitions.routeCacheEvicts, true, 'route style cache must stay bounded');
  const report = {
    status: 'passed',
    probe: '100 repeated route/vector style callbacks at fixed resolution and feature properties',
    before: before.counts,
    after: after.counts,
    behavior: ['selected, hidden, color, label, and route width/resolution remain style-keyed', 'bounded caches evict old variants after their fixed limits'],
  };
  const outDir = path.join(ROOT, 'logs/performance');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'render-styles.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}

main();
