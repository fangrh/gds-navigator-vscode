import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';

export interface ReviewBookmark { id: string; name: string; center: [number, number]; resolution: number; rotation: number; visibleLayers: string[]; }
export interface ReviewMeasurement { id: string; a: unknown; b: unknown; layoutHash: string; }
export interface ReviewState { version: 1; bookmarks: ReviewBookmark[]; measurements: ReviewMeasurement[]; }
export interface ReviewSnapshotResult { previousHash?: string; features?: any[]; status: 'available' | 'none' | 'unavailable'; }

const finitePair = (v: unknown): v is [number, number] => Array.isArray(v) && v.length === 2 && v.every(x => typeof x === 'number' && Number.isFinite(x) && Math.abs(x as number) <= 1e12);
const reviewValidation = require('../webview/layout-review.js') as { validateReviewState(value: unknown): boolean };
export function validateReviewState(value: unknown): value is ReviewState { return reviewValidation.validateReviewState(value); }
export const emptyReviewState = (): ReviewState => ({ version: 1, bookmarks: [], measurements: [] });

function safePathKey(gdsPath: string): string { return createHash('sha256').update(path.resolve(gdsPath).toLowerCase()).digest('hex'); }
function plainJson(value: unknown): unknown { return JSON.parse(JSON.stringify(value)); }
function validFeature(value: any): boolean {
    if (!value || value.type !== 'Feature' || !value.geometry) return false;
    const depths: Record<string, number> = { Point: 0, MultiPoint: 1, LineString: 1, MultiLineString: 2, Polygon: 2, MultiPolygon: 3 };
    const depth = depths[value.geometry.type];
    const coordinates = (v: any, d: number): boolean => d === 0 ? finitePair(v) : Array.isArray(v) && v.every(x => coordinates(x, d - 1));
    return depth !== undefined && coordinates(value.geometry.coordinates, depth);
}
function validHash(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value); }

/** Durable, per-layout snapshots. Failures are represented in the result and never thrown to the GDS loader. */
export class ReviewSnapshotStore {
    private queues = new Map<string, Promise<ReviewSnapshotResult>>();
    constructor(private readonly root: string, private readonly maxBytes = 15 * 1024 * 1024) {}
    private file(gdsPath: string): string { return path.join(this.root, safePathKey(gdsPath) + '.json'); }
    async load(gdsPath: string): Promise<{ currentHash?: string; previousHash?: string; current?: any[]; previous?: any[]; status: ReviewSnapshotResult['status'] }> {
        try {
            const file = this.file(gdsPath), stat = await fs.promises.stat(file);
            if (stat.size > this.maxBytes) return { status: 'unavailable' };
            const parsed = JSON.parse(await fs.promises.readFile(file, 'utf8'));
            const exactPath = path.resolve(gdsPath).toLowerCase(), valid = parsed && parsed.version === 1 && path.resolve(parsed.gdsPath || '').toLowerCase() === exactPath && validHash(parsed.currentHash) && Array.isArray(parsed.current) && parsed.current.every(validFeature) && (parsed.previousHash === undefined || (validHash(parsed.previousHash) && Array.isArray(parsed.previous) && parsed.previous.every(validFeature)));
            if (!valid) return { status: 'unavailable' };
            return { ...parsed, status: 'available' };
        } catch (error: any) { return { status: error?.code === 'ENOENT' ? 'none' : 'unavailable' }; }
    }
    async record(gdsPath: string, layoutHash: string, features: any[]): Promise<ReviewSnapshotResult> {
        const key = safePathKey(gdsPath);
        const next = (this.queues.get(key) || Promise.resolve()).then(() => this.recordNow(gdsPath, layoutHash, features));
        this.queues.set(key, next);
        try { return await next; } finally { if (this.queues.get(key) === next) this.queues.delete(key); }
    }
    private async recordNow(gdsPath: string, layoutHash: string, features: any[]): Promise<ReviewSnapshotResult> {
        try {
            const payloadFeatures = plainJson(features);
            const candidate = JSON.stringify({ gdsPath: path.resolve(gdsPath), currentHash: layoutHash, current: payloadFeatures });
            if (Buffer.byteLength(candidate, 'utf8') > this.maxBytes) return { status: 'unavailable' };
            const old = await this.load(gdsPath);
            if (old.status === 'unavailable') return { status: 'unavailable' };
            if (!validHash(layoutHash) || !Array.isArray(payloadFeatures) || !(payloadFeatures as any[]).every(validFeature)) return { status: 'unavailable' };
            const next: any = { version: 1, gdsPath: path.resolve(gdsPath), currentHash: layoutHash, current: payloadFeatures };
            if (old.currentHash && old.currentHash !== layoutHash) { next.previousHash = old.currentHash; next.previous = old.current; }
            else if (old.previousHash) { next.previousHash = old.previousHash; next.previous = old.previous; }
            const text = JSON.stringify(next);
            if (Buffer.byteLength(text, 'utf8') > this.maxBytes) return { status: 'unavailable' };
            await fs.promises.mkdir(this.root, { recursive: true });
            const tmp = this.file(gdsPath) + `.${process.pid}.${Date.now()}.tmp`;
            await fs.promises.writeFile(tmp, text, 'utf8');
            await fs.promises.rename(tmp, this.file(gdsPath));
            return { previousHash: next.previousHash, features: next.previous, status: next.previous ? 'available' : 'none' };
        } catch { return { status: 'unavailable' }; }
    }
}
