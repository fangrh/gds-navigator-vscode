export interface WorkOrderMatch { oldId: string; newId: string; kind: 'direct' | 'geometry' | 'provenance' | 'annotation'; }
export interface WorkOrderTrackingResult {
    layoutHash: string | undefined;
    status: 'current' | 'relinked' | 'needs_review';
    targetIds: string[];
    issues: string[];
    matches: WorkOrderMatch[];
}

type AnyRecord = Record<string, any>;

function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)); }
function canonical(value: any): string {
    if (value === undefined) return 'undefined';
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
}
function idOf(value: AnyRecord): string | undefined {
    const id = value?.provId ?? value?.elementId ?? value?.id ?? value?.annotationId;
    return id === undefined || id === null ? undefined : String(id);
}
function layerKey(value: any): string {
    if (Array.isArray(value)) return value.map(String).join('/');
    if (typeof value === 'string') return value.replace(/\s+/g, '');
    return canonical(value);
}
function geometryLayerKey(value: AnyRecord): string | undefined {
    if (!value?.geometry || value.layer === undefined && value.target_layer === undefined) return undefined;
    return canonical(value.geometry) + '|' + layerKey(value.layer ?? value.target_layer);
}
function provenance(value: AnyRecord): AnyRecord | undefined {
    const p = value?.provenance;
    return p && typeof p === 'object' && !Array.isArray(p) ? p : undefined;
}
function strongProvenanceKey(value: AnyRecord): string | undefined {
    const p = provenance(value);
    if (!p || typeof p.file !== 'string' || typeof p.instance_name !== 'string') return undefined;
    // Line numbers alone are deliberately excluded. These fields distinguish repeated instances.
    const discriminator: AnyRecord = {};
    for (const key of ['array_index', 'loop_index', 'hierarchy', 'callchain', 'call_chain']) {
        if (p[key] !== undefined) discriminator[key] = p[key];
    }
    return canonical({ file: p.file.replace(/\\/g, '/').toLowerCase(), instance_name: p.instance_name, discriminator });
}
function requestedIds(record: AnyRecord): string[] {
    const ids: string[] = [];
    const add = (value: any) => { if (Array.isArray(value)) value.forEach(v => v !== undefined && v !== null && ids.push(String(v))); };
    add(record?.request?.targetIds); add(record?.request?.target_ids);
    add(record?.context?.request?.targetIds); add(record?.context?.request?.target_ids);
    for (const component of Array.isArray(record?.components) ? record.components : []) {
        const id = idOf(component); if (id !== undefined) ids.push(id);
    }
    for (const annotation of Array.isArray(record?.context?.annotations) ? record.context.annotations : []) {
        const id = idOf(annotation); if (id !== undefined) ids.push(id);
    }
    return [...new Set(ids)];
}
/** Reconcile a frozen work-order target set against one host-provided current catalog. */
export function trackWorkOrder(record: AnyRecord, currentHash: string | undefined, catalog: any[] = [], annotations: any[] = []): WorkOrderTrackingResult {
    const targetIds = requestedIds(record);
    const snapshot = record?.gdsHash ?? record?.context?.document?.sha256;
    const result: WorkOrderTrackingResult = { layoutHash: currentHash, status: 'current', targetIds: [], issues: [], matches: [] };
    if (typeof snapshot !== 'string' || !snapshot) {
        result.status = 'needs_review'; result.issues.push('Work order has no layout snapshot hash.'); return result;
    }
    if (typeof currentHash !== 'string' || !currentHash) {
        result.status = 'needs_review'; result.issues.push('Current layout has no snapshot hash.'); return result;
    }
    const current = Array.isArray(catalog) ? catalog : [];
    const currentById = new Map(current.map(item => [idOf(item), item]).filter(([id]) => !!id) as [string, AnyRecord][]);
    let currentByProvenance: Map<string, AnyRecord[]> | undefined;
    let currentByGeometry: Map<string, AnyRecord[]> | undefined;
    const provenanceIndex = (): Map<string, AnyRecord[]> => {
        if (currentByProvenance) return currentByProvenance;
        currentByProvenance = new Map<string, AnyRecord[]>();
        for (const item of current) {
            const itemProv = strongProvenanceKey(item);
            if (itemProv) { const values = currentByProvenance.get(itemProv) || []; values.push(item); currentByProvenance.set(itemProv, values); }
        }
        return currentByProvenance;
    };
    const geometryIndex = (): Map<string, AnyRecord[]> => {
        if (currentByGeometry) return currentByGeometry;
        currentByGeometry = new Map<string, AnyRecord[]>();
        for (const item of current) {
            const itemGeometry = geometryLayerKey(item);
            if (itemGeometry) { const values = currentByGeometry.get(itemGeometry) || []; values.push(item); currentByGeometry.set(itemGeometry, values); }
        }
        return currentByGeometry;
    };
    const annotationById = new Map((Array.isArray(annotations) ? annotations : []).map(item => [idOf(item), item]).filter(([id]) => !!id) as [string, AnyRecord][]);
    const sameHash = snapshot === currentHash;
    const frozenById = new Map<string, AnyRecord>();
    const drawnIds = new Set<string>();
    const frozenGroups = [record?.components, record?.context?.elements, record?.context?.referenced_elements, record?.context?.annotations];
    frozenGroups.forEach((group, groupIndex) => {
        for (const item of Array.isArray(group) ? group : []) {
            const id = idOf(item);
            if (id === undefined) continue;
            // Preserve the original first-match precedence across frozen groups.
            if (!frozenById.has(id)) frozenById.set(id, item);
            if ((groupIndex === 0 && item?.drawn) || groupIndex === 3) drawnIds.add(id);
        }
    });
    const assigned = new Set<string>();
    const accept = (oldId: string, newId: string, kind: WorkOrderMatch['kind']): boolean => {
        if (assigned.has(newId)) { result.issues.push(`Multiple old targets map to ${newId}; no reassignment made.`); return false; }
        assigned.add(newId); result.targetIds.push(newId); result.matches.push({ oldId, newId, kind }); return true;
    };
    for (const oldId of targetIds) {
        if (drawnIds.has(oldId)) {
            if (annotationById.has(oldId)) accept(oldId, oldId, 'annotation');
            else result.issues.push(`Missing preserved annotation target ${oldId}.`);
            continue;
        }
        if (sameHash) {
            if (currentById.has(oldId)) accept(oldId, oldId, 'direct');
            else result.issues.push(`Missing target ${oldId} in the current catalog.`);
            continue;
        }
        const old = frozenById.get(oldId);
        if (!old) { result.issues.push(`No frozen geometry or provenance is available for target ${oldId}.`); continue; }
        const oldProv = strongProvenanceKey(old);
        let candidates: AnyRecord[] = [];
        if (oldProv) {
            candidates = provenanceIndex().get(oldProv) || [];
            if (candidates.length === 1) {
                const newId = idOf(candidates[0]);
                if (newId && accept(oldId, newId, 'provenance')) continue;
            }
            if (candidates.length > 1) { result.issues.push(`Ambiguous provenance replacement for target ${oldId}; no reassignment made.`); continue; }
        }
        const exactKey = geometryLayerKey(old);
        candidates = exactKey ? geometryIndex().get(exactKey) || [] : [];
        if (candidates.length === 1) {
            const newId = idOf(candidates[0]);
            const candidateProv = strongProvenanceKey(candidates[0]);
            if (newId && (!oldProv || !candidateProv || candidateProv === oldProv)) { accept(oldId, newId, newId === oldId ? 'direct' : 'geometry'); continue; }
            if (oldProv && candidateProv && candidateProv !== oldProv) { result.issues.push(`Geometry match for target ${oldId} conflicts with its provenance; no reassignment made.`); continue; }
        }
        result.issues.push(candidates.length > 1 ? `Ambiguous replacement for target ${oldId}; no reassignment made.` : `Deleted or unmatchable target ${oldId}; no reassignment made.`);
    }
    if (result.issues.length) result.status = 'needs_review';
    else if (snapshot !== currentHash) result.status = 'relinked';
    return clone(result);
}
