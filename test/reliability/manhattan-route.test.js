const assert = require('assert/strict');
const route = require('../../webview/manhattan-route.js');
assert(route.validateSpec({ version: 1, horizontalFirst: true, width: 2, layer: [4, 0] }));
assert(!route.validateSpec({ version: 1, horizontalFirst: true, width: 0, layer: [4, 0] }));
const zig = route.orthogonalize([[-3, -2], [4, 5], [4, -1]], true);
assert.deepEqual(zig, [[-3, -2], [4, -2], [4, 5], [4, -1]]);
assert(route.validate(zig));
assert.deepEqual(route.orthogonalize([[0, 0], [4, 0], [4, 0], [4, 3]], true), [[0, 0], [4, 0], [4, 3]]);
assert(!route.validate([[0, 0], [1, 1]]));
assert(route.validate([[0, 0], [1, 0], [0, 0]]));
assert.deepEqual(route.normalize([[0, 0], [1, 0], [0, 0]]), [[0, 0], [1, 0], [0, 0]]);
const base = [[0, 0], [5, 0], [5, 4], [10, 4]];
assert.deepEqual(route.moveSegment(base, 0, 2), [[0, 2], [5, 2], [5, 4], [10, 4]]);
assert.deepEqual(route.moveSegment(base, 1, 3), [[0, 0], [8, 0], [8, 4], [10, 4]]);
assert.deepEqual(route.moveSegment(base, 2, -2), [[0, 0], [5, 0], [5, 2], [10, 2]]);
assert.throws(() => route.orthogonalize([[0, 0], [NaN, 2]]), /finite/);
assert.throws(() => route.moveSegment(base, 0, Infinity), /offset/);
assert(route.validate(route.orthogonalize([[0, 0], [5, 0], [2, 0], [2, 4]], true)));
let seed = 0x12345678; const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0x100000000; };
for (let n = 0; n < 200; n++) {
    const waypoints = [[0, 0]]; for (let i = 0; i < 5; i++) waypoints.push([Math.floor(rand() * 21) - 10, Math.floor(rand() * 21) - 10]);
    const r = route.orthogonalize(waypoints, n % 2 === 0); assert(route.validate(r)); const before = JSON.stringify(r);
    for (let i = 0; i < r.length - 1; i++) { try { const moved = route.moveSegment(r, i, (n % 3) - 1); assert(route.validate(moved)); } catch (error) { assert.match(error.message, /invalidate/); } }
    assert.equal(JSON.stringify(r), before);
}
console.log(JSON.stringify({ status: 'passed', checks: ['negative-zigzag', 'duplicate-normalize', 'diagonal-reject', 'segment-move-all-positions', 'invalid-finite', 'backtrack-invariant'] }));
