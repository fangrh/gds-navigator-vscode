'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '../..');
const plannerSource = fs.readFileSync(path.join(ROOT, 'webview/route-planner.js'), 'utf8');
const artifact = require('../../scripts/geometry-artifact.cjs').verifyArtifact();
globalThis.GdsGeometryWasm = artifact;
const kernel = require(path.join(ROOT, 'webview/rust-geometry.js'));
assert(kernel.getModule() instanceof WebAssembly.Module, 'generated geometry artifact did not compile');

const rect = (x0, y0, x1, y1, closed = false) => {
  const ring = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  if (closed) ring.push(ring[0].slice());
  return { rings: [ring] };
};
const hole = { rings: [[[3, -3], [7, -3], [7, 3], [3, 3]], [[4, -2], [6, -2], [6, 2], [4, 2]]] };
const repeated = { rings: [[[2, -2], [4, -2], [4, -2], [4, 2], [2, 2], [2, -2]]] };

function planner(withKernel) {
  const sandbox = { GdsGeometryKernel: withKernel ? kernel : undefined };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(plannerSource, sandbox, { filename: 'route-planner.js' });
  return sandbox.RoutePlanner;
}

function countedKernel() {
  const counts = { create: 0, clear: 0, dispose: 0 };
  const api = {
    create(obstacles) {
      counts.create++;
      const value = kernel.create(obstacles);
      if (!value) return null;
      return {
        clear(a, b, radius) { counts.clear++; return value.clear(a, b, radius); },
        dispose() { counts.dispose++; value.dispose(); },
      };
    },
  };
  return { api, counts };
}

const baseline = planner(false);
const rust = planner(true);
const cases = [
  { name: 'direct', spec: { start: [0, 0], end: [10, 0], width: 1, clearance: .25, gridSize: 1, obstacles: [] } },
  { name: 'manhattan-barrier', spec: { start: [0, 0], end: [10, 0], width: 1, clearance: .25, gridSize: 1, obstacles: [rect(4, -2, 6, 2)] } },
  { name: 'octilinear-barrier', spec: { start: [.13, .17], end: [9.81, .22], style: 'octilinear', width: 1, clearance: .25, gridSize: 1, obstacles: [rect(4, -2, 6, 2, true)] } },
  { name: 'hole', spec: { start: [0, 0], end: [10, 0], width: 0, clearance: 0, gridSize: 1, obstacles: [hole] } },
  { name: 'repeated-vertices', spec: { start: [0, 0], end: [8, 0], width: 0, clearance: .1, gridSize: 1, obstacles: [repeated] } },
  { name: 'guide-bias', spec: { start: [0, 0], end: [10, 0], width: 1, clearance: .25, gridSize: 1, reference: [[0, 3], [10, 3]], obstacles: [rect(4, -2, 6, 2)] } },
  { name: 'blocked-start', spec: { start: [4, 0], end: [10, 0], width: 1, clearance: .25, gridSize: 1, obstacles: [rect(4, -2, 6, 2)] } },
  { name: 'blocked-end', spec: { start: [0, 0], end: [4, 0], width: 1, clearance: .25, gridSize: 1, obstacles: [rect(4, -2, 6, 2)] } },
  { name: 'cell-budget', spec: { start: [0, 0], end: [10, 0], gridSize: 1, maxCells: 1, obstacles: [rect(4, -2, 6, 2)] } },
  { name: 'expansion-budget', spec: { start: [0, 0], end: [10, 0], gridSize: 1, maxExpanded: 1, obstacles: [rect(4, -2, 6, 2)] } },
  { name: 'tangent-clearance', spec: { start: [0, 2], end: [10, 2], width: 0, clearance: 0, gridSize: 1, obstacles: [rect(4, -1, 6, 1)] } },
  { name: 'many-distant-obstacles', spec: { start: [0, 0], end: [10, 0], gridSize: 1, obstacles: Array.from({ length: 32 }, (_, i) => rect(100 + i * 4, 100, 101 + i * 4, 101)) } },
];

for (const { name, spec } of cases) {
  const expected = baseline.plan(spec);
  const actual = rust.plan(spec);
  assert.equal(JSON.stringify(actual), JSON.stringify(expected), `${name}: Rust planner result differs`);
}

const directCases = [
  [[0, 0], [10, 0], 0],
  [[0, 0], [10, 0], .2],
  [[0, 4], [10, 4], 0],
  [[5, 5], [5, 5], 0],
  [[3.7, 0], [4.1, 0], .2],
  [[0, 0], [10, 0], 1e-9],
];
const directObstacles = [rect(4, -1, 6, 1), hole, repeated];
for (const [a, b, radius] of directCases) {
  const expected = baseline.isClear([a, b], directObstacles, radius);
  const context = kernel.create(directObstacles);
  assert(context, 'direct kernel context creation failed');
  try { assert.equal(context.clear(a, b, radius), expected, `direct clear mismatch for ${JSON.stringify([a, b, radius])}`); }
  finally { context.dispose(); }
}
for (const { obstacles, queries } of [
  { obstacles: [rect(1e-6, -2e-6, 4e-6, 2e-6)], queries: [[[0, 0], [8e-6, 0], 0], [[0, 3e-6], [8e-6, 3e-6], 1e-9]] },
  { obstacles: [rect(1e9, 1e9, 1e9 + 10, 1e9 + 10)], queries: [[[1e9 - 10, 1e9 + 5], [1e9 + 20, 1e9 + 5], 0], [[1e9 - 10, 1e9 + 20], [1e9 + 20, 1e9 + 20], 0]] },
]) {
  const context = kernel.create(obstacles);
  assert(context);
  try {
    for (const [a, b, radius] of queries) assert.equal(context.clear(a, b, radius), baseline.isClear([a, b], obstacles, radius));
  } finally { context.dispose(); }
}

