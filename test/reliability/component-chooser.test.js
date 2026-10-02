const assert = require('assert/strict');
const fs = require('fs');
const vm = require('vm');

function node(tag) {
  return { focus() { document.activeElement = this; }, remove() {}, tag, children: [], textContent: '', value: '', hidden: false, disabled: false, dataset: {}, style: {}, listeners: {}, append(...xs) { this.children.push(...xs); }, appendChild(x) { this.children.push(x); return x; }, setAttribute(k, v) { this[k] = v; }, addEventListener(k, fn) { this.listeners[k] = fn; }, click() { this.listeners.click?.({}); } };
}
const document = { activeElement: null, createElement: node, createElementNS: (_ns, tag) => node(tag) };
const root = { document, setTimeout: (fn, ms) => { if (ms === 40) fn(); return 1; }, clearTimeout() {} };
vm.runInNewContext(fs.readFileSync(require('path').join(__dirname, '../../webview/component-chooser.js'), 'utf8'), root);
const container = node('section'); const messages = []; const inserted = [];
const chooser = root.ComponentChooser.mount({ container, postMessage: msg => messages.push(msg), onInsert: value => inserted.push(value), onPlace: () => {} });
chooser.open(); assert.equal(messages[0].type, 'requestComponentCatalog'); const catalogId = messages[0].requestId;
chooser.handleMessage({ type: 'componentCatalog', requestId: 'stale', result: { components: [{ name: 'wrong', parameters: [] }] } });
chooser.handleMessage({ type: 'componentCatalog', requestId: catalogId, result: { components: [{ name: 'straight', description: 'Straight waveguide', parameters: [{ name: 'length', required: false, default: 10 }] }, { name: 'bend', description: 'Bend', parameters: [] }] } });
assert(container.children.length > 0, 'chooser did not render catalog');
const shell = container.children[0]; const list = shell.children[3]; const categoryFilter = shell.children[0].children[1]; assert.equal(categoryFilter.children[0].value, '', 'all category filter is not selectable'); const cards = list.children.filter(x => x.tag === 'button'); assert.match(cards[0].children[1].textContent, /^bend/, 'catalog is not alphabetical');
const thumbnailRequest = messages.find(m => m.type === 'requestComponentThumbnails'); assert(thumbnailRequest, 'thumbnail request missing'); chooser.handleMessage({ type: 'componentError', requestId: thumbnailRequest.requestId, error: 'temporary failure' }); const retry = shell.children[0].children.find(x => x.textContent === 'Retry failed shapes'); assert.equal(retry.hidden, false, 'retry control did not appear'); retry.click(); const retryRequest = messages.at(-1); assert.equal(retryRequest.type, 'requestComponentThumbnails'); assert.notEqual(retryRequest.requestId, thumbnailRequest.requestId); assert.equal(chooser.handleMessage({ type: 'componentThumbnails', requestId: thumbnailRequest.requestId, result: { items: [] } }), false, 'stale thumbnail response was accepted'); chooser.handleMessage({ type: 'componentThumbnails', requestId: retryRequest.requestId, result: { items: [{ name: 'bend', geojson: { type: 'FeatureCollection', features: [] } }, { name: 'straight', geojson: { type: 'FeatureCollection', features: [] } }] } }); assert.equal(retry.hidden, true, 'retry control remained visible after recovery');
assert.equal(list['aria-label'], 'Component choices', 'component listbox is not labelled'); assert.equal(cards[0].tabIndex, 0, 'first component should be the roving tab stop'); assert.equal(cards[1].tabIndex, -1, 'only one component should be tabbable');
const key = (card, keyName) => { let prevented = false, stopped = false; card.listeners.keydown({ key: keyName, preventDefault() { prevented = true; }, stopPropagation() { stopped = true; } }); return { prevented, stopped }; };
let result = key(cards[0], 'ArrowDown'); assert(result.prevented && result.stopped, 'ArrowDown did not consume component navigation'); assert.equal(document.activeElement, cards[1], 'ArrowDown did not move focus to the next component'); assert.equal(cards[0].tabIndex, -1); assert.equal(cards[1].tabIndex, 0); assert.equal(messages.filter(m => m.type === 'previewComponent').length, 0, 'arrow navigation triggered preview');
result = key(cards[1], 'Home'); assert(result.prevented && result.stopped, 'Home did not consume component navigation'); assert.equal(document.activeElement, cards[0]); result = key(cards[0], 'Enter'); assert(result.prevented && result.stopped, 'Enter did not consume component selection'); assert.equal(messages.at(-1).type, 'previewComponent', 'Enter did not trigger selection preview');
cards[0].click(); assert.equal(cards[0].tabIndex, 0, 'click selection did not move the roving tab stop'); assert.equal(cards[1].tabIndex, -1);
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

