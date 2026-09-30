import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

export interface ComponentParameter { name: string; required: boolean; default?: unknown; type?: string; defaultRepresentable?: boolean; }
export interface ComponentLibrary { module: 'gds_components'; exportName: string; }
export interface ComponentCatalogEntry { name: string; description: string; parameters: ComponentParameter[]; source?: string; library?: ComponentLibrary; }
export interface ComponentCatalog { components: ComponentCatalogEntry[]; environment: Record<string, unknown>; warnings?: string[]; }
export interface ComponentPreview { geojson: unknown; name: string; settings: Record<string, unknown>; ports?: unknown[]; library?: ComponentLibrary; }
export interface ComponentThumbnail { name: string; geojson?: unknown; error?: string; settings?: Record<string, unknown>; ports?: unknown[]; library?: ComponentLibrary; }

const TIMEOUT_MS = 45_000;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const MAX_THUMBNAIL_NAMES = 8;
const MAX_THUMBNAIL_CACHE = 64;
const thumbnailCache = new Map<string, ComponentThumbnail>();
const PREVIEW_CACHE_TTL_MS = 30_000;
const MAX_PREVIEW_CACHE_ENTRIES = 32;
const MAX_PREVIEW_CACHE_BYTES = 8 * 1024 * 1024;
type PreviewCacheEntry = { value: ComponentPreview; bytes: number; expiresAt: number; context: string };
const previewCache = new Map<string, PreviewCacheEntry>();
let previewCacheBytes = 0;

function scriptPath(): string {
    const candidates = [path.join(__dirname, '..', 'python', 'component_catalog.py'), path.join(process.cwd(), 'python', 'component_catalog.py')];
    return candidates.find(candidate => require('fs').existsSync(candidate)) || candidates[0];
}

function canonicalJson(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
}

function fileContext(file: string): string {
    try {
        const stat = fs.statSync(file);
        return `${path.resolve(file)}\u0000${stat.size}\u0000${stat.mtimeMs}`;
    } catch {
        return `${path.resolve(file)}\u0000missing`;
    }
}

function previewContext(python: string): string | undefined {
    try {
        if (!fs.statSync(python).isFile() || !fs.statSync(scriptPath()).isFile()) return undefined;
    } catch {
        return undefined;
    }
    return `${fileContext(python)}\u0000${fileContext(scriptPath())}`;
}
function clonePreview(value: ComponentPreview): ComponentPreview { return JSON.parse(JSON.stringify(value)) as ComponentPreview; }

function removePreviewCacheEntry(key: string): void {
    const entry = previewCache.get(key);
    if (!entry) return;
    previewCacheBytes -= entry.bytes;
    previewCache.delete(key);
}

function trimPreviewCache(now: number): void {
    for (const [key, entry] of previewCache) if (entry.expiresAt <= now) removePreviewCacheEntry(key);
    while (previewCache.size > MAX_PREVIEW_CACHE_ENTRIES || previewCacheBytes > MAX_PREVIEW_CACHE_BYTES) {
        const oldest = previewCache.keys().next().value as string | undefined;
        if (!oldest) break;
        removePreviewCacheEntry(oldest);
    }
}

function putPreviewCache(key: string, value: ComponentPreview, context: string, now: number): void {
    const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
    if (bytes > MAX_PREVIEW_CACHE_BYTES) return;
    removePreviewCacheEntry(key);
    previewCache.set(key, { value: clonePreview(value), bytes, expiresAt: now + PREVIEW_CACHE_TTL_MS, context });
    previewCacheBytes += bytes;
    trimPreviewCache(now);
}

function run(python: string, args: string[], signal?: AbortSignal, projectRoot?: string): Promise<any> {
    if (signal?.aborted) return Promise.reject(new Error('component catalog request cancelled'));
    return new Promise((resolve, reject) => {
        const proc = spawn(python, [scriptPath(), ...args, ...(projectRoot ? ['--project-root', path.resolve(projectRoot)] : [])], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        let output = ''; let error = ''; let bytes = 0; let settled = false;
        const terminate = () => { if (process.platform === 'win32' && proc.pid) spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true }).on('error', () => proc.kill()); else proc.kill(); };
        const finish = (fn: (value: any) => void, value: any) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); fn(value); };
        const abort = () => { terminate(); finish(reject, new Error('component catalog request cancelled')); };
        const timer = setTimeout(() => { terminate(); finish(reject, new Error('component catalog request timed out')); }, TIMEOUT_MS);
        if (signal) { if (signal.aborted) { abort(); return; } signal.addEventListener('abort', abort, { once: true }); }
        proc.stdout.on('data', chunk => { bytes += chunk.byteLength; if (bytes > MAX_OUTPUT_BYTES) { terminate(); finish(reject, new Error('component catalog output exceeded limit')); } else output += chunk.toString(); });
        proc.stderr.on('data', chunk => { bytes += chunk.byteLength; if (bytes > MAX_OUTPUT_BYTES) { terminate(); finish(reject, new Error('component catalog output exceeded limit')); return; } error = (error + chunk.toString()).slice(-8192); });
        proc.on('error', err => finish(reject, new Error(`Could not start component catalog Python: ${err.message}`)));
        proc.on('close', code => { if (settled) return; if (code !== 0) { try { const parsed = JSON.parse(output); finish(reject, new Error(String(parsed.error || error || 'component catalog failed'))); } catch { finish(reject, new Error(error || 'component catalog failed')); } return; } try { const parsed = JSON.parse(output); if (parsed.error) throw new Error(String(parsed.error)); finish(resolve, parsed); } catch (err) { finish(reject, err); } });
    });
}

