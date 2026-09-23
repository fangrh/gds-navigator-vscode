const assert = require('assert/strict');
const fs = require('fs');
const vm = require('vm');
function makeNode(tag) {
  const n = { tag, children: [], hidden: false, value: '', disabled: false, dataset: {}, listeners: {}, textContent: '', append(...xs) { this.children.push(...xs); }, appendChild(x) { this.children.push(x); return x; }, setAttribute(k, v) { this[k] = v; }, addEventListener(k, f) { this.listeners[k] = f; }, focus() { document.activeElement = this; }, click() { this.listeners.click?.({}); } };
  return n;
}
const document = { activeElement: null, head: makeNode('head'), createElement: makeNode, getElementById: () => null };
const root = { document };
vm.runInNewContext(fs.readFileSync(require('path').join(__dirname, '../../webview/shape-properties.js'), 'utf8'), root);
const container = makeNode('div'); const applied = []; const modes = []; let closed = 0; const previous = makeNode('button'); document.activeElement = previous;
const api = root.ShapeProperties.mount({ container, onApply: value => applied.push(value), onMode: name => modes.push(name), onClose: () => closed++ });
api.show({ editable: true, label: 'Drawn proposal', x: 1, y: 2, width: 3, height: 4, rotation: 5 });
assert(api.isOpen()); const panel = container.children[0]; const inputs = panel.children.filter(x => x.tag === 'label').map(x => x.children[1]); assert.equal(inputs[0].value, '1'); assert.equal(document.activeElement, inputs[0]);
inputs[2].value = '-1'; panel.children.find(x => x.textContent === 'Apply').click(); assert.equal(applied.length, 0);
inputs[2].value = '3'; inputs[4].value = '6'; panel.children.find(x => x.textContent === 'Apply').click(); assert.equal(JSON.stringify(applied[0]), JSON.stringify({ x: 1, y: 2, width: 3, height: 4, rotation: 6 }));
panel.children.filter(x => x.tag === 'div' && x.className === 'modes')[0].children.forEach(x => x.click()); assert.deepEqual(modes, ['move', 'resize', 'rotate']);
const precise={editable:true,x:1.123456789012345,y:2.345678901234567,width:3.456789012345678,height:4.567890123456789,rotation:5.67890123456789};
api.show(precise);assert.notEqual(inputs[0].value,String(precise.x));panel.children.find(x=>x.textContent==='Apply').click();
for(const key of ['x','y','width','height','rotation'])assert.equal(applied.at(-1)[key],precise[key]);
const count=applied.length;inputs[0].value='';panel.children.find(x=>x.textContent==='Apply').click();assert.equal(applied.length,count);
document.activeElement = previous;
api.show({ editable: false, label: 'GDS target', x: 9, y: 8, width: 7, height: 6, rotation: 5 }); assert(panel.children.some(x => x.textContent.includes('GDS geometry is read-only'))); assert(inputs.every(x => x.disabled)); assert(panel.children.find(x => x.textContent === 'Apply').hidden);
panel.listeners.keydown({ key: 'Escape', preventDefault() {}, stopPropagation() {} }); assert(!api.isOpen()); assert.equal(closed, 1); assert.equal(document.activeElement, previous);
console.log('shape properties tests passed');
