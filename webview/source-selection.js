(function (root, factory) {
    var api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.SourceSelection = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';
    function slash(value) { return (value || '').replace(/\\/g, '/'); }
    function parsedLine(value) { return typeof value === 'number' ? value : parseInt(String(value), 10); }
    function featureProvenance(feature) { return feature && typeof feature.get === 'function' ? (feature.get('provenance') || {}) : {}; }
    function create(features) {
        var list = Array.isArray(features) ? features.slice() : [];
        var directIndex = null, chainIndex = null, lineIndex = null, provenanceRefs = new Map();
        var counts = { sourceBuilds: 0, lineBuilds: 0, sourceQueries: 0, lineQueries: 0, buildInspections: 0, chainRefs: 0, warmInspections: 0 };
        function bucket(index, file, line, make) {
            var lines = index.get(file);
            if (!lines) { if (!make) return null; lines = new Map(); index.set(file, lines); }
            var out = lines.get(line);
            if (!out && make) { out = []; lines.set(line, out); }
            return out;
        }
        function buildSource() {
            if (directIndex) return;
            directIndex = new Map(); chainIndex = new Map(); counts.sourceBuilds++;
            for (var i = 0; i < list.length; i++) {
                var feature = list[i], p = featureProvenance(feature), line = parsedLine(p.line);
                provenanceRefs.set(feature, feature.get('provenance')); counts.buildInspections++;
                if (!Number.isNaN(line)) bucket(directIndex, slash(p.resolved_file || p.file || '').toLowerCase(), line, true).push(feature);
                var chain = p.call_chain || [];
                for (var j = 0; j < chain.length; j++) {
                    var cc = chain[j] || {}, ccLine = parsedLine(cc.line);
                    if (Number.isNaN(ccLine)) continue;
                    bucket(chainIndex, slash(cc.resolved_file || cc.file || '').toLowerCase(), ccLine, true).push(feature); counts.chainRefs++;
                }
            }
        }
        function buildLine() {
            if (lineIndex) return;
            lineIndex = new Map(); counts.lineBuilds++;
            for (var i = 0; i < list.length; i++) {
                var feature = list[i], p = featureProvenance(feature), file = slash(p.file || '');
                provenanceRefs.set(feature, feature.get('provenance'));counts.buildInspections++;
                if (typeof p.line === 'number' && p.line !== p.line) continue;
                var lines = lineIndex.get(file); if (!lines) { lines = new Map(); lineIndex.set(file, lines); }
                var out = lines.get(p.line); if (!out) { out = []; lines.set(p.line, out); }
                out.push(feature);
            }
        }
        function bySource(file, line) {
            counts.sourceQueries++;
            var targetFile = slash(file || '').toLowerCase(), targetLine = parseInt(line, 10);
            if (!targetFile || Number.isNaN(targetLine)) return [];
            buildSource();
            var direct = bucket(directIndex, targetFile, targetLine, false) || [], chain = bucket(chainIndex, targetFile, targetLine, false) || [], seen = {}, out = [];
            direct.concat(chain).forEach(function (feature) { if (!seen[feature.ol_uid]) { seen[feature.ol_uid] = true; out.push(feature); } });
            return out;
        }
        function lineGroup(provenance) {
            counts.lineQueries++;
            var p = provenance || {}, file = slash(p.file || '');
            if (!file || (typeof p.line === 'number' && p.line !== p.line)) return [];
            buildLine(); var lines = lineIndex.get(file);
            return lines ? (lines.get(p.line) || []).slice() : [];
        }
        return {
            bySource: bySource, lineGroup: lineGroup,
            matchesProvenance: function (feature) { return !provenanceRefs.has(feature) || provenanceRefs.get(feature) === feature.get('provenance'); },
            stats: function () { return Object.assign({}, counts, { sourceEntries: directIndex ? directIndex.size + chainIndex.size : 0, lineEntries: lineIndex ? lineIndex.size : 0, sourceBuilt: !!directIndex, lineBuilt: !!lineIndex }); }
        };
    }
    return { create: create };
}));
