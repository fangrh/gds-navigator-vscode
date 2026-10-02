/* Conservative image-derived obstacle masks for autorouting.
 * This is an edge/occupancy aid, not semantic segmentation.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.RouteImageMask = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    function bad(message) { throw new TypeError('RouteImageMask: ' + message); }

    function luminance(data, index) {
        return (data[index] * 299 + data[index + 1] * 587 + data[index + 2] * 114) / 1000;
    }

    function fromPixels(options) {
        options = options || {};
        var data = options.data, width = options.width, height = options.height;
        if (!data || typeof data.length !== 'number') bad('data must be an RGBA array');
        if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1) bad('width and height must be positive integers');
        if (data.length < width * height * 4) bad('data is shorter than width * height * 4');
        var maxPixels = options.maxPixels === undefined ? 16777216 : Number(options.maxPixels);
        if (!Number.isInteger(maxPixels) || maxPixels < 1) bad('maxPixels must be a positive integer');
        if (width * height > maxPixels) throw new RangeError('RouteImageMask: pixel budget exceeded');
        var threshold = options.threshold === undefined ? 40 : Number(options.threshold);
        if (!Number.isFinite(threshold) || threshold < 0) bad('threshold must be a non-negative finite number');
        var mode = options.mode === undefined ? 'contours' : options.mode;
        if (mode !== 'contours' && mode !== 'filled') bad("mode must be 'contours' or 'filled'");

        var active = new Uint8Array(width * height), contour = new Uint8Array(width * height);
        for (var i = 0; i < width * height; i++) active[i] = data[4 * i + 3] > 0 ? 1 : 0;
        var contourCount = 0;
        // Sobel gradients use only opaque neighbors. Transparent padding is
        // deliberately ignored instead of being treated as black background.
        for (var y = 0; y < height; y++) for (var x = 0; x < width; x++) {
            var pixel = y * width + x;
            if (!active[pixel]) continue;
            var gx = 0, gy = 0, hasTransparentNeighbour = false;
            for (var ky = -1; ky <= 1; ky++) for (var kx = -1; kx <= 1; kx++) {
                if (!kx && !ky) continue;
                // Replicate the nearest source pixel at the image boundary;
                // this keeps a uniform opaque border from becoming an edge.
                var xx = Math.max(0, Math.min(width - 1, x + kx));
                var yy = Math.max(0, Math.min(height - 1, y + ky));
                var neighbour = yy * width + xx;
                if (!active[neighbour]) { hasTransparentNeighbour = true; continue; }
                var weightX = ky === 0 ? (kx * 2) : kx;
                var weightY = kx === 0 ? (ky * 2) : ky;
                var value = luminance(data, 4 * neighbour);
                gx += value * weightX;
                gy += value * weightY;
            }
            // A partially transparent stencil has no reliable local Sobel
            // neighborhood. Skip it instead of treating alpha edges as image
            // contrast or allowing unbalanced kernel weights.
            if (!hasTransparentNeighbour && Math.hypot(gx, gy) >= threshold) { contour[pixel] = 1; contourCount++; }
        }

        var mask = contour;
        var filledCount = 0;
        if (mode === 'filled' && contourCount) {
            var reachable = new Uint8Array(width * height), queue = new Int32Array(width * height), head = 0, tail = 0;
            function enqueue(index) {
                // Flood through transparent padding as ordinary exterior. Only
                // active, unreachable pixels are candidates for an interior fill.
                if (contour[index] || reachable[index]) return;
                reachable[index] = 1; queue[tail++] = index;
            }
            for (var bx = 0; bx < width; bx++) { enqueue(bx); enqueue((height - 1) * width + bx); }
            for (var by = 0; by < height; by++) { enqueue(by * width); enqueue(by * width + width - 1); }
            while (head < tail) {
                var current = queue[head++], cx = current % width, cy = (current - cx) / width;
                if (cx) enqueue(current - 1); if (cx + 1 < width) enqueue(current + 1);
                if (cy) enqueue(current - width); if (cy + 1 < height) enqueue(current + width);
            }
            // Classify contour components so an open component only suppresses
            // the adjacent candidate region; unrelated closed objects can still
            // be filled in the same source image.
            var contourLabel = new Int32Array(width * height), componentOpen = [], cq = new Int32Array(width * height); contourLabel.fill(-1);
            for (var seed = 0, component = 0; seed < contour.length; seed++) if (contour[seed] && contourLabel[seed] < 0) {
                var ch = 0, ct = 0, touchesBoundary = false;
                cq[ct++] = seed; contourLabel[seed] = component;
                while (ch < ct) {
                    var ci = cq[ch++], qx = ci % width, qy = (ci - qx) / width;
                    if (!qx || !qy || qx === width - 1 || qy === height - 1) touchesBoundary = true;
                    for (var cdy = -1; cdy <= 1; cdy++) for (var cdx = -1; cdx <= 1; cdx++) {
                        var nx = qx + cdx, ny = qy + cdy; if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
                        var ni = ny * width + nx;
                        if (contour[ni] && contourLabel[ni] < 0) { contourLabel[ni] = component; cq[ct++] = ni; }
                    }
                }
                componentOpen.push(touchesBoundary); component++;
            }
            mask = new Uint8Array(contour);
            var candidateSeen = new Uint8Array(width * height), fq = new Int32Array(width * height);
            for (var fill = 0; fill < mask.length; fill++) if (active[fill] && !reachable[fill] && !candidateSeen[fill]) {
                var fh = 0, ft = 0, enclosed = true;
                fq[ft++] = fill; candidateSeen[fill] = 1;
                while (fh < ft) {
                    var fi = fq[fh++], fx = fi % width, fy = (fi - fx) / width;
                    for (var fdy = -1; fdy <= 1; fdy++) for (var fdx = -1; fdx <= 1; fdx++) {
                        if (Math.abs(fdx) + Math.abs(fdy) !== 1) continue;
                        var ax = fx + fdx, ay = fy + fdy; if (ax < 0 || ay < 0 || ax >= width || ay >= height) { enclosed = false; continue; }
                        var ai = ay * width + ax;
                        if (contour[ai]) { if (componentOpen[contourLabel[ai]]) enclosed = false; continue; }
                        if (active[ai] && !reachable[ai] && !candidateSeen[ai]) { candidateSeen[ai] = 1; fq[ft++] = ai; }
                    }
                }
                if (enclosed) for (var fi2 = 0; fi2 < ft; fi2++) { mask[fq[fi2]] = 1; filledCount++; }
            }
        }
        var occupiedCount = 0;
        for (var m = 0; m < mask.length; m++) occupiedCount += mask[m];
        return {
            width: width, height: height, mask: mask,
            mode: mode, threshold: threshold,
            counts: { active: active.reduce ? active.reduce(function (a, v) { return a + v; }, 0) : active.filter(Boolean).length,
                contours: contourCount, filled: filledCount, occupied: occupiedCount },
            warnings: contourCount ? [] : ['No contours detected; adjust threshold or image contrast.'],
            maxRuns: options.maxRuns === undefined ? 100000 : Number(options.maxRuns)
        };
    }

    function point(value) {
        if (Array.isArray(value) && value.length >= 2 && Number.isFinite(value[0]) && Number.isFinite(value[1])) return [value[0], value[1]];
        if (value && Number.isFinite(value.x) && Number.isFinite(value.y)) return [value.x, value.y];
        throw new Error('pixelToWorld must return a finite [x,y] point');
    }

    function toObstacles(result, pixelToWorld) {
        if (!result || !Number.isInteger(result.width) || !Number.isInteger(result.height) || !result.mask || result.mask.length < result.width * result.height) bad('invalid mask result');
        if (typeof pixelToWorld !== 'function') bad('pixelToWorld must be a function');
        var maxRuns = result.maxRuns === undefined ? 100000 : Number(result.maxRuns);
        if (!Number.isInteger(maxRuns) || maxRuns < 1) bad('maxRuns must be a positive integer');
        var obstacles = [], failures = [];
        for (var y = 0; y < result.height; y++) {
            var x = 0;
            while (x < result.width) {
                while (x < result.width && !result.mask[y * result.width + x]) x++;
                if (x >= result.width) break;
                var start = x;
                while (x < result.width && result.mask[y * result.width + x]) x++;
                var end = x;
                if (obstacles.length >= maxRuns) throw new RangeError('RouteImageMask: obstacle run budget exceeded');
                try {
                    var ring = [point(pixelToWorld(start, y)), point(pixelToWorld(end, y)), point(pixelToWorld(end, y + 1)), point(pixelToWorld(start, y + 1))];
                    ring.push(ring[0].slice());
                    obstacles.push({ rings: [ring], pixelRun: { x: start, y: y, width: end - start, height: 1 } });
                } catch (error) {
                    var failure = { rings: [], pixelRun: { x: start, y: y, width: end - start, height: 1 }, error: String(error && error.message || error) };
                    obstacles.push(failure); failures.push(failure);
                }
            }
        }
        // Keep the primary API as the requested obstacle array, while exposing
        // a machine-readable failure list for callers that need to surface it.
        obstacles.failures = failures;
        return obstacles;
    }

    return { fromPixels: fromPixels, toObstacles: toObstacles };
}));
