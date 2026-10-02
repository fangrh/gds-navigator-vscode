(function (root, factory) {
    var api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.ManhattanRoute = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';
    function finite(n) { return typeof n === 'number' && Number.isFinite(n); }
    function point(p) { return Array.isArray(p) && p.length === 2 && finite(p[0]) && finite(p[1]); }
    function copy(points) { return points.map(function (p) { return [p[0], p[1]]; }); }
    function compact(points) {
        var out = [];
        points.forEach(function (p) {
            if (!out.length || out[out.length - 1][0] !== p[0] || out[out.length - 1][1] !== p[1]) out.push([p[0], p[1]]);
            while (out.length >= 3) {
                var a = out[out.length - 3], b = out[out.length - 2], c = out[out.length - 1];
                var collinear = (a[0] === b[0] && b[0] === c[0]) || (a[1] === b[1] && b[1] === c[1]);
                var sameDirection = (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1]) > 0;
                if (!collinear || !sameDirection) break;
                out.splice(out.length - 2, 1);
            }
        });
        return out;
    }
    function orthogonalize(points, horizontalFirst, style) {
        if (!Array.isArray(points) || points.length < 2 || points.some(function (p) { return !point(p); })) throw new TypeError('Route points must be finite 2D points');
        horizontalFirst = horizontalFirst !== false;
        var out = [[points[0][0], points[0][1]]];
        for (var i = 1; i < points.length; i++) {
            var a = points[i - 1], b = points[i];
            if (a[0] === b[0] || a[1] === b[1]) out.push([b[0], b[1]]);
            else if (style === 'octilinear') {
                var dx=b[0]-a[0],dy=b[1]-a[1],d=Math.min(Math.abs(dx),Math.abs(dy));
                var corner=horizontalFirst ? [b[0]-Math.sign(dx)*d,b[1]-Math.sign(dy)*d] : [a[0]+Math.sign(dx)*d,a[1]+Math.sign(dy)*d];
                out.push(corner,[b[0],b[1]]);
            }
            else if (horizontalFirst) { out.push([b[0], a[1]], [b[0], b[1]]); }
            else { out.push([a[0], b[1]], [b[0], b[1]]); }
        }
        return compact(out);
    }
    function validate(points, style) {
        if (!Array.isArray(points) || points.length < 2) return false;
        for (var i = 0; i < points.length; i++) {
            if (!point(points[i])) return false;
            if (i && points[i][0] === points[i - 1][0] && points[i][1] === points[i - 1][1]) return false;
            if (i && points[i][0] !== points[i - 1][0] && points[i][1] !== points[i - 1][1]) {
                var dx=Math.abs(points[i][0]-points[i-1][0]),dy=Math.abs(points[i][1]-points[i-1][1]);
                if(style!=='octilinear'||Math.abs(dx-dy)>1e-8*Math.max(1,dx,dy))return false;
            }
        }
        return true;
    }
    function normalize(points) {
        if (!Array.isArray(points) || points.length < 2 || points.some(function (p) { return !point(p); })) throw new TypeError('Route points must be finite 2D points');
        return compact(points);
    }
    function validateSpec(spec) {
        return !!spec && typeof spec === 'object' && spec.version === 1 && typeof spec.horizontalFirst === 'boolean' && finite(spec.width) && spec.width > 0 &&
            (spec.style===undefined||['manhattan','octilinear'].includes(spec.style)) &&
            (spec.method===undefined||['manual','guided','auto'].includes(spec.method)) &&
            (spec.clearance===undefined||(finite(spec.clearance)&&spec.clearance>=0)) &&
            (spec.gridSize===undefined||(finite(spec.gridSize)&&spec.gridSize>0)) &&
            (spec.avoidGds===undefined||typeof spec.avoidGds==='boolean') &&
            (spec.avoidImages===undefined||typeof spec.avoidImages==='boolean') &&
            (spec.imageThreshold===undefined||(Number.isInteger(spec.imageThreshold)&&spec.imageThreshold>=1&&spec.imageThreshold<=255)) &&
            (spec.imageMode===undefined||['filled','contours'].includes(spec.imageMode)) &&
            Array.isArray(spec.layer) && spec.layer.length === 2 && spec.layer.every(function (n) { return Number.isInteger(n) && n >= 0 && n <= 65535; });
    }
    function moveSegment(points, index, offset) {
        if (!validate(points)) throw new TypeError('Invalid Manhattan route');
        if (!Number.isInteger(index) || index < 0 || index >= points.length - 1 || !finite(offset)) throw new RangeError('Invalid segment or offset');
        var out = copy(points), a = out[index], b = out[index + 1], horizontal = a[1] === b[1];
        if (horizontal) { out[index][1] += offset; out[index + 1][1] += offset; }
        else { out[index][0] += offset; out[index + 1][0] += offset; }
        var result = compact(out);
        if (!validate(result)) throw new Error('Segment move would invalidate the Manhattan route');
        return result;
    }
    return { version: 1, orthogonalize: orthogonalize, normalize: normalize, validate: validate, moveSegment: moveSegment, validateSpec: validateSpec };
}));
