import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export interface UsageFields {
    source?: 'viewer' | 'extension' | 'command'; phase?: 'intent' | 'result' | 'lifecycle'; outcome?: 'success' | 'failure' | 'cancelled' | 'unknown';
    documentId?: string; durationMs?: number; operationId?: string; control?: string; kind?: string; count?: number; reason?: string; method?: string;
}
export interface UsageOptions { enabled?: boolean; maxFileBytes?: number; maxTotalBytes?: number; maxAgeDays?: number; onError?: (message: string) => void; onPersist?: () => void; extensionVersion?: string; }
const enums = { source: ['viewer', 'extension', 'command'], phase: ['intent', 'result', 'lifecycle'], outcome: ['success', 'failure', 'cancelled', 'unknown'], kind: ['rectangle', 'circle', 'line', 'polygon', 'route', 'primitive', 'factory', 'move', 'resize', 'rotate', 'mixed'], method: ['yellow', 'bright', 'dark', 'numbered-markers', 'keyboard', 'mouse'], reason: ['backend_error', 'stale', 'invalid', 'cancelled', 'timeout', 'logging_error'] } as const;
const safe = /^[a-z][a-z0-9_.-]{0,63}$/;
const id = /^[A-Za-z0-9._:-]{1,128}$/;
function hash(value: string): string { return crypto.createHash('sha256').update(value).digest('hex').slice(0, 24); }
export function hashDocument(documentPath: string): string {
    const normalized = process.platform === 'win32' ? path.normalize(documentPath).toLowerCase() : path.normalize(documentPath);
    return 'doc-' + hash(normalized);
}
function validLimit(n: number | undefined, fallback: number): number { if (n === undefined) return fallback; if (!Number.isFinite(n) || n <= 0) throw new TypeError('Usage log limits must be positive finite numbers'); return Math.floor(n); }