// Known clearances independently pin the boundary policy, rather than only
// comparing two implementations. Equality at radius + EPS is blocked.
const boundaryObstacles = [rect(0, 0, 10, 10, true)];
const boundaryContext = kernel.create(boundaryObstacles);
try {
  for (const [radius, clear] of [[1 - 2e-9, true], [1 - 1e-9, false], [1, false], [1 + 1e-9, false]]) {
    assert.equal(boundaryContext.clear([-5, 11], [15, 11], radius), clear);
    assert.equal(baseline.isClear([[-5, 11], [15, 11]], boundaryObstacles, radius), clear);
  }
} finally { boundaryContext.dispose(); }
const interior = { rings: [rect(0, 0, 10, 10).rings[0], rect(3, 3, 7, 7).rings[0]] };
const interiorContext = kernel.create([interior]);
try {
  assert.equal(interiorContext.clear([5, 5], [6, 5], .99), true);
  assert.equal(interiorContext.clear([5, 5], [6, 5], 1), false);
} finally { interiorContext.dispose(); }

// Seeded ordinary-scale segments, including hole interiors and far-away BVH misses.
let seed = 0x12345678;
const random = () => ((seed = (1664525 * seed + 1013904223) >>> 0) / 0x100000000);
const randomObstacles = [hole, repeated, ...Array.from({ length: 24 }, (_, i) => rect(50 + i * 3, -20 + (i % 4) * 10, 51 + i * 3, -19 + (i % 4) * 10))];
const randomContext = kernel.create(randomObstacles);
assert(randomContext);
try {
  for (let i = 0; i < 120; i++) {
    const a = [random() * 120 - 10, random() * 100 - 50];
    const b = [random() * 120 - 10, random() * 100 - 50];
    const radius = random() * .8;
    assert.equal(randomContext.clear(a, b, radius), baseline.isClear([a, b], randomObstacles, radius), `seeded segment ${i}`);
  }
} finally { randomContext.dispose(); }

let scaledSegments = 0;
for (const scale of [1e-8, 1e-4, 1, 1e6, 1e40]) {
  const obstacles = Array.from({ length: 40 }, () => {
    const x = (random() * 100 - 50) * scale, y = (random() * 100 - 50) * scale;
    return rect(x, y, x + random() * 4 * scale, y + random() * 4 * scale);
  });
  const context = kernel.create(obstacles);
  assert(context);
  try {
    for (let i = 0; i < 1000; i++) {
      const a = [(random() * 120 - 60) * scale, (random() * 120 - 60) * scale];
      const b = [(random() * 120 - 60) * scale, (random() * 120 - 60) * scale];
      const radius = random() * scale;
      assert.equal(context.clear(a, b, radius), baseline.isClear([a, b], obstacles, radius), `scale ${scale}, segment ${i}`);
      scaledSegments++;
    }
  } finally { context.dispose(); }
}

// Verify planner creation, query, and disposal, including early returns.
for (const { name, spec } of cases.slice(1, 5).concat(cases.slice(6, 10))) {
  const counted = countedKernel();
  const sandbox = { GdsGeometryKernel: counted.api }; sandbox.globalThis = sandbox; vm.createContext(sandbox);
  vm.runInContext(plannerSource, sandbox);
  const result = sandbox.RoutePlanner.plan(spec);
  assert.equal(JSON.stringify(result), JSON.stringify(baseline.plan(spec)), `${name}: counted planner mismatch`);
  if (spec.obstacles && spec.obstacles.length) {
    assert.equal(counted.counts.create, 1, `${name}: expected one native create`);
    assert.equal(counted.counts.dispose, 1, `${name}: native context leaked`);
    assert(counted.counts.clear > 0, `${name}: native clear was not queried`);
  }
}

assert.equal(kernel.create([]), null);
assert.equal(kernel.create([rect(0, 0, 1, 1), { rings: [[[1.000000000000001e100, 0], [2, 0], [2, 1]]] }]), null);
assert.equal(kernel.create([rect(0, 0, NaN, 1)]), null);
assert.equal(kernel.create([{ rings: [new Array(2000000)] }]), null, 'oversized input must fall back before allocation');
const boundedContext = kernel.create([rect(0, 0, 1, 1)]);
assert.equal(boundedContext.clear([1e101, 0], [1e101, 1], 0), undefined, 'unsupported query must use the JS oracle');
boundedContext.dispose(); boundedContext.dispose();
assert.equal(boundedContext.clear([2, 2], [3, 3], 0), undefined, 'disposed context cannot be queried');

// Unavailable and corrupt artifacts must fail closed without contaminating the host shim.
for (const wasm of [undefined, { base64: 'not-wasm' }]) {
  const sandbox = { WebAssembly, GdsGeometryWasm: wasm, atob: globalThis.atob }; sandbox.globalThis = sandbox; vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'webview/rust-geometry.js'), 'utf8'), sandbox);
  assert.equal(sandbox.GdsGeometryKernel.getModule(), null);
  assert.equal(sandbox.GdsGeometryKernel.create([rect(0, 0, 1, 1)]), null);
}

console.log(JSON.stringify({ status: 'passed', plannerCases: cases.length, seededSegments: 120 + scaledSegments, nativePath: true }));
