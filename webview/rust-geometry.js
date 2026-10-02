/* Optional Rust/Wasm collision oracle. Pack once per route; queries pass only
 * five doubles. The planner owns the context and releases it in finally. */
(function (root, factory) {
    var api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.GdsGeometryKernel = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
    'use strict';
    var compiled, instance;
    var MAX_VALUES = 4000000, MAX_COORD = 1e100;

    function getModule() {
        if (compiled !== undefined) return compiled;
        compiled = null;
        try {
            if (!root.WebAssembly || !root.GdsGeometryWasm) return null;
            var binary = root.atob(root.GdsGeometryWasm.base64);
            var bytes = new Uint8Array(binary.length);
            for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
            compiled = new root.WebAssembly.Module(bytes);
        } catch (_) { /* Wasm may be unavailable or blocked by the host CSP. */ }
        return compiled;
    }

    // WebAssembly.Module is structured-cloned into each cancellable route
    // worker. It needs neither a worker fetch nor repeated compilation.
    function setModule(value) {
        if (root.WebAssembly && value instanceof root.WebAssembly.Module && value !== compiled) {
            compiled = value;
            instance = undefined;
        }
    }

    function bounded(value) {
        return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= MAX_COORD;
    }

    function create(obstacles) {
        if (!Array.isArray(obstacles) || !obstacles.length) return null;
        var module = getModule();
        if (!module) return null;
        var rings = 0, points = 0;
        for (var oi = 0; oi < obstacles.length; oi++) {
            var shape = obstacles[oi];
            if (!shape || !Array.isArray(shape.rings) || !shape.rings.length) return null;
            rings += shape.rings.length;
            for (var ri = 0; ri < shape.rings.length; ri++) {
                var ring = shape.rings[ri];
                if (!Array.isArray(ring) || ring.length < 3) return null;
                points += ring.length;
                if (3 + obstacles.length + 1 + rings + 1 + points * 2 > MAX_VALUES) return null;
                for (var pi = 0; pi < ring.length; pi++) {
                    var p = ring[pi];
                    if (!Array.isArray(p) || p.length !== 2 || !bounded(p[0]) || !bounded(p[1])) return null;
                }
            }
        }
        var length = 3 + obstacles.length + 1 + rings + 1 + points * 2;
        var exports, input = 0, context = 0;
        try {
            if (!instance) instance = new root.WebAssembly.Instance(module);
            exports = instance.exports;
            input = exports.gds_alloc(length) >>> 0;
            if (!input) return null;
            var values = new Float64Array(exports.memory.buffer, input, length);
            values.set([obstacles.length, rings, points]);
            var ringBase = 3 + obstacles.length + 1, pointBase = ringBase + rings + 1;
            var ringIndex = 0, pointIndex = 0;
            for (var o = 0; o < obstacles.length; o++) {
                values[3 + o] = ringIndex;
                for (var r = 0; r < obstacles[o].rings.length; r++) {
                    values[ringBase + ringIndex++] = pointIndex;
                    var source = obstacles[o].rings[r];
                    for (var n = 0; n < source.length; n++) {
                        values[pointBase + pointIndex * 2] = source[n][0];
                        values[pointBase + pointIndex * 2 + 1] = source[n][1];
                        pointIndex++;
                    }
                }
            }
            values[3 + obstacles.length] = rings;
            values[ringBase + rings] = points;
            context = exports.gds_create(input, length) >>> 0;
            if (!context) return null;
            return {
                clear: function (a, b, radius) {
                    if (!context || !bounded(a[0]) || !bounded(a[1]) || !bounded(b[0]) || !bounded(b[1]) || !bounded(radius) || radius < 0) return undefined;
                    try { return exports.gds_clear(context, a[0], a[1], b[0], b[1], radius) === 1; }
                    catch (_) { return undefined; }
                },
                dispose: function () {
                    if (context) { var pointer = context; context = 0; exports.gds_destroy(pointer); }
                }
            };
        } catch (_) { return null; }
        finally { if (input) exports.gds_free(input, length); }
    }

    return { create: create, getModule: getModule, setModule: setModule };
}));
