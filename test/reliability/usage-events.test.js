const assert = require('assert/strict');
const UsageEvents = require('../../webview/usage-events.js')({});
class Target {
  constructor(parent = null) { this.parentElement = parent; this.listeners = {}; this.id = ''; this.dataset = {}; this.tagName = 'DIV'; this.className = ''; this.isContentEditable = false; }
  addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); }
  removeEventListener(name, fn) { this.listeners[name] = (this.listeners[name] || []).filter(item => item !== fn); }
  dispatch(name, event = {}) { for (const fn of this.listeners[name] || []) fn({ target: this, ...event }); }
}
const root = new Target(); root.id = 'map'; const sent = []; const api = UsageEvents.attach({ root, send: event => { sent.push(event); if (event.control === 'throws') throw new Error('sink failure'); } });
const mode = new Target(root); mode.dataset.mode = 'route';
const noisy = UsageEvents.attach({ root, send: () => { throw new Error('sink failure'); } }); root.dispatch('click', { target: mode }); noisy.dispose(); sent.length = 0;
root.dispatch('click', { target: mode }); assert.equal(sent.at(-1).action, 'ui.control'); assert.equal(sent.at(-1).control, 'mode.route');
const unknown = new Target(root); unknown.dataset.mode = 'not-allowed'; root.dispatch('click', { target: unknown }); assert.equal(sent.length, 1);
const instruction = new Target(root); instruction.dataset.action = 'revert'; root.dispatch('click', { target: instruction }); assert.equal(sent.at(-1).control, 'instruction.revert');
const input = new Target(root); input.tagName = 'INPUT'; input.id = 'copy-btn'; root.dispatch('keydown', { target: input, key: 'c', ctrlKey: true, shiftKey: true }); assert.equal(sent.length, 2, 'shortcut from input leaked');
root.dispatch('keydown', { target: root, key: 'c', ctrlKey: true, shiftKey: true }); assert.equal(sent.at(-1).control, 'copy-selection');
const beforeModifiedShortcut = sent.length; root.dispatch('keydown', { target: root, key: 's', ctrlKey: true }); assert.equal(sent.length, beforeModifiedShortcut, 'modified Ctrl+S must not be logged as plain snap');
const change = new Target(root); change.id = 'image-opacity'; root.dispatch('change', { target: change }); assert.equal(sent.at(-1).action, 'ui.change'); assert(!Object.prototype.hasOwnProperty.call(sent.at(-1), 'value'));
for (let i = 0; i < 4; i++) root.dispatch('wheel', { target: root }); const returnPromise = new Promise(resolve => setTimeout(resolve, 260));
returnPromise.then(() => { assert.equal(sent.filter(e => e.action === 'view.wheel').length, 1); assert.equal(sent.at(-1).count, 4); const before = sent.length; api.dispose(); root.dispatch('click', { target: mode }); root.dispatch('wheel', { target: root }); assert.equal(sent.length, before); console.log('usage events tests passed'); }).catch(error => { console.error(error); process.exitCode = 1; });
