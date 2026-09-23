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
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
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
            const entries = data.entries.filter((entry: unknown): entry is SidecarEntry => Boolean(entry && typeof entry === 'object' && !Array.isArray(entry)));
            return {
                entries,
                ...(data.ports && typeof data.ports === 'object' ? { ports: data.ports } : {}),
                ...(data.ref_names && typeof data.ref_names === 'object' ? { ref_names: data.ref_names } : {}),
            };
        }
        return null;
    } catch {
        return null;
    }
}

/**
 * Guess which .py script generated the GDS from its sidecar: the most
 * frequently referenced existing .py file among the entries. Missing paths and
 * tied candidates stay unresolved so a rebuild cannot run an arbitrary script.
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
        if (typeof file !== 'string' || !file.toLowerCase().endsWith('.py')) {
            continue;
        }
        if (!path.isAbsolute(file)) {
            const sidecarRelative = path.resolve(path.dirname(sidecar), file);
            const gdsRelative = path.resolve(gdsDir, file);
            if (fs.existsSync(sidecarRelative) && fs.statSync(sidecarRelative).isFile()) file = sidecarRelative;
            else if (fs.existsSync(gdsRelative) && fs.statSync(gdsRelative).isFile()) file = gdsRelative;
            else {
                continue;
            }
        } else if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
            continue;
        }
        counts.set(file, (counts.get(file) || 0) + 1);
    }
    let best: string | undefined;
    let bestCount = 0;
    let tied = false;
    counts.forEach((count, file) => {
        if (count > bestCount) {
            best = file;
            bestCount = count;
            tied = false;
        } else if (count === bestCount) {
            tied = true;
        }
    });
    return tied ? undefined : best;
}
