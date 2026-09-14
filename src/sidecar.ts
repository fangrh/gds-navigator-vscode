import * as fs from 'fs';
import * as path from 'path';

/**
 * Provenance sidecar handling. A GDS file `chip.gds` may carry provenance in
 * a same-named JSON sidecar — `chip.provenance.json` (written by the
 * fangrh/gdsfactory fork) or a plain `chip.json`. The sidecar is detected
 * automatically when the GDS is opened.
 */

export function sidecarCandidates(gdsPath: string): string[] {
    const base = gdsPath.replace(/\.gds$/i, '');
    return [base + '.provenance.json', base + '.json'];
}

export function findSidecar(gdsPath: string): string | null {
    for (const candidate of sidecarCandidates(gdsPath)) {
        if (fs.existsSync(candidate)) {
            return candidate;
        }
    }
    return null;
}

export interface SidecarEntry {
    id?: number;
    file?: string;
    line?: number;
    function?: string;
    component?: string;
    call_stack?: string[];
    [key: string]: unknown;
}

export interface SidecarData {
    entries: SidecarEntry[];
    ports?: Record<string, unknown>;
    ref_names?: Record<string, string>;
}

export function readSidecar(sidecarPath: string): SidecarData | null {
    try {
        const data = JSON.parse(fs.readFileSync(sidecarPath, 'utf-8'));
        if (data && Array.isArray(data.entries)) {
            return data as SidecarData;
        }
        return null;
    } catch {
        return null;
    }
}

/**
 * Guess which .py script generated the GDS from its sidecar: the most
 * frequently referenced existing .py file among the entries. Paths recorded
 * on another machine are resolved by basename next to the GDS.
 */
export function deriveScriptFromSidecar(gdsPath: string): string | undefined {
    const sidecar = findSidecar(gdsPath);
    if (!sidecar) {
        return undefined;
    }
    const data = readSidecar(sidecar);
    if (!data) {
        return undefined;
    }
    const gdsDir = path.dirname(gdsPath);
    const counts = new Map<string, number>();
    for (const entry of data.entries) {
        let file = entry.file;
        if (!file || !file.endsWith('.py')) {
            continue;
        }
        if (!fs.existsSync(file)) {
            const local = path.join(gdsDir, path.basename(file));
            if (!fs.existsSync(local)) {
                continue;
            }
            file = local;
        }
        counts.set(file, (counts.get(file) || 0) + 1);
    }
    let best: string | undefined;
    let bestCount = 0;
    counts.forEach((count, file) => {
        if (count > bestCount) {
            best = file;
            bestCount = count;
        }
    });
    return best;
}
