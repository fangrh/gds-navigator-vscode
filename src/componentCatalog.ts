import { spawn } from 'child_process';
import * as path from 'path';

export interface ComponentParameter { name: string; required: boolean; default?: unknown; type?: string; defaultRepresentable?: boolean; }
export interface ComponentCatalogEntry { name: string; description: string; parameters: ComponentParameter[]; source?: string; }
export interface ComponentCatalog { components: ComponentCatalogEntry[]; environment: Record<string, unknown>; }
export interface ComponentPreview { geojson: unknown; name: string; settings: Record<string, unknown>; ports?: unknown[]; }

const TIMEOUT_MS = 45_000;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

function scriptPath(): string {
    const candidates = [path.join(__dirname, '..', 'python', 'component_catalog.py'), path.join(process.cwd(), 'python', 'component_catalog.py')];
    return candidates.find(candidate => require('fs').existsSync(candidate)) || candidates[0];
}

function run(python: string, args: string[], signal?: AbortSignal): Promise<any> {
    if (signal?.aborted) return Promise.reject(new Error('component catalog request cancelled'));
    return new Promise((resolve, reject) => {
        const proc = spawn(python, [scriptPath(), ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
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

export function loadComponentCatalog(python: string, signal?: AbortSignal): Promise<ComponentCatalog> { return run(python, ['--catalog'], signal); }
export function previewComponent(python: string, name: string, settings: Record<string, unknown>, signal?: AbortSignal): Promise<ComponentPreview> {
    if (!name || typeof name !== 'string' || !settings || typeof settings !== 'object' || Array.isArray(settings)) return Promise.reject(new Error('component name and object settings are required'));
    let encoded: string;
    try { encoded = JSON.stringify(settings); } catch { return Promise.reject(new Error('settings must be JSON representable')); }
    if (encoded.length > 12000) return Promise.reject(new Error('Component settings exceed the 12000-character limit.'));
    return run(python, ['--preview', name, encoded], signal);
}
