import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

type LegacyMemento = { get<T>(key: string, defaultValue?: T): T | undefined; update(key: string, value: unknown): Thenable<void> | Promise<void>; keys?: readonly string[] | (() => readonly string[]) };
type DiskValue = unknown;

const STORE_VERSION = 1;
const PREFIX = 'gdsNavigator.';
const TAG = '$projectRelative';
const KEY_TAG = '@projectRelative/';
const PATH_FIELDS = new Set(['gdsPath', 'imagePath', 'file', 'documentPath', 'script', 'gds', 'outputs']);
const FOLDED_DOCUMENT_KEYS = new Set(['gdsnavigator.assoc', 'gdsnavigator.annotations.v1', 'gdsnavigator.alignment']);
const KEY_CONFLICT = 'GDS Navigator project store contains conflicting project-relative keys';

function isAbsoluteAny(value: string): boolean {
    return path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\');
}

function relativeKeyPath(root: string, candidate: string, allowFolded = false): string | undefined {
    const absolute = path.resolve(candidate), rel = path.relative(root, absolute);
    if (rel && rel !== '..' && !rel.startsWith(`..${path.sep}`)) return rel;
    if (!allowFolded || !path.isAbsolute(candidate)) return undefined;
    const resolvedRoot = path.resolve(root);
    const rootAnchor = path.parse(resolvedRoot).root, candidateAnchor = path.parse(absolute).root;
    if (rootAnchor.toLowerCase() !== candidateAnchor.toLowerCase()) return undefined;
    const rootParts = resolvedRoot.slice(rootAnchor.length).split(path.sep).filter(Boolean);
    const candidateParts = absolute.slice(candidateAnchor.length).split(path.sep).filter(Boolean);
    if (candidateParts.length <= rootParts.length || !rootParts.every((part, i) => part.toLowerCase() === candidateParts[i].toLowerCase())) return undefined;
    // Compare components, then retain the original tail. Unicode lowercasing
    // can change string length, so slicing by a folded prefix is unsafe.
    return candidateParts.slice(rootParts.length).join(path.sep);
}

function encode(value: DiskValue, root: string, field?: string, fileLinks = false): DiskValue {
    if (typeof value === 'string' && field && PATH_FIELDS.has(field) && isAbsoluteAny(value)) {
        const absolute = path.resolve(value);
        const rel = path.relative(root, absolute);
        if (rel && rel !== '..' && !rel.startsWith(`..${path.sep}`)) return { [TAG]: rel.split(path.sep).join('/') };
        return value;
    }
    if (Array.isArray(value)) return value.map((item) => encode(item, root, field));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => {
        const linkMap = fileLinks && (k === 'builds' || k === 'explicit') && v && typeof v === 'object' && !Array.isArray(v);
        return [encodeObjectKey(k, root), linkMap ? encodeLinkMap(v as Record<string, unknown>, root, k === 'builds' ? 'script' : 'gds') : encode(v, root, k)];
    }));
    return value;
}

function decode(value: DiskValue, root: string): DiskValue {
    if (value && typeof value === 'object' && !Array.isArray(value) && typeof (value as any)[TAG] === 'string') return path.resolve(root, (value as any)[TAG]);
    if (Array.isArray(value)) return value.map((item) => decode(item, root));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [decodeObjectKey(k, root), decode(v, root)]));
    return value;
}

function encodeObjectKey(key: string, root: string, witness?: string): string {
    if (!isAbsoluteAny(key)) return key;
    if (witness && path.isAbsolute(witness) && path.isAbsolute(key) && path.resolve(witness).toLowerCase() === path.resolve(key).toLowerCase()) {
        // Link records retain the actual path spelling. Use it to avoid moving
        // a genuine external case-only sibling whose logical key was folded.
        if (!relativeKeyPath(root, witness)) return key;
        const relative = relativeKeyPath(root, key, true);
        return relative ? `${KEY_TAG}${relative.split(path.sep).join('/')}` : key;
    }
    const relative = relativeKeyPath(root, key);
    return relative ? `${KEY_TAG}${relative.split(path.sep).join('/')}` : key;
}

function encodeLinkMap(value: Record<string, unknown>, root: string, pathField: 'script' | 'gds'): DiskValue {
    const encoded = new Map<string, DiskValue>();
    for (const [key, record] of Object.entries(value)) {
        const witness = record && typeof record === 'object' && !Array.isArray(record) ? (record as Record<string, unknown>)[pathField] : undefined;
        const encodedKey = encodeObjectKey(key, root, typeof witness === 'string' ? witness : undefined);
        if (encoded.has(encodedKey)) throw new Error(KEY_CONFLICT);
        encoded.set(encodedKey, encode(record, root, key));
    }
    return Object.fromEntries(encoded);
}

function decodeObjectKey(key: string, root: string): string {
    return key.startsWith(KEY_TAG) ? path.resolve(root, key.slice(KEY_TAG.length)) : key;
}

export class ProjectStore {
    private readonly root?: string;
    private readonly legacy: LegacyMemento;
    private readonly values = new Map<string, unknown>();
    private loaded = false;
    private readyPromise?: Promise<void>;
    private writeQueue: Promise<void> = Promise.resolve();
    private diskFingerprint?: string;
    private malformed?: Error;

    constructor(root: string | undefined, legacy: LegacyMemento) {
        this.root = root ? path.resolve(root) : undefined;
        this.legacy = legacy;
    }

    private get filePath(): string | undefined { return this.root ? path.join(this.root, '.gds-navigator', 'project.json') : undefined; }

