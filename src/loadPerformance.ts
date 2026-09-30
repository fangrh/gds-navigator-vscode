import * as fs from 'fs';
import * as path from 'path';

/** One resolver per load: duplicate provenance paths share filesystem checks,
 * while a subsequent reload sees newly created or removed source files. */
export function createSourceResolver(roots: string[], isFile = (file: string) => {
    try { return fs.statSync(file).isFile(); } catch { return false; }
}) {
    const resolutions = new Map<string, { resolved_file: string | undefined; source_resolution: string }>();
    return (reference: any) => {
        if (!reference?.file || typeof reference.file !== 'string') { return; }
        let result = resolutions.get(reference.file);
        if (!result) {
            const candidates = path.isAbsolute(reference.file) ? [reference.file] : roots.map(root => path.resolve(root, reference.file));
            const existing = [...new Set(candidates)].filter(isFile);
            result = { resolved_file: existing.length === 1 ? existing[0] : undefined,
                source_resolution: existing.length === 1 ? 'resolved_location' : existing.length ? 'ambiguous' : 'unavailable' };
            resolutions.set(reference.file, result);
        }
        Object.assign(reference, result);
    };
}

/** IDs are unique in validated annotation collections. Preserve incoming order. */
export function annotationChanges<T extends { id: string }>(before: T[], after: T[]) {
    const previous = new Map(before.map(item => [item.id, JSON.stringify(item)]));
    const nextIds = new Set(after.map(item => item.id));
    return {
        changed: after.filter(item => JSON.stringify(item) !== previous.get(item.id)),
        removed: before.filter(item => !nextIds.has(item.id)),
    };
}
