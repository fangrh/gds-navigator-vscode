(function (root, factory) {
    var api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else if (root) root.LayoutReview = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    var MAX_COORD = 1e12;
    var MAX_ITEMS = 10000;
    var MAX_TEXT = 1024;
    var own = Object.prototype.hasOwnProperty;
    function finite(n) { return typeof n === 'number' && Number.isFinite(n); }
    function point(p) { return Array.isArray(p) && p.length === 2 && finite(p[0]) && finite(p[1]); }
    function boundedPoint(p) { return point(p) && Math.abs(p[0]) <= MAX_COORD && Math.abs(p[1]) <= MAX_COORD; }
    function plain(o) { return !!o && typeof o === 'object' && !Array.isArray(o); }
    function stable(v) {
        if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
        if (plain(v)) return '{' + Object.keys(v).sort().map(function (k) { return JSON.stringify(k) + ':' + stable(v[k]); }).join(',') + '}';
        return JSON.stringify(v);
    }
    function ringCanonical(r) {
        if (!Array.isArray(r) || !r.every(point)) return r;
        var a = r.length > 1 && stable(r[0]) === stable(r[r.length - 1]) ? r.slice(0, -1) : r.slice();
        if (!a.length) return r.slice();
        function minRotation(q) {
            var n = q.length, tokens = q.map(stable), i = 0, j = 1, k = 0;
            while (i < n && j < n && k < n) {
                var x = tokens[(i + k) % n], y = tokens[(j + k) % n];
                if (x === y) { k++; continue; }
                if (x > y) i = i + k + 1; else j = j + k + 1;
                if (i === j) j++;
                k = 0;
            }
            var start = Math.min(i, j), out = [];
            for (var z = 0; z < n; z++) out.push(q[(start + z) % n]);
            return out;
        }
        var f = minRotation(a), b = minRotation(a.slice().reverse());
        var best = stable(f) <= stable(b) ? f : b; best = best.slice(); best.push(best[0]); return best;
    }
    function canonicalGeometry(g) {
        if (!plain(g) || typeof g.type !== 'string' || !Array.isArray(g.coordinates)) return g;
        function coords(c, type) {
            if (type === 'Polygon') return c.map(ringCanonical);
            if (type === 'MultiPolygon') return c.map(function (p) { return p.map(ringCanonical); });
            return c;
        }
        return { type: g.type, coordinates: coords(g.coordinates, g.type) };
    }
    function measure(a, b) {
        if (!boundedPoint(a) || !boundedPoint(b)) throw new TypeError('Measurement points must be finite bounded [x, y] arrays');
        var dx = b[0] - a[0], dy = b[1] - a[1];
        var distance = Math.hypot(dx, dy), angle = Math.atan2(dy, dx) * 180 / Math.PI;
        if (![dx, dy, distance, angle].every(finite)) throw new RangeError('Measurement result is not finite');
        return { dx: dx, dy: dy, distance: distance, angle: angle };
    }
    function layerOf(f) {
        var p = f && f.properties;
        return p && { layer: own.call(p, 'layer') ? p.layer : p.layer_id, data_type: p.data_type };
    }
    function geometryKey(g) {
        if (!plain(g) || typeof g.type !== 'string' || !Array.isArray(g.coordinates)) return null;
        return stable(canonicalGeometry(g));
    }
    function sourceOf(f) {
        var p = f && f.properties, s = p && (p.source || p.provenance);
        if (!plain(s)) return null;
        if (s.source_resolution === 'ambiguous') return null;
        var file = s && s.file, instance = s && s.instance_name;
        var array = s && s.array_index, loop = s && s.loop_index, chain = s && s.call_chain;
        if (typeof file !== 'string' || !file || typeof instance !== 'string' || !instance) return null;
        return [file.replace(/\\/g, '/'), instance, array, loop, chain].map(stable).join('|');
    }
    function provenanceKey(f) { return sourceOf(f); }
    function centroid(g) {
        var pts = [];
        function walk(x) { if (point(x)) pts.push(x); else if (Array.isArray(x)) x.forEach(walk); }
        walk(g && g.coordinates);
        if (!pts.length) return null;
        return [pts.reduce(function (s, p) { return s + p[0]; }, 0) / pts.length, pts.reduce(function (s, p) { return s + p[1]; }, 0) / pts.length];
    }
    function dimensions(g) {
        var pts = [], c = g && g.coordinates;
        (function walk(x) { if (point(x)) pts.push(x); else if (Array.isArray(x)) x.forEach(walk); })(c);
        if (!pts.length) return null;
        var xs = pts.map(function (p) { return p[0]; }), ys = pts.map(function (p) { return p[1]; });
        return [Math.max.apply(null, xs) - Math.min.apply(null, xs), Math.max.apply(null, ys) - Math.min.apply(null, ys)];
    }
    function close(n, target, tolerance) { return finite(n) && finite(target) && Math.abs(n - target) <= Math.max(1e-12, Math.abs(tolerance)); }
    function similar(features, seed, options) {
        if (!Array.isArray(features) || !plain(seed) || !plain(options)) throw new TypeError('Invalid similarity input');
        var scope = ['layer', 'dimensions', 'source'].filter(function (k) { return options[k] === true; });
        if (!scope.length) throw new TypeError('At least one similarity criterion is required');
        var tol = options.tolerance == null ? 0 : options.tolerance;
        if (!finite(tol) || tol < 0) throw new TypeError('Invalid similarity tolerance');
        var sg = seed.geometry, sd = dimensions(sg), sl = layerOf(seed), ss = sourceOf(seed);
        return features.filter(function (f) {
            if (!plain(f)) return false;
            if (scope.indexOf('layer') >= 0 && stable(layerOf(f)) !== stable(sl)) return false;
            if (scope.indexOf('dimensions') >= 0) {
                var d = dimensions(f.geometry); if (!sd || !d || !close(d[0], sd[0], tol) || !close(d[1], sd[1], tol)) return false;
            }
            if (scope.indexOf('source') >= 0 && (ss == null || sourceOf(f) !== ss)) return false;
            return f.properties && f.properties.element_id != null;
        }).map(function (f) { return f.properties.element_id; });
    }
    function canonical(f) { return stable({ geometry: canonicalGeometry(f.geometry), layer: layerOf(f) }); }
    function compare(beforeFeatures, afterFeatures) {
        if (!Array.isArray(beforeFeatures) || !Array.isArray(afterFeatures)) throw new TypeError('Features must be arrays');
        var before = beforeFeatures.slice(), after = afterFeatures.slice(), usedB = [], usedA = [], changed = [];
        var bm = new Map(), am = new Map();
        before.forEach(function (b, i) { var k = canonical(b); if (!bm.has(k)) bm.set(k, []); bm.get(k).push(i); });
        after.forEach(function (a, i) { var k = canonical(a), q = bm.get(k), cursor = q && q._cursor || 0; if (q && cursor < q.length) { usedB[q[cursor]] = true; q._cursor = cursor + 1; usedA[i] = true; } else { if (!am.has(k)) am.set(k, []); am.get(k).push(i); } });
        var bs = new Map(), as = new Map();
        before.forEach(function (b, i) { if (usedB[i]) return; var k = provenanceKey(b); if (k) { if (!bs.has(k)) bs.set(k, []); bs.get(k).push(i); } });
        after.forEach(function (a, i) { if (usedA[i]) return; var k = provenanceKey(a); if (k) { if (!as.has(k)) as.set(k, []); as.get(k).push(i); } });
        as.forEach(function (aq, k) { var bq = bs.get(k); if (aq.length === 1 && bq && bq.length === 1) { usedA[aq[0]] = true; usedB[bq[0]] = true; changed.push({ before: before[bq[0]], after: after[aq[0]] }); } });
        var added = after.filter(function (a, i) { return !usedA[i]; });
        var removed = before.filter(function (b, i) { return !usedB[i]; });
        return { added: added, removed: removed, changed: changed, unchanged: after.length - added.length - changed.length };
    }
    function validState(state) {
        if (!plain(state) || state.version !== 1 || !Array.isArray(state.bookmarks) || !Array.isArray(state.measurements) || state.bookmarks.length > 100 || state.measurements.length > 200) return false;
        function text(s) { return typeof s === 'string' && s.length <= MAX_TEXT; }
        var ids = new Set();
        function id(s) { return typeof s === 'string' && s.length > 0 && s.length <= 160 && !ids.has(s) && (ids.add(s), true); }
        function p(p) { return boundedPoint(p); }
        for (var i = 0; i < state.bookmarks.length; i++) { var b = state.bookmarks[i]; if (!plain(b) || !id(b.id) || typeof b.name !== 'string' || b.name.length > 120 || !p(b.center) || !finite(b.resolution) || b.resolution <= 0 || b.resolution > MAX_COORD || !finite(b.rotation) || !Array.isArray(b.visibleLayers) || b.visibleLayers.length > 1024 || !b.visibleLayers.every(text)) return false; }
        for (var j = 0; j < state.measurements.length; j++) { var m = state.measurements[j]; if (!plain(m) || !id(m.id) || !p(m.a) || !p(m.b) || !(m.layoutHash === '' || (typeof m.layoutHash === 'string' && /^[0-9a-fA-F]{64}$/.test(m.layoutHash)))) return false; }
        return true;
    }
    return { measure: measure, similar: similar, compare: compare, validateReviewState: validState, geometryKey: geometryKey, provenanceKey: provenanceKey };
}));
