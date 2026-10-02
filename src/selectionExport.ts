import { createHash } from 'crypto';
// Kept as a small shared runtime module so browser and exporter classify edits identically.
// eslint/tsc treat this legacy JS module as any, while esbuild bundles it for the exporter.
const ManhattanRoute: any = require('../webview/manhattan-route.js');
const LayoutPrimitives: any = require('../webview/layout-primitives.js');

/** One serializer for toolbar and command copies. Quoted scalars are YAML safe. */
export function toYaml(value: unknown, indent = 0): string {
    const pad = ' '.repeat(indent);
    if (Array.isArray(value)) {
        if (!value.length) { return '[]'; }
        return value.map(item => `${pad}- ${toYaml(item, indent + 2).trimStart()}`).join('\n');
    }
    if (value && typeof value === 'object') {
        return Object.entries(value).filter(([, v]) => v !== undefined).map(([key, val]) => {
            const nested = val && typeof val === 'object' && Object.keys(val).length > 0;
            return `${pad}${JSON.stringify(key)}:${nested ? '\n' + toYaml(val, indent + 2) : ' ' + JSON.stringify(val ?? null)}`;
        }).join('\n');
    }
    return JSON.stringify(value ?? null);
}
export function elementId(feature: any, ordinal: number): string {
    // Provenance, color and display metadata can change without changing the GDS element.
    const identity = feature?.geometry ? { geometry: feature.geometry, layer: feature.properties?.layer, data_type: feature.properties?.data_type } : feature;
    return 'element-' + createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 24) + '-' + ordinal;
}
export interface HandoffOptions {
    generatingScript?: string;
    request?: { action?: string; text?: string; targetIds?: string[]; snapshot?: string; documentPath?: string };
    catalog?: any[];
    runtime?: { executable: string; args: string[]; cwd: string; env: { GDS_PROVENANCE: '1' }; note: string };
}
type PrimitiveSpec = { version: 1; kind: 'taper' | 'straight' | 'pad'; length: number; width1: number; width2: number; layer: [number, number]; origin: [number, number]; rotationDeg: number };
function validPrimitive(value: unknown): value is PrimitiveSpec {
    return LayoutPrimitives.validate(value);
}
function primitiveRecipe(c: any): { operation: string; points: unknown; layer: unknown } | undefined {
    const ring = c?.geometry?.type === 'Polygon' && Array.isArray(c.geometry.coordinates) && Array.isArray(c.geometry.coordinates[0]) ? c.geometry.coordinates[0] : undefined;
    if (!ring) return undefined;
    return { operation: 'Component.add_polygon', points: ring.map((p: any) => Array.isArray(p) ? [p[0], p[1]] : p), layer: c.primitive.layer.slice() };
}
function primitiveInfo(c: any): any {
    if (!validPrimitive(c.primitive) || !validGeometry(c.geometry)) return undefined;
    let described;
    try { described = LayoutPrimitives.describe(c.primitive, c.geometry); } catch { return undefined; }
    const info: any = { parameter_status: described.parameter_status, construction: described.construction };
    if (described.primitive) info.primitive = described.primitive;
    if (described.parameter_status === 'modified_geometry') info.historical_primitive = c.primitive;
    return info;
}
const finitePosition = (value: unknown): value is number[] =>
    Array.isArray(value) && value.length === 2 && value.every(v => typeof v === 'number' && Number.isFinite(v));
