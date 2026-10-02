const assert = require('assert/strict');
const RouteImageMask = require('../../webview/route-image-mask.js');

function image(width, height, paint) {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const i = 4 * (y * width + x); const p = paint(x, y);
        data[i] = p[0]; data[i + 1] = p[1]; data[i + 2] = p[2]; data[i + 3] = p[3] === undefined ? 255 : p[3];
    }
    return data;
}

const rectangle = image(8, 7, (x, y) => x >= 2 && x <= 5 && y >= 2 && y <= 4 ? [240, 240, 240] : [20, 20, 20]);
const contours = RouteImageMask.fromPixels({ data: rectangle, width: 8, height: 7, threshold: 20, mode: 'contours' });
assert(contours.counts.contours > 0);
assert.equal(contours.mask.length, 56);

const filled = RouteImageMask.fromPixels({ data: rectangle, width: 8, height: 7, threshold: 20, mode: 'filled' });
assert(filled.counts.filled > 0, 'closed contour interior is filled');
assert(filled.counts.occupied >= filled.counts.contours);

const transparent = image(8, 7, (x, y) => x >= 2 && x <= 5 && y >= 2 && y <= 4 ? [240, 240, 240, 255] : [255, 255, 255, 0]);
const transparentResult = RouteImageMask.fromPixels({ data: transparent, width: 8, height: 7, threshold: 20 });
for (let i = 0; i < transparentResult.mask.length; i++) if (!transparent[i * 4 + 3]) assert.equal(transparentResult.mask[i], 0);

const lowContrast = image(5, 3, (x) => x < 2 ? [100, 100, 100] : [108, 108, 108]);
assert.equal(RouteImageMask.fromPixels({ data: lowContrast, width: 5, height: 3, threshold: 1000 }).counts.contours, 0);
assert(RouteImageMask.fromPixels({ data: lowContrast, width: 5, height: 3, threshold: 1 }).counts.contours > 0);

const open = image(7, 7, (x, y) => (x === 3 && y < 5) || (y === 2 && x > 1 && x < 6) ? [250, 250, 250] : [10, 10, 10]);
const openResult = RouteImageMask.fromPixels({ data: open, width: 7, height: 7, threshold: 20, mode: 'filled' });
assert.equal(openResult.counts.filled, 0, 'open contour does not invent an enclosed fill');

const affine = RouteImageMask.toObstacles({ width: 1, height: 1, mask: Uint8Array.of(1) }, (x, y) => [2 * x + 10, 3 * y - 4]);
assert.deepEqual(affine[0].rings[0], [[10, -4], [12, -4], [12, -1], [10, -1], [10, -4]]);
const projective = RouteImageMask.toObstacles({ width: 1, height: 1, mask: Uint8Array.of(1) }, (x, y) => [x / (1 + y), y / (1 + x)]);
assert.deepEqual(projective[0].rings[0], [[0, 0], [1, 0], [.5, .5], [0, 1], [0, 0]]);
const failed = RouteImageMask.toObstacles({ width: 2, height: 1, mask: Uint8Array.of(1, 1) }, () => { throw new Error('bad transform'); });
assert.equal(failed.length, 1); assert.match(failed[0].error, /bad transform/); assert.deepEqual(failed[0].rings, []);
console.log(JSON.stringify({ status: 'passed', checks: ['rectangle-contours', 'transparent-padding', 'filled-closed', 'low-contrast-threshold', 'open-contour-no-fill', 'affine-cell-corners', 'projective-cell-corners', 'explicit-transform-failure'] }));