const timeoutTimers = []; root.setTimeout = (fn, ms) => { if (ms === 40) { fn(); return 1; } timeoutTimers.push({ fn, ms }); return timeoutTimers.length; };
const timeoutContainer = node('section'); const timeoutMessages = []; const timeoutChooser = root.ComponentChooser.mount({ container: timeoutContainer, postMessage: msg => timeoutMessages.push(msg) }); timeoutChooser.open();
const timeoutCatalog = timeoutMessages[0]; timeoutChooser.handleMessage({ type: 'componentCatalog', requestId: timeoutCatalog.requestId, result: { components: [{ name: 'timeout-shape', parameters: [] }] } });
const timeoutRequest = timeoutMessages.find(m => m.type === 'requestComponentThumbnails'); timeoutTimers.find(timer => timer.ms === 50000).fn(); const timeoutRetry = timeoutContainer.children[0].children[0].children.find(x => x.textContent === 'Retry failed shapes'); assert.equal(timeoutRetry.hidden, false, 'timeout did not expose recovery control'); timeoutRetry.click(); const timeoutRetryRequest = timeoutMessages.at(-1); assert.equal(timeoutChooser.handleMessage({ type: 'componentThumbnails', requestId: timeoutRequest.requestId, result: { items: [] } }), false, 'stale timeout response was accepted'); timeoutChooser.handleMessage({ type: 'componentThumbnails', requestId: timeoutRetryRequest.requestId, result: { items: [{ name: 'timeout-shape', geojson: { type: 'FeatureCollection', features: [] } }] } }); assert.equal(timeoutRetry.hidden, true, 'timeout recovery did not clear after success');

const manyContainer = node('section'); const manyMessages = []; const manyObservers = [];
root.IntersectionObserver = class { constructor(callback) { this.callback = callback; this.targets = []; manyObservers.push(this); } observe(target) { this.targets.push(target); } unobserve() {} };
const manyChooser = root.ComponentChooser.mount({ container: manyContainer, postMessage: msg => manyMessages.push(msg) }); manyChooser.open();
const manyCatalogRequest = manyMessages[0]; const manyComponents = Array.from({ length: 12 }, (_, i) => ({ name: `shape-${String(i).padStart(2, '0')}`, parameters: [] }));
manyChooser.handleMessage({ type: 'componentCatalog', requestId: manyCatalogRequest.requestId, result: { components: manyComponents } });
manyObservers.at(-1).callback(manyObservers.at(-1).targets.map(target => ({ target, isIntersecting: true })));
const manyThumbRequest = manyMessages.find(m => m.type === 'requestComponentThumbnails'); assert(manyThumbRequest && manyThumbRequest.names.length <= 8, 'thumbnail scheduler exceeded its batch limit');
manyChooser.handleMessage({ type: 'componentError', requestId: manyThumbRequest.requestId, error: 'temporary failure' });
const manySecondRequest = manyMessages.at(-1); assert.equal(manySecondRequest.type, 'requestComponentThumbnails'); assert.equal(manySecondRequest.names.length, 4, 'remaining thumbnail batch was not scheduled');
const manyRetry = manyContainer.children[0].children[0].children.find(x => x.textContent === 'Retry failed shapes'); assert.equal(manyRetry.hidden, false); assert.equal(manyRetry.disabled, true, 'retry remained enabled during an in-flight remainder batch'); const beforeDuplicateClick = manyMessages.length; manyRetry.click(); assert.equal(manyMessages.length, beforeDuplicateClick, 'retry started a duplicate in-flight batch');
manyChooser.handleMessage({ type: 'componentError', requestId: manySecondRequest.requestId, error: 'remainder failure' }); assert.equal(manyRetry.hidden, false, 'remainder failure did not expose recovery'); manyRetry.click(); const finalRetry = manyMessages.at(-1); assert.equal(finalRetry.type, 'requestComponentThumbnails'); assert.equal(finalRetry.names.length, 8, 'bounded retry did not cap the all-failed catalog batch');
manyChooser.handleMessage({ type: 'componentThumbnails', requestId: finalRetry.requestId, result: { items: finalRetry.names.map(name => ({ name, geojson: { type: 'FeatureCollection', features: [] } })) } });
const finalRemainder = manyMessages.at(-1); assert.equal(finalRemainder.type, 'requestComponentThumbnails'); assert.equal(finalRemainder.names.length, 4, 'successful first retry batch did not schedule the remainder'); manyChooser.handleMessage({ type: 'componentThumbnails', requestId: finalRemainder.requestId, result: { items: finalRemainder.names.map(name => ({ name, geojson: { type: 'FeatureCollection', features: [] } })) } });
assert.equal(manyRetry.hidden, true, 'successful bounded retry did not clear recovery state');
