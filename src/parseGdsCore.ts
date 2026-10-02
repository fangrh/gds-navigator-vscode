import { spawn } from 'child_process';
import * as path from 'path';
import { findSidecar } from './sidecar';

export interface ParseResult {
    geojson: unknown;
    mode: 'full' | 'partial';
    warnings?: string[];
}

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 60 * 60 * 1000;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

export function parseGdsFileCore(pythonPath: string, gdsPath: string, extensionDir: string, signal?: AbortSignal, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<ParseResult> {
    const parseScript = path.join(extensionDir, 'python', 'parse_gds.py');
    const normalizedTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, MAX_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
        const proc = spawn(pythonPath, [parseScript, gdsPath], { windowsHide: true });
        let stdout = '', stderr = '', outputBytes = 0, settled = false;
        const terminate = () => { if (process.platform === 'win32' && proc.pid) spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true }); else proc.kill(); };
        const timer = setTimeout(() => { if (settled) return; settled = true; terminate(); signal?.removeEventListener('abort', abort); reject(new Error(`GDS parse timed out after ${normalizedTimeout / 1000}s (increase gdsNavigator.parseTimeoutSec)`)); }, normalizedTimeout);
        const abort = () => { if (settled) return; settled = true; clearTimeout(timer); terminate(); reject(new Error('GDS parse cancelled')); };
        if (signal) { if (signal.aborted) { abort(); return; } signal.addEventListener('abort', abort, { once: true }); }
        const outputLimit = () => { if (settled) return; settled = true; clearTimeout(timer); terminate(); signal?.removeEventListener('abort', abort); reject(new Error(`parse_gds.py output exceeded ${MAX_OUTPUT_BYTES} bytes`)); };
        proc.stdout.on('data', (d: Buffer) => { outputBytes += d.byteLength; if (outputBytes > MAX_OUTPUT_BYTES) { outputLimit(); return; } stdout += d.toString(); });
        proc.stderr.on('data', (d: Buffer) => { outputBytes += d.byteLength; if (outputBytes > MAX_OUTPUT_BYTES) { outputLimit(); return; } stderr = (stderr + d.toString()).slice(-8192); });
        proc.on('error', err => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(new Error(`Could not start Python (${pythonPath}): ${err.message}. Pick the right environment with "GDS: Select Python Environment" (it must have klayout installed).`)); });
        proc.on('close', code => {
            if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
            if (code !== 0) { reject(new Error(stderr.trim() || `parse_gds.py exited with code ${code}`)); return; }
            try {
                const geojson: any = JSON.parse(stdout);
                if (geojson && geojson.error) { reject(new Error(String(geojson.error))); return; }
                const sidecar = findSidecar(gdsPath), parserWarnings = Array.isArray(geojson?._diag?.sidecar_warnings) ? geojson._diag.sidecar_warnings.map(String) : [], warnings = [...parserWarnings];
                const features = Array.isArray(geojson?.features) ? geojson.features : [], tracked = features.filter((f: any) => typeof f.properties?.provenance?.file === 'string' && Number.isInteger(f.properties.provenance.line) && f.properties.provenance.line > 0).length;
                if (sidecar && tracked < features.length) warnings.push(`Provenance covers ${tracked}/${features.length} elements. The sidecar may be stale or this generator may bypass tracking; rebuild with the saved project environment.`);
                const mode: 'full' | 'partial' = features.length > 0 && tracked === features.length && warnings.length === 0 ? 'full' : 'partial';
                resolve({ geojson, mode, ...(warnings.length ? { warnings } : {}) });
            } catch { reject(new Error('parse_gds.py produced invalid JSON output')); }
        });
    });
}
