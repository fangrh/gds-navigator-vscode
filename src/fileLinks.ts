/** Pure, serialisable provenance links between Python builders and GDS files. */

export interface FileLinkGraph {
    version: 1;
    builds: Record<string, BuildLink>;
    explicit: Record<string, ExplicitLink>;
}

export interface BuildLink {
    script: string;
    outputs: string[];
    kind: 'build';
    inputHash?: string;
}

export interface ExplicitLink {
    gds: string;
    script: string;
    kind: 'explicit';
}

function cleanPath(value: unknown): string | undefined {
    if (typeof value !== 'string' || !value.trim()) return undefined;
    const raw = value.trim().replace(/[\\]+/g, '/');
    // win32 normalization also makes this deterministic when tests run on POSIX.
    const normalized = /^[A-Za-z]:\//.test(raw) || raw.startsWith('//')
        ? raw.replace(/\//g, '\\')
        : raw;
    const result = normalized.match(/^[A-Za-z]:\\|^\\\\/) ? normalized : raw;
    return result.replace(/[\\/]+$/, '').replace(/\\/g, '/');
}

function key(value: string): string {
    let p = cleanPath(value) || '';
    // Collapse dot segments without making relative paths absolute.
    const absolute = p.startsWith('/') || /^[A-Za-z]:\//.test(p);
    const parts = p.split('/');
    const out: string[] = [];
    for (const part of parts) {
        if (!part || part === '.') continue;
        if (part === '..' && out.length && out[out.length - 1] !== '..') out.pop();
        else if (part !== '..') out.push(part);
        else out.push(part);
    }
    p = (absolute ? (p.startsWith('/') ? '/' : p.slice(0, 3)) : '') + out.slice(absolute && /^[A-Za-z]:\//.test(p) ? 1 : 0).join('/');
    return p.toLowerCase();
}

export function createFileLinks(): FileLinkGraph {
    return { version: 1, builds: {}, explicit: {} };
}

/** Validate and migrate persisted state; malformed records are ignored safely. */
export function loadFileLinks(value: unknown): FileLinkGraph {
    let input: any = value;
    if (typeof input === 'string') {
        try { input = JSON.parse(input); } catch { input = undefined; }
    }
    const graph = createFileLinks();
    if (!input || typeof input !== 'object') return graph;
    if (input.builds && typeof input.builds === 'object' && !Array.isArray(input.builds)) {
        for (const raw of Object.values(input.builds) as any[]) {
            const script = cleanPath(raw?.script);
            const outputs = Array.isArray(raw?.outputs) ? raw.outputs.map(cleanPath).filter((x: string | undefined): x is string => !!x) : [];
            if (!script || !outputs.length) continue;
            const k = key(script);
            const prior = graph.builds[k];
            graph.builds[k] = { script, outputs: Array.from(new Set([...(prior?.outputs || []), ...outputs])), kind: 'build', ...(typeof raw.inputHash === 'string' ? { inputHash: raw.inputHash } : {}) };
        }
    }
    if (input.explicit && typeof input.explicit === 'object' && !Array.isArray(input.explicit)) {
        for (const raw of Object.values(input.explicit) as any[]) {
            const gds = cleanPath(raw?.gds), script = cleanPath(raw?.script);
            if (gds && script) graph.explicit[key(gds)] = { gds, script, kind: 'explicit' };
        }
    }
    return graph;
}

export function updateBuildLinks(value: unknown, scriptValue: string, outputs: string[], inputHash?: string): FileLinkGraph {
    const graph = loadFileLinks(value), script = cleanPath(scriptValue);
    if (!script || !Array.isArray(outputs)) return graph;
    const valid = outputs.map(cleanPath).filter((x): x is string => !!x);
    if (!valid.length) return graph;
    const k = key(script), prior = graph.builds[k];
    // A later successful build claims an output, while the producing script's
    // historical outputs remain retained in its own record.
    const produced = new Set(valid.map(key));
    for (const [otherKey, other] of Object.entries(graph.builds)) {
        if (otherKey === k) continue;
        other.outputs = other.outputs.filter((output) => !produced.has(key(output)));
    }
    graph.builds[k] = { script, outputs: Array.from(new Set([...(prior?.outputs || []), ...valid])), kind: 'build', ...(inputHash !== undefined ? { inputHash } : prior?.inputHash !== undefined ? { inputHash: prior.inputHash } : {}) };
    return graph;
}

export function linkScript(value: unknown, gdsValue: string, scriptValue: string): FileLinkGraph {
    const graph = loadFileLinks(value), gds = cleanPath(gdsValue), script = cleanPath(scriptValue);
    if (gds && script) graph.explicit[key(gds)] = { gds, script, kind: 'explicit' };
    return graph;
}

export function relatedLayouts(value: unknown, scriptValue: string): string[] {
    const graph = loadFileLinks(value), script = cleanPath(scriptValue);
    if (!script) return [];
    const build = graph.builds[key(script)];
    const result = build ? [...build.outputs] : [];
    for (const explicit of Object.values(graph.explicit)) {
        if (key(explicit.script) === key(script) && !result.some((p) => key(p) === key(explicit.gds))) result.push(explicit.gds);
    }
    return result;
}

export function linkedScript(value: unknown, gdsValue: string): string | undefined {
    const graph = loadFileLinks(value), gds = cleanPath(gdsValue);
    if (!gds) return undefined;
    const explicit = graph.explicit[key(gds)];
    if (explicit) return explicit.script;
    for (const build of Object.values(graph.builds)) if (build.outputs.some((p) => key(p) === key(gds))) return build.script;
    return undefined;
}

/** Remap a file or directory prefix after a rename, preserving all link kinds. */
export function remapPath(value: unknown, oldValue: string, newValue: string): FileLinkGraph {
    const graph = loadFileLinks(value), oldPath = cleanPath(oldValue), next = cleanPath(newValue);
    if (!oldPath || !next) return graph;
    const remap = (p: string): string => {
        const pk = key(p), ok = key(oldPath);
        return pk === ok || pk.startsWith(ok + '/') ? next + p.slice(oldPath.length) : p;
    };
    const out = createFileLinks();
    for (const build of Object.values(graph.builds)) {
        const script = remap(build.script); out.builds[key(script)] = { ...build, script, outputs: build.outputs.map(remap) };
    }
    for (const explicit of Object.values(graph.explicit)) {
        const gds = remap(explicit.gds), script = remap(explicit.script); out.explicit[key(gds)] = { ...explicit, gds, script };
    }
    return out;
}
