const assert = require('assert/strict');
const fs = require('fs');
const vm = require('vm');

function node(tag) {
  return { focus() {}, remove() {}, tag, children: [], textContent: '', value: '', hidden: false, disabled: false, dataset: {}, style: {}, listeners: {}, append(...xs) { this.children.push(...xs); }, appendChild(x) { this.children.push(x); return x; }, setAttribute(k, v) { this[k] = v; }, addEventListener(k, fn) { this.listeners[k] = fn; }, click() { this.listeners.click?.({}); } };
}
const document = { createElement: node, createElementNS: (_ns, tag) => node(tag) };
const root = { document, setTimeout: () => 1, clearTimeout() {} };
vm.runInNewContext(fs.readFileSync(require('path').join(__dirname, '../../webview/component-chooser.js'), 'utf8'), root);
const container = node('section'); const messages = []; const inserted = [];
const chooser = root.ComponentChooser.mount({ container, postMessage: msg => messages.push(msg), onInsert: value => inserted.push(value), onPlace: () => {} });
chooser.open(); assert.equal(messages[0].type, 'requestComponentCatalog'); const catalogId = messages[0].requestId;
chooser.handleMessage({ type: 'componentCatalog', requestId: 'stale', result: { components: [{ name: 'wrong', parameters: [] }] } });
chooser.handleMessage({ type: 'componentCatalog', requestId: catalogId, result: { components: [{ name: 'straight', description: 'Straight waveguide', parameters: [{ name: 'length', required: false, default: 10 }] }, { name: 'bend', description: 'Bend', parameters: [] }] } });
assert(container.children.length > 0, 'chooser did not render catalog');
const shell = container.children[0]; const list = shell.children[3]; const categoryFilter = shell.children[0].children[1]; assert.equal(categoryFilter.children[0].value, '', 'all category filter is not selectable'); const cards = list.children.filter(x => x.tag === 'button'); assert.match(cards[0].children[1].textContent, /^bend/, 'catalog is not alphabetical'); cards[0].click();
assert.equal(messages.at(-1).type, 'previewComponent', 'defaultable factory was not previewed automatically');
const automaticId = messages.at(-1).requestId;
chooser.handleMessage({ type: 'componentPreview', requestId: automaticId, result: { name: 'bend', settings: {}, geojson: { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[0, 0], [4, 0], [4, 1], [0, 0]]] } }] } } });
assert(cards[0].children[0].children.some(x => x.tag === 'svg' || x.tag === 'path'), 'thumbnail did not use returned geometry');
list.children.filter(x => x.tag === 'button')[1].click();
const detail = shell.children[4]; const textarea = detail.children.find(x => x.tag === 'textarea'); textarea.value = '{"length":12}'; const previewButton = detail.children.find(x => x.textContent === 'Preview component'); previewButton.click();
assert.equal(messages.at(-1).type, 'previewComponent'); const previewId = messages.at(-1).requestId;
chooser.handleMessage({ type: 'componentPreview', requestId: previewId, result: { name: 'straight', settings: { length: 12 }, geojson: { type: 'FeatureCollection', features: [] } } });
const insertButton = detail.children.find(x => x.textContent === 'Insert at view center'); assert.equal(insertButton.hidden, false); insertButton.click(); assert.equal(inserted.length, 1);
textarea.value = '{bad'; previewButton.click(); assert.equal(shell.children[2].dataset.level, 'error');
console.log('component chooser tests passed');

const refresh = shell.children[0].children.find(x => x.textContent === 'Refresh');
refresh.click(); const refreshedId = messages.at(-1).requestId;
assert.equal(messages.at(-1).type, 'requestComponentCatalog');
assert.notEqual(refreshedId, catalogId);
assert.equal(chooser.handleMessage({ type: 'componentPreview', requestId: previewId, result: { name: 'stale' } }), false, 'refresh accepted an old preview');
chooser.handleMessage({ type: 'componentCatalog', requestId: refreshedId, result: { components: [{ name: 'project:strip', category: 'Project components', library: { module: 'gds_components', exportName: 'strip' }, parameters: [] }], warnings: ['A broken factory was skipped.'] } });
assert.match(shell.children[2].textContent, /broken factory/);
assert(categoryFilter.children.some(x => x.textContent === 'Project components'));
console.log('project component refresh and warning tests passed');