export class UsageLog {
    private readonly dir: string; private readonly session: string; private readonly maxFile: number; private readonly maxTotal: number; private readonly maxAge: number; private readonly onError?: (message: string) => void; private readonly extensionVersion?: string;
    private enabled: boolean; private index = 1; private sequence = 0; private chain: Promise<void> = Promise.resolve(); private failed = 0; private dropped = 0; private disposed = false;
    private pending = 0;
    private readonly onPersist?: () => void;
    public constructor(root: string, options: UsageOptions = {}) {
        this.dir = path.join(path.resolve(root), '.gds-navigator', 'usage'); this.session = crypto.randomUUID(); this.enabled = options.enabled !== false;
        this.onPersist = options.onPersist;
        this.maxFile = validLimit(options.maxFileBytes, 1024 * 1024); this.maxTotal = validLimit(options.maxTotalBytes, 20 * 1024 * 1024); this.maxAge = validLimit(options.maxAgeDays, 30); this.onError = options.onError; this.extensionVersion = options.extensionVersion;
    }
    public get sessionId(): string { return this.session; }
    public get location(): string { return this.file(1); }
    private file(index: number): string { return path.join(this.dir, `session-${this.session}-${String(index).padStart(4, '0')}.jsonl`); }
    public setEnabled(enabled: boolean): void { this.enabled = !!enabled; }
    public status(): { enabled: boolean; failed: number; dropped?: number } { return { enabled: this.enabled, failed: this.failed, ...(this.dropped ? { dropped: this.dropped } : {}) }; }
    private report(error: unknown): void { this.failed++; try { this.onError?.(error instanceof Error ? error.message : String(error)); } catch { /* logging must never throw */ } }
    private sanitize(action: string, fields?: UsageFields): Record<string, unknown> | undefined {
        if (typeof action !== 'string' || !safe.test(action)) { this.dropped++; return undefined; }
        const out: Record<string, unknown> = {};
        if (fields) for (const key of Object.keys(fields) as (keyof UsageFields)[]) {
            const value = fields[key]; if (value === undefined) continue;
            if (key === 'source' || key === 'phase' || key === 'outcome') { if (!(enums[key] as readonly string[]).includes(value as string)) { this.dropped++; return undefined; } out[key] = value; }
            else if (key === 'documentId') { if (typeof value !== 'string' || !value || value.length > 4096) { this.dropped++; return undefined; } out[key] = hashDocument(value); }
            else if (key === 'operationId') { if (typeof value !== 'string' || !id.test(value)) { this.dropped++; return undefined; } out[key] = 'op-' + hash(value); }
            else if (key === 'kind' || key === 'reason' || key === 'method') { if (!(enums[key] as readonly string[]).includes(value as string)) { this.dropped++; return undefined; } out[key] = value; }
            else if (key === 'control') { if (typeof value !== 'string' || !safe.test(value)) { this.dropped++; return undefined; } out[key] = value; }
            else if (key === 'durationMs' || key === 'count') { if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) { this.dropped++; return undefined; } out[key] = key === 'count' ? Math.floor(value) : value; }
        }
        return out;
    }
    public record(action: string, fields?: UsageFields): void {
        if (!this.enabled || this.disposed) { if (this.disposed) this.dropped++; return; }
        if (this.pending >= 2000) { this.dropped++; return; }
        const clean = this.sanitize(action, { phase: 'lifecycle', outcome: 'unknown', ...fields }); if (!clean) return;
        const sequence = ++this.sequence; const line = JSON.stringify({ schema: 'gds-navigator.usage', version: 1, sessionId: this.session, seq: sequence, id: `${this.session}-${sequence}`, timestamp: new Date().toISOString(), ...(this.extensionVersion ? { extensionVersion: this.extensionVersion } : {}), action, ...clean }) + '\n';
        this.pending++;
        this.chain = this.chain.then(() => this.append(line)).catch(error => this.report(error)).finally(() => { this.pending--; });
    }
    private async append(line: string): Promise<void> {
        await fs.promises.mkdir(this.dir, { recursive: true });
        let file = this.file(this.index); let size = 0; try { size = (await fs.promises.stat(file)).size; } catch { /* new file */ }
        if (size + Buffer.byteLength(line) > this.maxFile) file = this.file(++this.index);
        await fs.promises.appendFile(file, line, 'utf8'); await this.prune();
        try { this.onPersist?.(); } catch { /* observers cannot break recording */ }
    }
    private async prune(): Promise<void> {
        let files = (await fs.promises.readdir(this.dir)).filter(name => /^session-[A-Za-z0-9-]+-\d{4}\.jsonl$/.test(name));
        const now = Date.now(); const rows: { name: string; size: number; mtime: number }[] = [];
        for (const name of files) { const file = path.join(this.dir, name); try { const stat = await fs.promises.stat(file); if (now - stat.mtimeMs > this.maxAge * 86400000 && name.indexOf(`session-${this.session}-`) !== 0) { await fs.promises.unlink(file); continue; } rows.push({ name, size: stat.size, mtime: stat.mtimeMs }); } catch { /* concurrent cleanup */ } }
        rows.sort((a, b) => b.mtime - a.mtime); let total = rows.reduce((n, r) => n + r.size, 0);
        for (const row of rows.sort((a, b) => a.mtime - b.mtime)) { if (total <= this.maxTotal) break; if (row.name.indexOf(`session-${this.session}-`) === 0 && row.name === path.basename(this.file(this.index))) continue; try { await fs.promises.unlink(path.join(this.dir, row.name)); total -= row.size; } catch { /* best effort */ } }
    }
    public async flush(): Promise<void> { try { await this.chain; } catch (error) { this.report(error); } }
    public async dispose(): Promise<void> { this.disposed = true; await this.flush(); }
    public async clear(): Promise<void> {
        this.chain = this.chain.then(async () => {
            await fs.promises.mkdir(this.dir, { recursive: true });
            for (const name of await fs.promises.readdir(this.dir)) if (/^session-[A-Za-z0-9-]+-\d{4}\.jsonl$/.test(name)) await fs.promises.unlink(path.join(this.dir, name));
            this.index = 1;
            try { this.onPersist?.(); } catch { /* observers cannot break clearing */ }
        });
        try { await this.chain; } catch (error) { this.report(error); throw error; }
    }
}
