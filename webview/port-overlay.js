(function (root) {
    'use strict';
    const finitePoint = p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite);
    const finitePort = p => p && typeof p.name === 'string' && finitePoint(p.center) &&
        Number.isFinite(p.width) && p.width > 0 && Number.isFinite(p.orientation);
    const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    const rotate = (p, angle, translation) => [
        Math.cos(angle) * p[0] - Math.sin(angle) * p[1] + translation[0],
        Math.sin(angle) * p[0] + Math.cos(angle) * p[1] + translation[1]
    ];
    function rigidPose(source, target) {
        if (source?.type !== 'Polygon' || target?.type !== 'Polygon' || source.coordinates.length !== target.coordinates.length) return null;
        const before = source.coordinates[0], after = target.coordinates[0];
        if (!Array.isArray(before) || !Array.isArray(after) || before.length !== after.length) return null;
        let second = 1;
        while (second < before.length && distance(before[0], before[second]) < 1e-9) second++;
        if (second === before.length || distance(before[0], before[second]) < 1e-9) return null;
        const a = Math.atan2(before[second][1] - before[0][1], before[second][0] - before[0][0]);
        const b = Math.atan2(after[second][1] - after[0][1], after[second][0] - after[0][0]);
        const angle = b - a;
        const translation = [after[0][0] - Math.cos(angle) * before[0][0] + Math.sin(angle) * before[0][1],
            after[0][1] - Math.sin(angle) * before[0][0] - Math.cos(angle) * before[0][1]];
        const pose = { angle, translation };
        return geometryMatches(source, target, pose) ? pose : null;
    }
    function geometryMatches(source, target, pose) {
        if (source?.type !== 'Polygon' || target?.type !== 'Polygon' || source.coordinates.length !== target.coordinates.length) return false;
        return source.coordinates.every((ring, i) => Array.isArray(target.coordinates[i]) && ring.length === target.coordinates[i].length &&
            ring.every((point, j) => finitePoint(point) && finitePoint(target.coordinates[i][j]) &&
                distance(rotate(point, pose.angle, pose.translation), target.coordinates[i][j]) <= 1e-7));
    }
    function layoutPorts(geojson) {
        return (Array.isArray(geojson?.ports) ? geojson.ports : []).filter(p => p.coordinate_frame === 'layout' && typeof p.id === 'string' && finitePort(p))
            .map(p => ({ ...p, source: 'gds', center: p.center.slice() }));
    }
    function factoryPortGroup(groupId, group) {
            const byIndex = new Map(group.map(feature => [feature.get('factory').pieceIndex, feature]));
            const first = byIndex.get(0), factory = first?.get('factory');
            if (!factory || byIndex.size !== factory.pieceCount || group.length !== factory.pieceCount) return [];
            const pose = rigidPose(factory.sourceGeometry, { type: 'Polygon', coordinates: first.getGeometry().getCoordinates() });
            if (!pose || !group.every(feature => geometryMatches(feature.get('factory').sourceGeometry,
                { type: 'Polygon', coordinates: feature.getGeometry().getCoordinates() }, pose))) return [];
            const ports = [];
            (Array.isArray(factory.ports) ? factory.ports : []).forEach((port, index) => {
                if (!finitePort(port)) return;
                ports.push({ id: `factory:${groupId}:${index}`, name: port.name, center: rotate(port.center, pose.angle, pose.translation),
                    source_center: port.center.slice(), width: port.width, orientation: ((port.orientation + pose.angle * 180 / Math.PI) % 360 + 360) % 360,
                    layer: port.layer, coordinate_frame: 'layout', source: 'factory', factory_name: factory.name, group_id: groupId });
            });
            return ports;
    }
    function factoryPorts(features) {
        const groups = new Map();
        for (const feature of features) {
            const factory = feature.get('factory');
            if (!factory?.groupId) continue;
            const group = groups.get(factory.groupId) || [];
            group.push(feature);
            groups.set(factory.groupId, group);
        }
        const ports = [];
        for (const [groupId, group] of groups) ports.push(...factoryPortGroup(groupId, group));
        return ports;
    }
    function factoryPortProjector() {
        const groups = new Map(), featureGroups = new Map(), cache = new Map(), dirty = new Set();
        let recomputations = 0;
        function groupIdOf(feature) {
            return feature?.get('factory')?.groupId || null;
        }
        function removeFromGroup(feature, groupId) {
            if (!groupId) return;
            const group = groups.get(groupId), index = group?.indexOf(feature) ?? -1;
            if (index >= 0) group.splice(index, 1);
            if (!group || !group.length) { groups.delete(groupId); cache.delete(groupId); }
            dirty.add(groupId);
        }
        function addToGroup(feature, groupId) {
            if (!groupId) return;
            const group = groups.get(groupId) || [];
            group.push(feature);
            groups.set(groupId, group); dirty.add(groupId);
        }
        function add(feature) {
            const next = groupIdOf(feature), known = featureGroups.has(feature), previous = featureGroups.get(feature);
            if (!known) { featureGroups.set(feature, next); if (next) addToGroup(feature, next); return !!next; }
            if (previous !== next) {
                if (previous) removeFromGroup(feature, previous);
                if (next) addToGroup(feature, next);
                featureGroups.set(feature, next);
                return true;
            }
            return !!next;
        }
        function remove(feature) {
            if (!featureGroups.has(feature)) return false;
            const previous = featureGroups.get(feature);
            if (previous) removeFromGroup(feature, previous);
            featureGroups.delete(feature);
            return !!previous;
        }
        function change(feature) {
            const known = featureGroups.has(feature), previous = featureGroups.get(feature), next = groupIdOf(feature);
            if (!known) return add(feature);
            if (previous !== next) {
                if (previous) removeFromGroup(feature, previous);
                if (next) addToGroup(feature, next);
                featureGroups.set(feature, next);
            } else if (next) dirty.add(next);
            return !!(previous || next);
        }
        function reset(features) {
            groups.clear(); cache.clear(); dirty.clear(); featureGroups.clear();
            for (const feature of features || []) add(feature);
        }
        function ports() {
            for (const groupId of dirty) {
                const group = groups.get(groupId);
                if (group?.length) { cache.set(groupId, factoryPortGroup(groupId, group)); recomputations++; }
                else cache.delete(groupId);
            }
            dirty.clear();
            const result = [], emitted = new Set();
            for (const [feature, groupId] of featureGroups) {
                if (!groupId || emitted.has(groupId) || !groups.has(groupId)) continue;
                emitted.add(groupId); result.push(...(cache.get(groupId) || []));
            }
            for (const groupId of groups.keys()) if (!emitted.has(groupId)) result.push(...(cache.get(groupId) || []));
            return result;
        }
        function stats() { return { recomputations, groups: groups.size, dirty: dirty.size }; }
        return { add, remove, change, reset, ports, stats };
    }
    root.PortOverlay = { layoutPorts, factoryPorts, factoryPortProjector, rigidPose };
})(typeof window !== 'undefined' ? window : globalThis);
