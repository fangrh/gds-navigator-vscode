'use strict';
const assert = require('assert/strict');
const RoutePlanner = require('../../webview/route-planner.js');

const rect = (x0, y0, x1, y1, id) => ({ id, rings: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1]]] });
const hole = { rings: [[[3, -3], [7, -3], [7, 3], [3, 3]], [[4, -2], [6, -2], [6, 2], [4, 2]]] };
const base = { start: [0, 0], end: [10, 0], width: 1, clearance: 0.25, gridSize: 1, obstacles: [] };
const assertStyle = (points, style) => { for (let i = 1; i < points.length; i++) { const dx = Math.abs(points[i][0] - points[i - 1][0]); const dy = Math.abs(points[i][1] - points[i - 1][1]); assert(dx > 1e-9 || dy > 1e-9); assert(dx < 1e-9 || dy < 1e-9 || style === 'octilinear' && Math.abs(dx - dy) < 1e-8, `invalid ${style} segment`); } };

let direct = RoutePlanner.plan(base);
assert(direct.ok); assert.deepEqual(direct.points[0], [0, 0]); assert.deepEqual(direct.points.at(-1), [10, 0]);
assert(RoutePlanner.isClear(direct.points, [], 0.75));

const blocked = { ...base, obstacles: [rect(4, -2, 6, 2, 'barrier')] };
const detour = RoutePlanner.plan(blocked); assert(detour.ok, detour.error); assert(detour.points.length > 2); assert(RoutePlanner.isClear(detour.points, blocked.obstacles, 0.75));
assert.deepEqual(RoutePlanner.plan(blocked).points, detour.points, 'route must be deterministic');
const longDetour = RoutePlanner.plan({ start: [0, 0], end: [35, 0], width: 1, clearance: 1, gridSize: 1, obstacles: [rect(14, -4, 20, 4)] });
assert(longDetour.ok, longDetour.error); assert(longDetour.points.length <= 10, 'simple rectangular detour should not retain staircase corners'); assertStyle(longDetour.points, 'manhattan');

assert.equal(RoutePlanner.plan({ ...base, start: [4, 0], obstacles: [rect(4, -2, 6, 2)] }).ok, false, 'blocked start must be rejected');
assert.equal(RoutePlanner.isClear([[0, 0], [10, 0]], [rect(4, -1, 6, 1)], 1.1), false, 'narrow corridor must reject a blocked route');
const holeRoute = RoutePlanner.plan({ ...base, obstacles: [hole], width: 0, clearance: 0, gridSize: 1 });
assert(holeRoute.ok, holeRoute.error); assert(RoutePlanner.isClear(holeRoute.points, [hole], 0));
assert.equal(RoutePlanner.plan({ ...base, obstacles: [rect(-1, -10, 11, 10)] }).ok, false, 'sealed obstacle should have no path');

assert.equal(RoutePlanner.plan({ ...base, start: ['x', 0] }).ok, false);
assert.equal(RoutePlanner.plan({ ...base, style: 'diagonal' }).ok, false);
assert.equal(RoutePlanner.plan({ ...base, gridSize: -1 }).ok, false);
assert.equal(RoutePlanner.plan({ ...base, maxCells: 1 }).error.startsWith('search budget exceeded'), true);

const offGrid = RoutePlanner.plan({ ...base, start: [0.13, 0.17], end: [9.81, 0.22], style: 'octilinear' });
assert(offGrid.ok, offGrid.error); assert.deepEqual(offGrid.points[0], [0.13, 0.17]); assert.deepEqual(offGrid.points.at(-1), [9.81, 0.22]); assertStyle(offGrid.points, 'octilinear');
const offGridManhattan = RoutePlanner.plan({ ...base, start: [0.13, 0.17], end: [9.81, 2.22], style: 'manhattan' });
assert(offGridManhattan.ok, offGridManhattan.error); assert.deepEqual(offGridManhattan.points[0], [0.13, 0.17]); assert.deepEqual(offGridManhattan.points.at(-1), [9.81, 2.22]); assertStyle(offGridManhattan.points, 'manhattan');
assert.equal(RoutePlanner.plan({ ...base, end: [0, 0] }).error, 'start and end must be distinct');
const diagonal = RoutePlanner.plan({ ...base, style: 'octilinear', obstacles: [rect(4, -2, 6, 2)] });
assert(diagonal.ok); assertStyle(diagonal.points, 'octilinear');

const reference = [[0, 3], [10, 3]];
const preferred = RoutePlanner.plan({ ...base, reference, obstacles: [rect(4, -2, 6, 2)] });
const unreferenced = RoutePlanner.plan({ ...base, obstacles: [rect(4, -2, 6, 2)] });
assert(preferred.ok); assert(unreferenced.ok); assert(RoutePlanner.isClear(preferred.points, blocked.obstacles, 0.75)); assert(preferred.points.some(p => p[1] > 2.5), 'reference did not prefer the upper detour'); assert(unreferenced.points.some(p => p[1] < -2.5), 'deterministic baseline should use the lower detour');
assert.equal(RoutePlanner.isClear([[0, 0], [10, 0]], [rect(4, -1, 6, 1)], 0), false);
assert.equal(RoutePlanner.isClear([[0, 0], [3.7, 0]], [rect(4, -1, 6, 1)], 0.2), true); assert.equal(RoutePlanner.isClear([[0, 0], [4.1, 0]], [rect(4, -1, 6, 1)], 0.2), false, 'thin-wall edge clearance was skipped');
assert.equal(RoutePlanner.isClear([[0, 0], [10, 0]], [{ rings: [] }], 0), false);
console.log('route planner tests passed');
