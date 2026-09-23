/** Durable microscope alignment state kept in VS Code workspaceState. */

export interface AlignmentState {
    version: 1;
    imageSizePx: [number, number];
    cx: number;
    cy: number;
    umPerPx: number;
    rotDeg: number;
    opacity: number;
    visible: boolean;
    locked: boolean;
    markerTransform: number[] | null;
    markerPose: { cx: number; cy: number; umPerPx: number; rotDeg: number } | null;
    quality: {
        status: 'aligned' | 'adjusted' | 'unverified';
        boundaryRmsPx: number | null;
        markerCount: number;
    };
    options: {
        markerAppearance: 'yellow' | 'bright' | 'dark';
        markerLayers: string[];
    };
    display?: DisplayState;
}

export interface DisplayState {
    mode: 'image' | 'contours' | 'image-contours';
    threshold: number;
    color: string;
    width: number;
    border: boolean;
}

export function defaultDisplay(): DisplayState {
    return { mode: 'image', threshold: 40, color: '#00ffff', width: 1, border: false };
}

export interface StoredAlignment {
    imageId?: string;
    order?: number;
    imagePath: string;
    imageHash: string;
    gdsHash: string;
    state: AlignmentState;
}

export interface StoredAlignmentCollection {
    version: 2;
    gdsHash: string;
    images: StoredAlignment[];
}

export function validateStoredAlignment(value: unknown): value is StoredAlignment {
    if (!value || typeof value !== 'object') return false;
    const r = value as Record<string, unknown>;
    return typeof r.imagePath === 'string' && typeof r.imageHash === 'string' &&
        typeof r.gdsHash === 'string' && validateAlignmentState(r.state);
}

export function validateStoredAlignmentCollection(value: unknown): value is StoredAlignmentCollection {
    if (!value || typeof value !== 'object') return false;
    const r = value as Record<string, unknown>;
    if (r.version !== 2 || typeof r.gdsHash !== 'string' || !Array.isArray(r.images)) return false;
    return r.images.every((item: unknown) => validateStoredAlignment(item));
}

const MAX_MARKERS = 10000;
const MAX_LAYERS = 16;
const DISPLAY_MODES = ['image', 'contours', 'image-contours'];
const COLOR = /^#[0-9a-fA-F]{6}$/;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Pure, fail-closed validation for the persisted viewer state. */
export function validateAlignmentState(value: unknown): value is AlignmentState {
    if (!value || typeof value !== 'object') return false;
    const s = value as Record<string, any>;
    if (s.version !== 1 || !Array.isArray(s.imageSizePx) || s.imageSizePx.length !== 2) return false;
    if (!s.imageSizePx.every((v: unknown) => typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= 100_000_000)) return false;
    if (s.imageSizePx[0] * s.imageSizePx[1] > 16_000_000) return false;
    for (const k of ['cx', 'cy', 'umPerPx', 'rotDeg', 'opacity']) if (!finite(s[k])) return false;
    if (s.umPerPx <= 0 || s.opacity < 0 || s.opacity > 1) return false;
    if (typeof s.visible !== 'boolean' || typeof s.locked !== 'boolean') return false;
    const hasH = s.markerTransform !== null;
    const hasPose = s.markerPose !== null;
    if (hasH !== hasPose) return false;
    if (hasH) {
        if (!Array.isArray(s.markerTransform) || s.markerTransform.length !== 9 || !s.markerTransform.every(finite)) return false;
        const h = s.markerTransform as number[];
        const det = h[0] * (h[4] * h[8] - h[5] * h[7]) - h[1] * (h[3] * h[8] - h[5] * h[6]) + h[2] * (h[3] * h[7] - h[4] * h[6]);
        if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return false;
        const [w, hh] = s.imageSizePx as number[];
        for (const [x, y] of [[0, 0], [w, 0], [w, hh], [0, hh]]) {
            const d = h[6] * x + h[7] * y + h[8];
            if (!Number.isFinite(d) || d <= 1e-12) return false;
            const px = (h[0] * x + h[1] * y + h[2]) / d;
            const py = (h[3] * x + h[4] * y + h[5]) / d;
            if (!Number.isFinite(px) || !Number.isFinite(py)) return false;
        }
    }
    if (hasPose) {
        const p = s.markerPose as Record<string, unknown>;
        if (!p || !finite(p.cx) || !finite(p.cy) || !finite(p.umPerPx) || !finite(p.rotDeg) || p.umPerPx <= 0) return false;
    }
    const q = s.quality;
    if (!q || !['aligned', 'adjusted', 'unverified'].includes(q.status)) return false;
    if (!(q.boundaryRmsPx === null || (finite(q.boundaryRmsPx) && q.boundaryRmsPx >= 0 && q.boundaryRmsPx <= 2))) return false;
    if (!Number.isInteger(q.markerCount) || q.markerCount < 0 || q.markerCount > MAX_MARKERS) return false;
    if (q.status === 'aligned' && (!hasH || !hasPose || q.boundaryRmsPx === null || q.markerCount < 3)) return false;
    const o = s.options;
    if (!o || !['yellow', 'bright', 'dark'].includes(o.markerAppearance) || !Array.isArray(o.markerLayers) || o.markerLayers.length < 1 || o.markerLayers.length > MAX_LAYERS) return false;
    if (!o.markerLayers.every((x: unknown) => typeof x === 'string' && /^\d+\/\d+$/.test(x) && x !== '4/0' && x.length <= 128)) return false;
    if (s.display !== undefined) {
        const d = s.display;
        if (!d || typeof d !== 'object' || !DISPLAY_MODES.includes(d.mode) || !Number.isInteger(d.threshold) || d.threshold < 1 || d.threshold > 255 ||
            typeof d.color !== 'string' || !COLOR.test(d.color) || !Number.isInteger(d.width) || d.width < 1 || d.width > 4 || typeof d.border !== 'boolean') return false;
    }
    return true;
}

export function alignmentStoreKey(gdsPath: string): string {
    return `gdsNavigator.alignment:${gdsPath.toLowerCase()}`;
}
