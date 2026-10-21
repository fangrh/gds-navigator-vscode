import * as path from 'path';
import { findSidecar } from './sidecar';
import { spawnPythonProcess } from './pythonProcess';

const { hasPrimarySourceReference } = require('../webview/source-selection.js') as { hasPrimarySourceReference(provenance: unknown): boolean };

export interface ParseResult {
    geojson: unknown;
    mode: 'full' | 'partial';
    warnings?: string[];
}

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 60 * 60 * 1000;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

export function parseGdsFileCore(pythonPath: string, gdsPath: string, extensionDir: string, signal?: AbortSignal, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<ParseResult> {
    if (signal?.aborted) return Promise.reject(new Error('GDS parse cancelled'));
    const parseScript = path.join(extensionDir, 'python', 'parse_gds.py');
    const normalizedTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, MAX_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
        const child = spawnPythonProcess(pythonPath, [parseScript, gdsPath]);
        const { proc } = child;
        let stdout = '', stderr = '', outputBytes = 0, settled = false;
        let terminationError: Error | undefined;
        let timer: NodeJS.Timeout | undefined;
        const cleanup = () => { if (timer) clearTimeout(timer); signal?.removeEventListener('abort', abort); };
        const fail = (error: Error) => { if (settled) return; settled = true; cleanup(); reject(error); };
        const requestTermination = (error: Error) => {
            if (settled || terminationError) return;
            terminationError = error;
            cleanup();
            stdout = '';
            void child.terminate().then(() => fail(error), stopError => fail(new Error(`${error.message}; ${stopError.message}`)));
        };
        const abort = () => requestTermination(new Error('GDS parse cancelled'));
        const outputLimit = () => requestTermination(new Error(`parse_gds.py output exceeded ${MAX_OUTPUT_BYTES} bytes`));
        proc.stdout.on('data', (d: Buffer) => { if (settled || terminationError) return; outputBytes += d.byteLength; if (outputBytes > MAX_OUTPUT_BYTES) { outputLimit(); return; } stdout += d.toString(); });
        proc.stderr.on('data', (d: Buffer) => { if (settled || terminationError) return; outputBytes += d.byteLength; if (outputBytes > MAX_OUTPUT_BYTES) { outputLimit(); return; } stderr = (stderr + d.toString()).slice(-8192); });
        proc.on('error', err => { if (terminationError) return; fail(new Error(`Could not start Python (${pythonPath}): ${err.message}. Pick the right environment with "GDS: Select Python Environment" (it must have klayout installed).`)); });
        proc.on('close', code => {
            if (settled || terminationError) return; settled = true; cleanup();
            if (code !== 0) { reject(new Error(stderr.trim() || `parse_gds.py exited with code ${code}`)); return; }
            try {
                const geojson: any = JSON.parse(stdout);
                if (geojson && geojson.error) { reject(new Error(String(geojson.error))); return; }
                const sidecar = findSidecar(gdsPath), parserWarnings = Array.isArray(geojson?._diag?.sidecar_warnings) ? geojson._diag.sidecar_warnings.map(String) : [], warnings = [...parserWarnings];
                const features = Array.isArray(geojson?.features) ? geojson.features : [], tracked = features.filter((f: any) => hasPrimarySourceReference(f.properties?.provenance)).length;
                if (sidecar && tracked < features.length) warnings.push(`Provenance covers ${tracked}/${features.length} elements. The sidecar may be stale or this generator may bypass tracking; rebuild with the saved project environment.`);
                const mode: 'full' | 'partial' = features.length > 0 && tracked === features.length && warnings.length === 0 ? 'full' : 'partial';
                resolve({ geojson, mode, ...(warnings.length ? { warnings } : {}) });
            } catch { reject(new Error('parse_gds.py produced invalid JSON output')); }
        });
        timer = setTimeout(() => requestTermination(new Error(`GDS parse timed out after ${normalizedTimeout / 1000}s (increase gdsNavigator.parseTimeoutSec)`)), normalizedTimeout);
        if (signal) { signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort(); }
    });
}