const validGeometry = (value: any): boolean => {
    if (!value || typeof value !== 'object' || typeof value.type !== 'string') { return false; }
    if (value.type === 'Circle') {
        return finitePosition(value.center) && typeof value.radius === 'number' && Number.isFinite(value.radius) && value.radius > 0;
    }
    if (value.type === 'Point') { return finitePosition(value.coordinates); }
    if (value.type === 'LineString') {
        return Array.isArray(value.coordinates) && value.coordinates.length >= 2 && value.coordinates.every(finitePosition);
    }
    if (value.type === 'Polygon') {
        return Array.isArray(value.coordinates) && value.coordinates.length > 0 && value.coordinates.every((ring: any) =>
            Array.isArray(ring) && ring.length >= 4 && ring.every(finitePosition) &&
            JSON.stringify(ring[0]) === JSON.stringify(ring[ring.length - 1]));
    }
    return false;
};
function validLibrary(v: any): boolean {
    return !!v && v.module === 'gds_components' && typeof v.exportName === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(v.exportName) && v.exportName.length <= 152;
}
function validFactory(v: any): boolean {
    return !!v && typeof v === 'object' && typeof v.name === 'string' && typeof v.groupId === 'string' &&
        !!v.settings && typeof v.settings === 'object' && !Array.isArray(v.settings) && finitePosition(v.origin) &&
        (v.library === undefined ? !v.name.startsWith('project:') : validLibrary(v.library) && v.name === `project:${v.library.exportName}`) &&
        v.sourceGeometry?.type === 'Polygon' && validGeometry(v.sourceGeometry) && Number.isInteger(v.pieceIndex) && Number.isInteger(v.pieceCount) && v.pieceIndex >= 0 && v.pieceIndex < v.pieceCount;
}
type RigidTransform = { rotationDeg: number; translation: [number, number] };
const FACTORY_GEOMETRY_TOLERANCE = 1e-7;
function fitRigidTransform(source: any, target: any, tolerance = FACTORY_GEOMETRY_TOLERANCE): RigidTransform | undefined {
    if (source?.type !== 'Polygon' || target?.type !== 'Polygon') return undefined;
    const sourceRing = source.coordinates?.[0], targetRing = target.coordinates?.[0];
    if (!Array.isArray(sourceRing) || !Array.isArray(targetRing) || sourceRing.length !== targetRing.length || sourceRing.length < 4) return undefined;
    const distance = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    const sx = sourceRing[1][0] - sourceRing[0][0], sy = sourceRing[1][1] - sourceRing[0][1];
    const tx = targetRing[1][0] - targetRing[0][0], ty = targetRing[1][1] - targetRing[0][1];
    const sourceLength = Math.hypot(sx, sy), targetLength = Math.hypot(tx, ty);
    if (!Number.isFinite(sourceLength) || sourceLength === 0 || Math.abs(sourceLength - targetLength) > tolerance) return undefined;
    const rotation = Math.atan2(ty, tx) - Math.atan2(sy, sx), cos = Math.cos(rotation), sin = Math.sin(rotation);
    const translation: [number, number] = [targetRing[0][0] - (cos * sourceRing[0][0] - sin * sourceRing[0][1]), targetRing[0][1] - (sin * sourceRing[0][0] + cos * sourceRing[0][1])];
    const matches = sourceRing.every((point: number[], i: number) => {
        const x = cos * point[0] - sin * point[1] + translation[0], y = sin * point[0] + cos * point[1] + translation[1];
        return distance([x, y], targetRing[i]) <= tolerance;
    });
    return matches ? { rotationDeg: rotation * 180 / Math.PI, translation } : undefined;
}
function rigidGeometryMatches(source: any, target: any, transform: RigidTransform, tolerance = FACTORY_GEOMETRY_TOLERANCE): boolean {
    if (source?.type !== 'Polygon' || target?.type !== 'Polygon' || source.coordinates?.length !== target.coordinates?.length) return false;
    const cos = Math.cos(transform.rotationDeg * Math.PI / 180), sin = Math.sin(transform.rotationDeg * Math.PI / 180);
    return source.coordinates.every((sourceRing: number[][], ringIndex: number) => {
        const targetRing = target.coordinates[ringIndex];
        return Array.isArray(sourceRing) && Array.isArray(targetRing) && sourceRing.length === targetRing.length && sourceRing.every((point, i) => {
            const x = cos * point[0] - sin * point[1] + transform.translation[0], y = sin * point[0] + cos * point[1] + transform.translation[1];
            return Math.hypot(x - targetRing[i][0], y - targetRing[i][1]) <= tolerance;
        });
    });
}
function safeSettingsJson(settings: any): string | undefined {
    try {
        const encoded = JSON.stringify(settings);
        return encoded === undefined ? undefined : encoded;
    } catch { return undefined; }
}
function factoryGroupInfo(group: any[]): any | undefined {
    const valid = group.filter(c => validFactory(c.factory));
    if (!valid.length) return undefined;
    const first = valid[0].factory;
    const firstSettingsJson = safeSettingsJson(first.settings);
    const sourceLayerMatches = valid.every(c => !c.factory.sourceLayer || String(c.layer) === String(c.factory.sourceLayer));
    const geometryValid = valid.every(c => validGeometry(c.geometry));
    const complete = valid.length === first.pieceCount && new Set(valid.map(c => c.factory.pieceIndex)).size === first.pieceCount && sourceLayerMatches && geometryValid && valid.every(c => c.factory.groupId === first.groupId && c.factory.name === first.name && safeSettingsJson(c.factory.library) === safeSettingsJson(first.library) && safeSettingsJson(c.factory.settings) === firstSettingsJson);
    const byIndex = new Map(valid.map(c => [c.factory.pieceIndex, c]));
    const transform = complete ? fitRigidTransform(byIndex.get(0)?.factory.sourceGeometry, byIndex.get(0)?.geometry) : undefined;
    const rigid = !!transform && [...byIndex.values()].every(c => rigidGeometryMatches(c.factory.sourceGeometry, c.geometry, transform));
    const settingsJson = firstSettingsJson;
    const ports = valid.find(c => Array.isArray(c.factory.ports))?.factory.ports;
    const base: any = { name: first.name, settings: first.settings, group_id: first.groupId, piece_count: first.pieceCount, ...(first.library ? { library: first.library, source_file: 'gds_components.py', execution_context: 'Run with the project root on the Python import path.' } : {}), ...(ports ? { ports, ports_frame: 'component_local' } : {}) };
    if (rigid && transform && settingsJson !== undefined) {
        const name = JSON.stringify(first.name), settings = JSON.stringify(settingsJson);
        base.status = 'rigid_factory_reference';
        base.transform = { rotation_deg: transform.rotationDeg, translation: transform.translation };
        const lookup = first.library ? `COMPONENTS[${JSON.stringify(first.library.exportName)}]` : name;
        base.code = [`import json`, `import gdsfactory as gf`, ...(first.library ? ['from gds_components import COMPONENTS'] : []), `component = gf.get_component(${lookup}, settings=json.loads(${settings}))`, `ref = parent.add_ref(component)`, `ref.drotate(${JSON.stringify(transform.rotationDeg)})`, `ref.dmove((${JSON.stringify(transform.translation[0])}, ${JSON.stringify(transform.translation[1])}))`].join('\n');
        base.geometry_authority = 'factory_reference_matches_current_geometry';
    } else {
        base.status = 'geometry_authoritative';
        base.geometry_authority = 'exact_current_polygons';
        base.reason = !geometryValid ? 'invalid_current_geometry' : !sourceLayerMatches ? 'source_layer_mismatch' : !complete ? 'incomplete_or_inconsistent_factory_group' : settingsJson === undefined ? 'settings_are_not_json_serializable' : 'current_geometry_is_scaled_or_deformed';
    }
    return base;
}
function factoryInfo(c: any, groupInfo?: any): any {
    if (!validFactory(c.factory)) return {};
    const factory = c.factory;
    const translated = JSON.parse(JSON.stringify(factory.sourceGeometry));
    translated.coordinates = translated.coordinates.map((ring: number[][]) => ring.map(p => [p[0] + factory.origin[0], p[1] + factory.origin[1]]));
    return { factory_proposal: { name: factory.name, settings: factory.settings, library: factory.library, group_id: factory.groupId, piece_index: factory.pieceIndex, piece_count: factory.pieceCount,
        origin: factory.origin, parameter_status: JSON.stringify(translated) === JSON.stringify(c.geometry) ? 'original_factory_geometry' : 'modified_geometry',
        ...(groupInfo ? { group_construction: { group_id: groupInfo.group_id, status: groupInfo.status, geometry_authority: groupInfo.geometry_authority } } : {}),
        interpretation: 'One factory instance for this entire group, not one per polygon. Exact current geometry and target layer are authoritative. Reconcile edits before using the original factory settings.' } };
}
export function validateIntent(value: unknown): value is { action?: string; text?: string; targetIds?: string[]; snapshot?: string; documentPath?: string } {
    if (!value || typeof value !== 'object' || Array.isArray(value)) { return false; }
    const v = value as any;
    return (v.action === undefined || (typeof v.action === 'string' && v.action.length > 0)) &&
        (v.text === undefined || typeof v.text === 'string') &&
        (v.targetIds === undefined || (Array.isArray(v.targetIds) && v.targetIds.every((id: unknown) => typeof id === 'string' || typeof id === 'number'))) &&
        (v.snapshot === undefined || typeof v.snapshot === 'string') &&
        (v.documentPath === undefined || typeof v.documentPath === 'string');
}
export function selectionDocument(gdsPath: string, hash: string | undefined, components: any[], topCell?: string, options: HandoffOptions = {}) {
    const samePath = (a: string, b: string) => a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase();
    const issues: Array<{ code: string; subject: string; message: string }> = [];
    const addIssue = (code: string, subject: string, message: string) => issues.push({ code, subject, message });
    const selected = components.filter(c => !c.drawn);
    const catalog = new Map((options.catalog || selected).map(c => [String(c.provId), c]));
    const referenced = new Map<string, any>();
    const selectedIds = new Set(selected.map(c => String(c.provId)));
    const actions = new Map<string, Set<string>>();
    const element = (c: any) => ({ id: c.provId, layer: c.layer, bbox: c.bbox, geometry: c.geometry,
        ...(c.port ? { port: c.port } : {}),
        ...(primitiveInfo(c) || {}),
        provenance_status: c.provenance?.source_resolution || (c.provenance?.file ? 'source_reference_unverified' : 'unavailable'), provenance: c.provenance || {} });
    const bind = (subject: string, action: string, ids: string[], snapshot?: string, documentPath?: string) => {
        if ((snapshot && snapshot !== hash) || (documentPath && !samePath(documentPath, gdsPath))) {
            addIssue('stale_target', subject, 'Targets belong to another document or snapshot. Re-select them before editing.');
            return 'stale_review_required';
        }
        if (['move', 'resize', 'delete'].includes(action) && !ids.length) {
            addIssue('missing_target', subject, 'Select the exact GDS instance(s) this edit should affect.');
        }
        let unresolved = false;
        for (const id of ids) {
            const target = catalog.get(id);
            if (!target) { unresolved = true; addIssue('unresolved_target', subject, 'Target ' + id + ' is absent from the current layout.'); continue; }
            if (!selectedIds.has(id)) { referenced.set(id, target); }
            if (['move', 'resize', 'delete', 'add'].includes(action)) {
                const seen = actions.get(id) || new Set<string>(); seen.add(action); actions.set(id, seen);
            }
        }
        return unresolved ? 'unresolved' : 'current_snapshot';
    };
    const factoryGroups = new Map<string, any[]>();
    components.filter(c => c.drawn && validFactory(c.factory)).forEach(c => {
        const id = c.factory.groupId, group = factoryGroups.get(id) || [];
        group.push(c); factoryGroups.set(id, group);
    });
    const factoryGroupInfoById = new Map<string, any>();
    for (const [id, group] of factoryGroups) { const info = factoryGroupInfo(group); if (info) factoryGroupInfoById.set(id, info); }
    const annotations = components.filter(c => c.drawn).map(c => {
        const geometryValid = validGeometry(c.geometry);
        const intentValid = c.intent === undefined || validateIntent(c.intent);
        const routeValid = c.route === undefined || (ManhattanRoute.validateSpec(c.route) && c.geometry?.type === 'LineString' && ManhattanRoute.validate(c.geometry.coordinates,c.route.style));
        if(!routeValid)addIssue('invalid_route',String(c.provId),'Route must have finite centerline segments matching its angle style, positive trace width, and a numeric layer pair.');
        const primitiveValid = c.primitive === undefined || (LayoutPrimitives.validate(c.primitive) && validPrimitive(c.primitive));
        if (!geometryValid) { addIssue('invalid_geometry', String(c.provId), 'Drawing geometry is malformed or contains non-finite coordinates.'); }
        if (!intentValid) { addIssue('invalid_intent', String(c.provId), 'Drawing intent must contain string text/action, an array of target IDs, and string snapshot/document paths.'); }
        if (!primitiveValid) { addIssue('invalid_primitive', String(c.provId), 'Primitive metadata is malformed; clarify the intended construction parameters.'); }
        const ids = [...new Set<string>((Array.isArray(c.intent?.targetIds) ? c.intent.targetIds : []).map(String))];
        const action = c.intent?.action || 'mark_region';
        const info = primitiveValid && geometryValid ? primitiveInfo(c) : undefined;
        const recipe = info ? primitiveRecipe(c) : undefined;
        const primitiveGeometryValid = c.primitive === undefined || !!info;
        if (primitiveValid && geometryValid && !primitiveGeometryValid) addIssue('unsupported_primitive_geometry', String(c.provId), 'The component geometry cannot be described as one finite polygon ring. Exact geometry is retained; review before construction.');
        return { id: c.provId, geometry: c.geometry, measurements: c.shape, ...factoryInfo(c, validFactory(c.factory) ? factoryGroupInfoById.get(c.factory.groupId) : undefined),
            ...(c.route === undefined ? {} : { route: c.route, route_convention: { geometry: c.route.style === 'octilinear' ? 'H/V/45 centerline' : 'Manhattan centerline', units: 'um', width: 'full trace width', corners: 'centerline bends with round stroke joins for clearance; no photonic bend radius or port attachment inferred', validation: 'angle constraints only on export; automatic clearance check is against the detected obstacles at planning time, not a fabrication or connectivity check' } }),
            ...((c.layer === undefined && c.primitive?.layer === undefined) ? {} : { target_layer: c.route?.layer ?? c.primitive?.layer ?? c.layer }),
            ...(info?.primitive === undefined ? {} : { primitive: info.primitive }),
            ...(info?.historical_primitive === undefined ? {} : { historical_primitive: info.historical_primitive }),
            ...(info ? { parameter_status: info.parameter_status } : {}),
            ...(info ? { parameter_convention: { origin: 'input-edge midpoint', length_axis: 'local +x', width1_at: 'local x=0', width2_at: 'local x=length', rotation: 'counterclockwise degrees about origin', units: 'um' } } : {}),
            ...(c.meta === undefined && c.metadata === undefined && c.componentMetadata === undefined && c.component_metadata === undefined && c.provenance === undefined ? {} : { component_metadata: c.componentMetadata || c.component_metadata || c.metadata || c.meta || c.provenance }),
            ...(recipe ? { construction_recipe: recipe } : {}),
            action, instruction: c.intent?.text || '', target_ids: ids,
            target_snapshot: c.intent?.snapshot || hash, target_document: c.intent?.documentPath || gdsPath,
            target_status: !geometryValid ? 'invalid_geometry' : !routeValid ? 'invalid_route' : !intentValid ? 'invalid_intent' : (!primitiveValid || !primitiveGeometryValid) ? 'needs_clarification' : bind(String(c.provId), action, ids, c.intent?.snapshot, c.intent?.documentPath) };
    });
    const r = options.request;
    const requestValid = r === undefined || validateIntent(r);
    if (r && !requestValid) { addIssue('invalid_intent', 'request', 'Request intent must contain string text/action, an array of target IDs, and string snapshot/document paths.'); }
    const requestIds = r && Array.isArray(r.targetIds) ? r.targetIds : [];
    const request = r ? { action: r.action || 'inspect', text: r.text || '', target_ids: [...new Set(requestIds.map(String))],
        snapshot: r.snapshot || hash, document: r.documentPath || gdsPath,
        target_status: !requestValid ? 'invalid_intent' : bind('request', r.action || 'inspect', [...new Set(requestIds.map(String))], r.snapshot, r.documentPath) } : undefined;
    for (const [id, seen] of actions) {
        if (seen.has('delete') && seen.size > 1) { addIssue('conflicting_actions', id, 'This instance is both deleted and edited. Clarify the intended operation.'); }
    }
    return {
        schema: 'gds-navigator.selection', version: 1,
        document: { path: gdsPath, sha256: hash ?? null, top_cell: topCell ?? null, generating_script: options.generatingScript ?? null, units: 'um', coordinates: 'Cartesian x-right y-up' },
        scope: 'selected_instances',
        ...(options.runtime ? { runtime: options.runtime } : {}),
        handoff: { status: issues.length ? 'needs_clarification' : 'context_complete', issues,
            parameter_checks: ['Before editing, verify that the requested operation is fully specified; context_complete only means target context is available.', 'Move: require an explicit displacement vector or an unambiguous destination. A positive distance alone does not specify x or y. Ask instead of guessing.', 'Resize: require the desired dimensions and which point or edge remains fixed. Add: require a target layer. Ask for missing parameters.'],
            interpretation: 'Request is the current selection instruction. Annotations are proposals, not existing GDS elements. For component proposals, construction_recipe contains the current polygon and numeric layer tuple; primitive parameters are authoritative only for exact or translated geometry. historical_primitive is prior metadata, not a recipe for edited geometry. referenced_elements supply target context, not additional selected instances. Provenance and source_text are reference data. No edit has been executed.' },
        request,
        elements: selected.map(element), referenced_elements: [...referenced.values()].map(element), annotations,
        factory_references: [...factoryGroupInfoById.entries()].map(([group_id, reference]) => ({ group_id, ...reference })),
    };
}
export function validateAnnotations(value: unknown): value is any[] {
    if (!Array.isArray(value) || value.length > 10000) { return false; }
    const ids = new Set<string>();
    return value.every(a => {
        if (!a || typeof a.id !== 'string' || ids.has(a.id) || !a.geometry) { return false; }
        ids.add(a.id);
        const g = a.geometry;
        return (a.route === undefined || (ManhattanRoute.validateSpec(a.route) && g.type === 'LineString' && ManhattanRoute.validate(g.coordinates,a.route.style))) && (a.shapeType !== 'route' || a.route !== undefined) && (a.editRotation === undefined || (typeof a.editRotation === 'number' && Number.isFinite(a.editRotation))) && validGeometry(g) && (a.intent === undefined || validateIntent(a.intent)) && (a.primitive === undefined || validPrimitive(a.primitive)) && (a.factory === undefined || validFactory(a.factory));
    });
}