    async ready(): Promise<void> {
        if (this.loaded) return;
        if (this.readyPromise) return this.readyPromise;
        this.readyPromise = this.load();
        return this.readyPromise;
    }

    private async load(): Promise<void> {
        const file = this.filePath;
        if (!file) { this.loaded = true; return; }
        try {
            const parsed = JSON.parse(await fs.promises.readFile(file, 'utf8'));
            if (!parsed || parsed.version !== STORE_VERSION || !parsed.entries || typeof parsed.entries !== 'object') throw new Error('unsupported project store schema');
            for (const [diskKey, value] of Object.entries(parsed.entries)) {
                const key = this.decodeKey(diskKey);
                if (key.startsWith(PREFIX)) this.values.set(key, decode(value, this.root!));
            }
            this.diskFingerprint = await this.fingerprint(file);
        } catch (error: any) {
            if (error?.code !== 'ENOENT') this.malformed = new Error(`GDS Navigator project store is malformed: ${error?.message || error}`);
        }
        // Legacy values are copied into the new document on the first update,
        // while remaining available immediately and never being deleted.
        const diskKeys = new Set([...this.values.keys()].map(key => key.toLowerCase()));
        const legacyKeys = typeof this.legacy.keys === 'function' ? this.legacy.keys() : (this.legacy.keys || []);
        for (const key of legacyKeys) {
            if (!key.startsWith(PREFIX) || this.values.has(key) || diskKeys.has(key.toLowerCase())) continue;
            const legacyValue = this.legacy.get(key, undefined);
            if (legacyValue !== undefined) this.values.set(key, legacyValue);
        }
        this.loaded = true;
    }

    get warning(): string | undefined { return this.malformed?.message; }

    get<T>(key: string, defaultValue?: T): T | undefined {
        if (!key.startsWith(PREFIX)) return defaultValue;
        if (this.values.has(key)) return this.values.get(key) as T;
        const folded = key.toLowerCase();
        for (const [storedKey, storedValue] of this.values) if (storedKey.toLowerCase() === folded) return storedValue as T;
        return this.legacy.get<T>(key, defaultValue);
    }

    async update(key: string, value: unknown): Promise<void> {
        await this.ready();
        if (!key.startsWith(PREFIX)) return;
        if (!this.root || !this.filePath) {
            await this.legacy.update(key, value);
            return;
        }
        if (this.malformed) throw this.malformed;
        const operation = this.writeQueue.then(async () => {
            const next = new Map(this.values);
            for (const storedKey of next.keys()) if (storedKey.toLowerCase() === key.toLowerCase()) next.delete(storedKey);
            next.set(key, value);
            const observed = await this.fingerprint(this.filePath!);
            if (observed !== this.diskFingerprint) throw new Error('GDS Navigator project store changed externally; reload before writing.');
            const entries: Record<string, unknown> = {};
            for (const [entryKey, entryValue] of next) {
                const encodedKey = this.encodeKey(entryKey);
                if (Object.prototype.hasOwnProperty.call(entries, encodedKey)) throw new Error(KEY_CONFLICT);
                entries[encodedKey] = encode(entryValue, this.root!, this.valueField(entryKey), entryKey.toLowerCase() === 'gdsnavigator.filelinks.v1');
            }
            const payload = JSON.stringify({ version: STORE_VERSION, entries }, null, 2) + '\n';
            const dir = path.dirname(this.filePath!);
            await fs.promises.mkdir(dir, { recursive: true });
            const temp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
            try { await fs.promises.writeFile(temp, payload, 'utf8'); await fs.promises.rename(temp, this.filePath!); this.diskFingerprint = this.fingerprintText(payload); this.values.clear(); for (const [k, v] of next) this.values.set(k, v); }
            catch (error) { try { await fs.promises.unlink(temp); } catch { /* best effort */ } throw error; }
        });
        this.writeQueue = operation.catch(() => undefined);
        return operation;
    }

    private encodeKey(key: string): string {
        if (!this.root || !key.startsWith(PREFIX)) return key;
        const marker = `${PREFIX}`;
        const suffixStart = key.indexOf(':', marker.length);
        const suffix = suffixStart >= marker.length ? key.slice(suffixStart + 1) : key.slice(marker.length);
        if (!isAbsoluteAny(suffix)) return key;
        const rel = relativeKeyPath(this.root, suffix, FOLDED_DOCUMENT_KEYS.has(key.slice(0, suffixStart).toLowerCase()));
        return rel ? `${key.slice(0, suffixStart + 1)}${KEY_TAG}${rel.split(path.sep).join('/')}` : key;
    }

    private decodeKey(key: string): string {
        if (!this.root) return key;
        const marker = key.indexOf(KEY_TAG);
        return marker >= PREFIX.length ? `${key.slice(0, marker)}${path.resolve(this.root, key.slice(marker + KEY_TAG.length))}` : key;
    }

    private valueField(key: string): string | undefined { return key.startsWith(`${PREFIX}assoc:`) ? 'script' : undefined; }
    private fingerprintText(text: string): string { return crypto.createHash('sha256').update(text).digest('hex'); }
    private async fingerprint(file: string): Promise<string | undefined> { try { return this.fingerprintText(await fs.promises.readFile(file, 'utf8')); } catch (error: any) { if (error?.code === 'ENOENT') return undefined; throw error; } }

    keys(): string[] {
        const legacyKeys = typeof this.legacy.keys === 'function' ? this.legacy.keys() : (this.legacy.keys || []);
        return Array.from(new Set([...this.values.keys(), ...legacyKeys.filter((key) => key.startsWith(PREFIX))]));
    }
}
