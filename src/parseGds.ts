import * as vscode from 'vscode';
import { spawn } from 'child_process';
import * as path from 'path';
import { findSidecar } from './sidecar';

export interface ParseResult {
    /** GeoJSON FeatureCollection produced by python/parse_gds.py */
    geojson: unknown;
    /** 'full' when a provenance sidecar was found, else 'partial' */
    mode: 'full' | 'partial';
}

/**
 * Parse a .gds file into GeoJSON by spawning
 * `<selected python> <extension>/python/parse_gds.py <gds>`.
 * Uses the user-selected environment so klayout (a gdsfactory dependency)
 * is importable — this fixes the web app which hard-coded `python`.
 */
export function parseGdsFile(pythonPath: string, gdsPath: string, extensionDir: string): Promise<ParseResult> {
    const parseScript = path.join(extensionDir, 'python', 'parse_gds.py');
    const timeoutMs = vscode.workspace.getConfiguration('gdsNavigator').get<number>('parseTimeoutSec', 120) * 1000;

    return new Promise((resolve, reject) => {
        const proc = spawn(pythonPath, [parseScript, gdsPath], { windowsHide: true });
        let stdout = '';
        let stderr = '';
        let settled = false;

        const timer = setTimeout(() => {
            if (!settled) {
                settled = true;
                proc.kill();
                reject(new Error(`GDS parse timed out after ${timeoutMs / 1000}s (increase gdsNavigator.parseTimeoutSec)`));
            }
        }, timeoutMs);

        proc.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
        proc.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
        proc.on('error', (err) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            reject(new Error(
                `Could not start Python (${pythonPath}): ${err.message}. ` +
                'Pick the right environment with "GDS: Select Python Environment" (it must have klayout installed).'
            ));
        });
        proc.on('close', (code) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            if (code !== 0) {
                reject(new Error(stderr.trim() || `parse_gds.py exited with code ${code}`));
                return;
            }
            try {
                const geojson = JSON.parse(stdout);
                if (geojson && geojson.error) {
                    reject(new Error(String(geojson.error)));
                    return;
                }
                const mode: 'full' | 'partial' = findSidecar(gdsPath) ? 'full' : 'partial';
                resolve({ geojson, mode });
            } catch {
                reject(new Error('parse_gds.py produced invalid JSON output'));
            }
        });
    });
}
