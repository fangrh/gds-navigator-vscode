(function (root, factory) {
    var api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.LayoutPrimitives = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';
    var EPS = 32 * Number.EPSILON;
    var kinds = { taper: true, straight: true, pad: true };
    function finite(n) { return typeof n === 'number' && Number.isFinite(n); }
    function point(p) { return Array.isArray(p) && p.length === 2 && finite(p[0]) && finite(p[1]); }
    function layer(l) { return Array.isArray(l) && l.length === 2 && l.every(function (n) { return Number.isInteger(n) && n >= 0 && n <= 65535; }); }
    function validSpec(s) {
        if (!s || typeof s !== 'object' || Array.isArray(s) || s.version !== 1 || !Object.prototype.hasOwnProperty.call(kinds, s.kind)) return false;
        if (!(finite(s.length) && s.length > 0 && finite(s.width1) && s.width1 > 0 && finite(s.width2) && s.width2 > 0)) return false;
        if ((s.kind === 'straight' || s.kind === 'pad') && s.width2 !== s.width1) return false;
        return layer(s.layer) && point(s.origin) && finite(s.rotationDeg);
    }
    function defaults(kind) {
        kind = kind || 'taper';
        if (!kinds[kind]) kind = 'taper';
        return { version: 1, kind: kind, length: kind === 'pad' ? 10 : 20, width1: kind === 'pad' ? 10 : 1, width2: kind === 'pad' ? 10 : (kind === 'straight' ? 1 : 2), layer: [1, 0], origin: [0, 0], rotationDeg: 0 };
    }
    function rotate(p, s) {
        var a = (s.rotationDeg % 360) * Math.PI / 180, c = Math.cos(a), si = Math.sin(a);
        return [s.origin[0] + c * p[0] - si * p[1], s.origin[1] + si * p[0] + c * p[1]];
    }
    function geometry(s) {
        if (!validSpec(s)) throw new TypeError('Invalid primitive specification');
        var w1 = s.width1 / 2, w2 = s.width2 / 2, l = s.length;
        var ring = [[0, -w1], [l, -w2], [l, w2], [0, w1], [0, -w1]].map(function (p) { return rotate(p, s); });
        if(!ring.every(point))throw new TypeError('Primitive coordinates exceed the finite numeric range');
        return { type: 'Polygon', coordinates: [ring] };
    }
    function closeRing(g) {
        return g && g.type === 'Polygon' && Array.isArray(g.coordinates) && g.coordinates.length === 1 && Array.isArray(g.coordinates[0]) ? g.coordinates[0] : null;
    }
    function near(a, b) { return Math.abs(a - b) <= EPS * Math.max(1, Math.abs(a), Math.abs(b)); }
    function samePoint(a, b) { return point(a) && point(b) && near(a[0], b[0]) && near(a[1], b[1]); }
    function sameRing(a, b) { return a && b && a.length === b.length && a.every(function (p, i) { return samePoint(p, b[i]); }); }
    function validRing(r) { return Array.isArray(r) && r.length >= 4 && r.every(point) && samePoint(r[0], r[r.length-1]); }
    function inferredTranslation(spec, actual, expected) {
        var ar = closeRing(actual), er = closeRing(expected);
        if (!ar || !er || ar.length !== 5) return null;
        var dx = ar[0][0] - er[0][0], dy = ar[0][1] - er[0][1];
        for (var i = 0; i < ar.length; i++) if (!samePoint(ar[i], [er[i][0]+dx,er[i][1]+dy])) return null;
        return [spec.origin[0] + dx, spec.origin[1] + dy];
    }
    function recipe(g, s) {
        var ring = closeRing(g) || [];
        return { operation: 'Component.add_polygon', points: ring.map(function (p) { return [p[0], p[1]]; }), layer: s.layer.slice() };
    }
    function describe(spec, actual) {
        if (!validSpec(spec)) throw new TypeError('Invalid primitive specification');
        var expected = geometry(spec), ring = closeRing(actual);
        if (!ring || !validRing(ring)) throw new TypeError('Primitive geometry must be a finite closed Polygon ring');
        var status = sameRing(ring, closeRing(expected)) ? 'exact' : null;
        var corrected = null;
        if (!status) { corrected = inferredTranslation(spec, actual, expected); status = corrected ? 'translated' : 'modified_geometry'; }
        var primitive = Object.assign({}, spec);
        if (status === 'translated') primitive.origin = corrected;
        var out = { version: 1, parameter_status: status, geometry: actual, construction: recipe(actual, spec), recipe: recipe(actual, spec) };
        if (status !== 'modified_geometry') { out.primitive = primitive; out.parameters = primitive; }
        return out;
    }
    return { version: 1, validate: validSpec, geometry: geometry, describe: describe, defaults: defaults };
}));