export function loadComponentCatalog(python: string, signal?: AbortSignal, projectRoot?: string): Promise<ComponentCatalog> { return run(python, ['--catalog'], signal, projectRoot); }
export function previewComponent(python: string, name: string, settings: Record<string, unknown>, signal?: AbortSignal, projectRoot?: string): Promise<ComponentPreview> {
    if (!name || typeof name !== 'string' || !settings || typeof settings !== 'object' || Array.isArray(settings)) return Promise.reject(new Error('component name and object settings are required'));
    let encoded: string;
    try { encoded = JSON.stringify(settings); } catch { return Promise.reject(new Error('settings must be JSON representable')); }
    if (encoded.length > 12000) return Promise.reject(new Error('Component settings exceed the 12000-character limit.'));
    // Project factories may import arbitrary local helpers. Rebuild them rather
    // than relying on incomplete dependency fingerprints to validate a cache.
    const context = name.startsWith('project:') ? undefined : previewContext(python);
    const canonicalSettings = canonicalJson(JSON.parse(encoded));
    const key = `${path.resolve(python)}\u0000${projectRoot ? path.resolve(projectRoot) : ''}\u0000${name}\u0000${canonicalSettings}`;
    const now = Date.now();
    trimPreviewCache(now);
    const cached = context ? previewCache.get(key) : undefined;
    if (signal?.aborted) return Promise.reject(new Error('component catalog request cancelled'));
    if (cached && cached.expiresAt > now && cached.context === context) {
        previewCache.delete(key);
        previewCache.set(key, cached);
        return Promise.resolve(clonePreview(cached.value));
    }
    if (cached) removePreviewCacheEntry(key);
    return run(python, ['--preview', name, encoded], signal, projectRoot).then(result => {
        if (signal?.aborted) throw new Error('component catalog request cancelled');
        const value = result as ComponentPreview;
        if (context) putPreviewCache(key, value, context, Date.now());
        return value;
    });
}

export async function requestComponentThumbnails(python: string, names: string[], signal?: AbortSignal, projectRoot?: string): Promise<{ items: ComponentThumbnail[] }> {
    if (!Array.isArray(names) || names.length < 1 || names.length > MAX_THUMBNAIL_NAMES || names.some(name => typeof name !== 'string' || !name || name.length > 160)) {
        return Promise.reject(new Error(`thumbnail request must contain 1-${MAX_THUMBNAIL_NAMES} valid names`));
    }
    if (signal?.aborted) throw new Error('component catalog request cancelled');
    const prefix = `${path.resolve(python)}\u0000${projectRoot ? path.resolve(projectRoot) : ''}\u0000`;
    const context = previewContext(python);
    const missing: string[] = [];
    const fresh = new Map<string, ComponentThumbnail>();
    for (const name of names) {
        const cached = thumbnailCache.get(prefix + name);
        if (!cached || name.startsWith('project:')) missing.push(name);
    }
    if (missing.length) {
        const encoded = JSON.stringify(missing);
        const result = await run(python, ['--thumbnails', encoded], signal, projectRoot) as { items?: ComponentThumbnail[] };
        if (!Array.isArray(result.items)) throw new Error('component thumbnail response was malformed');
        for (const item of result.items) {
            if (!item || typeof item.name !== 'string' || (item.geojson === undefined && typeof item.error !== 'string')) continue;
            fresh.set(item.name, item);
            if (item.name.startsWith('project:')) continue;
            thumbnailCache.set(prefix + item.name, item);
            if (context && item.geojson !== undefined && Array.isArray(item.ports) && item.settings && typeof item.settings === 'object' && !Array.isArray(item.settings)) {
                const settings = item.settings as Record<string, unknown>;
                const key = `${prefix}${item.name}\u0000${canonicalJson(settings)}`;
                putPreviewCache(key, { name: item.name, geojson: item.geojson, settings, ports: item.ports }, context, Date.now());
            }
            while (thumbnailCache.size > MAX_THUMBNAIL_CACHE) thumbnailCache.delete(thumbnailCache.keys().next().value as string);
        }
    }
    const items: ComponentThumbnail[] = [];
    for (const name of names) {
        const item = fresh.get(name) || thumbnailCache.get(prefix + name);
        if (item) items.push(item);
    }
    return { items };
}
