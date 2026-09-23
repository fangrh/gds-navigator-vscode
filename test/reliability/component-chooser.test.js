const assert = require('assert/strict');
const fs = require('fs');
const vm = require('vm');

function node(tag) {
  return { focus() {}, tag, children: [], textContent: '', value: '', hidden: false, disabled: false, dataset: {}, style: {}, listeners: {}, append(...xs) { this.children.push(...xs); }, appendChild(x) { this.children.push(x); return x; }, setAttribute(k, v) { this[k] = v; }, addEventListener(k, fn) { this.listeners[k] = fn; }, click() { this.listeners.click?.({}); } };
}
const document = { createElement: node };
const root = { document };
vm.runInNewContext(fs.readFileSync(require('path').join(__dirname, '../../webview/component-chooser.js'), 'utf8'), root);
const container = node('section'); const messages = []; const inserted = [];
const chooser = root.ComponentChooser.mount({ container, postMessage: msg => messages.push(msg), onInsert: value => inserted.push(value) });
chooser.open(); assert.equal(messages[0].type, 'requestComponentCatalog'); const catalogId = messages[0].requestId;
chooser.handleMessage({ type: 'componentCatalog', requestId: 'stale', result: { components: [{ name: 'wrong', parameters: [] }] } });
chooser.handleMessage({ type: 'componentCatalog', requestId: catalogId, result: { components: [{ name: 'straight', description: 'Straight waveguide', parameters: [{ name: 'length', required: false, default: 10 }] }, { name: 'bend', description: 'Bend', parameters: [] }] } });
assert(container.children.length > 0, 'chooser did not render catalog');
const shell = container.children[0]; const list = shell.children[3]; list.children.find(x => x.tag === 'button').click();
const detail = shell.children[4]; const textarea = detail.children.find(x => x.tag === 'textarea'); textarea.value = '{"length":12}'; const previewButton = detail.children.find(x => x.textContent === 'Preview component'); previewButton.click();
assert.equal(messages.at(-1).type, 'previewComponent'); const previewId = messages.at(-1).requestId;
chooser.handleMessage({ type: 'componentPreview', requestId: previewId, result: { name: 'straight', settings: { length: 12 }, geojson: { type: 'FeatureCollection', features: [] } } });
const insertButton = detail.children.find(x => x.textContent === 'Insert at view center'); assert.equal(insertButton.hidden, false); insertButton.click(); assert.equal(inserted.length, 1);
textarea.value = '{bad'; previewButton.click(); assert.equal(shell.children[2].dataset.level, 'error');
console.log('component chooser tests passed');
