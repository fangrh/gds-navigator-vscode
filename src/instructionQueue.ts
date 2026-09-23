import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { TextDecoder } from 'util';
import { selectionDocument, validateAnnotations } from './selectionExport';

export type InstructionStatus = 'open' | 'done' | 'reverted';
export interface InstructionInput {
    gdsPath: string;
    gdsHash?: string;
    request?: any;
    components?: any[];
    beforeAnnotations?: any[];
    afterAnnotations?: any[];
    generatingScript?: string;
    topCell?: string;
    catalog?: any[];
    sourceFiles?: string[];
    runtime?: { executable: string; args: string[]; cwd: string; env: { GDS_PROVENANCE: '1' }; note: string };
}
export interface SourceReceipt { path: string; beforeHash: string; beforeText: string; afterHash?: string; }
export type InstructionHistoryEvent = 'created' | 'start' | 'done' | 'reverted' | 'comment';
export interface InstructionComment { id: string; text: string; createdAt: string; }
export interface InstructionHistoryEntry {
    event: InstructionHistoryEvent;
    timestamp: string;
    status: InstructionStatus;
    note?: string;
}
export interface InstructionRecord extends InstructionInput {
    id: string;
    sequence: number;
    createdAt: string;
    status: InstructionStatus;
    note?: string;
    context: any;
    sourceReceipts?: SourceReceipt[];
    startedAt?: string;
    history?: InstructionHistoryEntry[];
    comments?: InstructionComment[];
}
interface Store { version: 1; nextSequence: number; records: InstructionRecord[]; }

function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)); }
function freeze<T>(value: T): T {
    if (value && typeof value === 'object') { Object.freeze(value); Object.values(value as any).forEach(freeze); }
    return value;
}
function digest(value: string): string { return crypto.createHash('sha256').update(value).digest('hex'); }
function readUtf8(file: string): string {
    const bytes = fs.readFileSync(file);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error(`Source file is not valid canonical UTF-8: ${file}`);
    return text;
}

export class InstructionQueue {
    private readonly root: string;
    private readonly file: string;
    private store: Store = { version: 1, nextSequence: 1, records: [] };
    private fingerprint: string | null = null;
    private valid = false;

    public constructor(root: string = process.cwd()) {
        this.root = path.resolve(root);
        this.file = path.join(this.root, '.gds-navigator', 'instructions.json');
        this.load();
    }

    public get location(): string { return this.file; }
    public ready(): boolean { return this.valid; }

    private load(): void {
        this.valid = false;
        try {
            const text = fs.readFileSync(this.file, 'utf8');
            const parsed = JSON.parse(text);
            if (!this.validStore(parsed)) return;
            this.store = parsed;
            this.fingerprint = digest(text);
            this.valid = true;
        } catch (error: any) {
            if (error?.code === 'ENOENT') {
                this.store = { version: 1, nextSequence: 1, records: [] };
                this.valid = true;
                this.fingerprint = null;
            } else this.valid = false;
        }
    }

    private validStore(value: any): value is Store {
        if (!value || value.version !== 1 || !Number.isInteger(value.nextSequence) || value.nextSequence <= 0 || !Array.isArray(value.records)) return false;
        const ids = new Set<string>(); const seqs = new Set<number>();
        for (const r of value.records) {
            if (!r || typeof r.id !== 'string' || ids.has(r.id) || !Number.isInteger(r.sequence) || r.sequence <= 0 || r.sequence >= value.nextSequence || seqs.has(r.sequence) ||
                typeof r.createdAt !== 'string' || !['open', 'done', 'reverted'].includes(r.status) || typeof r.gdsPath !== 'string') return false;
            if (!validateAnnotations(r.beforeAnnotations || []) || !validateAnnotations(r.afterAnnotations || [])) return false;
            if (r.history !== undefined && (!Array.isArray(r.history) || r.history.some((entry: any) =>
                !entry || !['created', 'start', 'done', 'reverted', 'comment'].includes(entry.event) || typeof entry.timestamp !== 'string' ||
                !['open', 'done', 'reverted'].includes(entry.status) || (entry.note !== undefined && typeof entry.note !== 'string')))) return false;
            if (r.comments !== undefined && (!Array.isArray(r.comments) || r.comments.some((c: any) =>
                !c || typeof c.id !== 'string' || typeof c.text !== 'string' || !c.text.trim() || c.text.length > 10000 || typeof c.createdAt !== 'string') ||
                new Set(r.comments.map((c: any) => c.id)).size !== r.comments.length)) return false;
            if (r.sourceReceipts !== undefined && (!Array.isArray(r.sourceReceipts) || r.sourceReceipts.some((receipt: any) =>
                !receipt || typeof receipt.path !== 'string' || typeof receipt.beforeText !== 'string' ||
                receipt.beforeHash !== digest(receipt.beforeText) || (receipt.afterHash !== undefined && !/^[0-9a-f]{64}$/.test(receipt.afterHash))))) return false;
            ids.add(r.id); seqs.add(r.sequence);
        }
        return true;
    }

    private assertReady(): void { if (!this.valid) throw new Error('Instruction queue is malformed or unavailable; repair it before writing.'); }
    private assertUnchanged(): void {
        if (!fs.existsSync(this.file)) { if (this.fingerprint !== null) throw new Error('Instruction queue changed externally; reload before writing.'); return; }
        const current = digest(fs.readFileSync(this.file, 'utf8'));
        if (current !== this.fingerprint) throw new Error('Instruction queue changed externally; reload before writing.');
    }
    private save(): void {
        this.assertReady();
        this.assertUnchanged();
        const dir = path.dirname(this.file);
        fs.mkdirSync(dir, { recursive: true });
        const text = JSON.stringify(this.store, null, 2) + '\n';
        const temp = path.join(dir, `.instructions.${process.pid}.${crypto.randomUUID()}.tmp`);
        const lock = path.join(dir, '.instructions.lock');
        let fd: number;
        try { fd = fs.openSync(lock, 'wx'); }
        catch (error: any) { if (error.code === 'EEXIST') throw new Error('Instruction journal is busy or has an interrupted writer (.instructions.lock); retry after the writer finishes.'); throw error; }
        try {
            fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
            this.assertUnchanged();
            fs.writeFileSync(temp, text, { encoding: 'utf8', flag: 'wx' }); fs.renameSync(temp, this.file);
        } finally {
            try { fs.closeSync(fd); } catch { /* retain the save outcome */ }
            try { fs.unlinkSync(lock); } catch { console.warn('Instruction journal lock could not be released; inspect .instructions.lock before further writes.'); }
            try { if (fs.existsSync(temp)) fs.unlinkSync(temp); } catch { /* preserve primary error */ }
        }
        this.fingerprint = digest(text);
    }
    public reload(): boolean { this.load(); return this.valid; }
    public list(gdsPath?: string): readonly InstructionRecord[] {
        this.assertReady();
        const records = gdsPath === undefined ? this.store.records : this.store.records.filter(r => this.gdsIdentity(r.gdsPath) === this.gdsIdentity(gdsPath));
        return records.slice().sort((a, b) => a.sequence - b.sequence).map(r => freeze(clone(r)));
    }
    private gdsIdentity(gdsPath: string): string {
        const resolved = path.resolve(this.root, gdsPath);
        const normalized = resolved.replace(/[\\/]+/g, '/');
        return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
    }
    private appendHistory(record: InstructionRecord, event: InstructionHistoryEvent, status: InstructionStatus, note?: string): void {
        const entry: InstructionHistoryEntry = { event, timestamp: new Date().toISOString(), status };
        if (note !== undefined) entry.note = String(note);
        if (!record.history) record.history = [];
        record.history.push(entry);
    }
    public get(id: string): InstructionRecord | undefined {
        this.assertReady();
        const record = this.store.records.find(r => r.id === id);
        return record ? freeze(clone(record)) : undefined;
    }
    public add(input: InstructionInput): InstructionRecord {
        this.assertReady();
        this.assertUnchanged();
        if (!input || typeof input.gdsPath !== 'string' || !input.gdsPath) throw new TypeError('gdsPath is required');
        const sequence = this.store.nextSequence;
        const uuid = crypto.randomUUID();
        const components = Array.isArray(input.components) ? input.components : [];
        const context = selectionDocument(input.gdsPath, input.gdsHash, components, input.topCell, { request: input.request, catalog: input.catalog, generatingScript: input.generatingScript, runtime: input.runtime });
        const sourceReceipts = this.captureBefore(input.sourceFiles || [], input.generatingScript);
        // The catalog resolves referenced targets, but unrelated layout geometry is not a request payload.
        const { catalog: _catalog, ...snapshot } = input;
        const record: InstructionRecord = {
            ...clone(snapshot), components: clone(components), beforeAnnotations: clone(input.beforeAnnotations || []), afterAnnotations: clone(input.afterAnnotations || []),
            id: `INS-${String(sequence).padStart(6, '0')}-${uuid.slice(0, 8)}`, sequence, createdAt: new Date().toISOString(), status: 'open', context,
            ...(sourceReceipts.length ? { sourceReceipts, startedAt: new Date().toISOString() } : {})
        };
        record.history = [{ event: 'created', timestamp: record.createdAt, status: 'open' }];
        if (record.startedAt) record.history.push({ event: 'start', timestamp: record.startedAt, status: 'open' });
        const prior = this.store.records.slice(); const priorNext = this.store.nextSequence;
        try { this.store.nextSequence++; this.store.records.push(record); this.save(); } catch (error) { this.store.records = prior; this.store.nextSequence = priorNext; throw error; }
        return freeze(clone(record));
    }
    private captureBefore(files: string[], generatingScript?: string): SourceReceipt[] {
        return this.resolveSourceFiles(files, generatingScript).map(file => { const text = readUtf8(file); return { path: file, beforeHash: digest(text), beforeText: text }; });
    }
    private resolveSourceFiles(files: string[], generatingScript?: string): string[] {
        const root = path.resolve(this.root), exact = generatingScript ? path.resolve(generatingScript) : '';
        const rootReal = fs.realpathSync(this.root);
        return [...new Set(files)].map(raw => {
            const file = path.resolve(raw); const inside = file === root || file.startsWith(root + path.sep);
            if (!fs.statSync(file).isFile()) throw new Error(`Source receipt requires an explicit file: ${raw}`);
            const real = fs.realpathSync(file); const exactReal = exact && fs.existsSync(exact) ? fs.realpathSync(exact) : exact;
            const realInside = real === rootReal || real.startsWith(rootReal + path.sep);
            if ((!inside || !realInside) && real !== exactReal) throw new Error(`Source file is outside the project root: ${raw}`);
            const size = fs.statSync(file).size; if (size > 10 * 1024 * 1024) throw new Error(`Source file is too large: ${raw}`);
            return file;
        });
    }
    public captureAfter(id: string, note?: string, options: { override?: boolean } = {}): InstructionRecord {
        this.assertReady(); this.assertUnchanged(); const record = this.store.records.find(r => r.id === id);
        if (!record) throw new Error(`Unknown instruction ${id}`); if (record.status !== 'open') throw new Error('Only open instructions can be completed.');
        this.assertFifo(record, options.override);
        const receipts = record.sourceReceipts || []; const updated = receipts.map(r => ({ ...r, afterHash: digest(readUtf8(r.path)) }));
        const old = clone(record); record.sourceReceipts = updated; record.status = 'done'; if (note !== undefined) record.note = String(note);
        this.appendHistory(record, 'done', 'done', note);
        try { this.save(); } catch (e) { this.restoreRecord(record, old); throw e; }
        return freeze(clone(record));
    }
    public start(id: string, files: string[]): InstructionRecord {
        this.assertReady(); this.assertUnchanged(); const record = this.store.records.find(r => r.id === id);
        if (!record) throw new Error(`Unknown instruction ${id}`); if (record.status !== 'open') throw new Error('Only open instructions can be started.');
        this.assertFifo(record, false);
        if (record.sourceReceipts?.length) throw new Error('Instruction already has source receipts; refusing to overwrite them.');
        if (!files.length) throw new Error('Start requires at least one explicit source file.');
        const receipts = this.captureBefore(files, record.generatingScript); const old = clone(record);
        record.sourceReceipts = receipts; record.startedAt = new Date().toISOString();
        this.appendHistory(record, 'start', 'open');
        try { this.save(); } catch (error) { this.restoreRecord(record, old); throw error; }
        return freeze(clone(record));
    }
    private assertFifo(record: InstructionRecord, override = false): void {
        const identity = this.gdsIdentity(record.gdsPath);
        const earlier = this.store.records.find(r => r.sequence < record.sequence && r.status === 'open' && this.gdsIdentity(r.gdsPath) === identity);
        if (!override && earlier) throw new Error(`FIFO violation: complete ${earlier.id} (${earlier.gdsPath}) first.`);
    }
    public setStatus(id: string, status: InstructionStatus, note?: string, options: { override?: boolean } = {}): InstructionRecord {
        this.assertReady();
        this.assertUnchanged();
        if (!['open', 'done', 'reverted'].includes(status)) throw new TypeError('Invalid instruction status');
        const record = this.store.records.find(r => r.id === id);
        if (!record) throw new Error(`Unknown instruction ${id}`);
        if (status === 'open' || record.status === 'reverted' || record.status === status) throw new Error('Invalid status transition: terminal work orders cannot be reopened or completed twice.');
        if (status === 'done') return this.captureAfter(id, note, options);
        const old = clone(record); record.status = status;
        if (note !== undefined) record.note = String(note);
        this.appendHistory(record, status, status, note);
        try { this.save(); } catch (error) { this.restoreRecord(record, old); throw error; }
        return freeze(clone(record));
    }
    private restoreRecord(record: InstructionRecord, before: InstructionRecord): void {
        for (const key of Object.keys(record)) delete (record as any)[key];
        Object.assign(record, before);
    }
    public comment(id: string, text: string): InstructionRecord {
        this.assertReady(); this.assertUnchanged();
        const record = this.store.records.find(r => r.id === id);
        if (!record) throw new Error(`Unknown instruction ${id}`);
        if (typeof text !== 'string' || !text.trim() || text.length > 10000) throw new Error('Comment must contain 1 to 10000 characters.');
        const before = clone(record);
        const comment = { id: crypto.randomUUID(), text: text.trim(), createdAt: new Date().toISOString() };
        (record.comments ||= []).push(comment);
        this.appendHistory(record, 'comment', record.status, comment.text);
        try { this.save(); } catch (error) { this.restoreRecord(record, before); throw error; }
        return freeze(clone(record));
    }
    public revertSources(id: string, note?: string): InstructionRecord {
        this.assertReady(); this.assertUnchanged(); const record = this.store.records.find(r => r.id === id);
        if (!record) throw new Error(`Unknown instruction ${id}`); if (record.status !== 'done') throw new Error('Only done instructions can be reverted.');
        const receipts = record.sourceReceipts || []; if (!receipts.length || receipts.some(r => !r.afterHash)) throw new Error('No complete source receipts available for revert.');
        this.resolveSourceFiles(receipts.map(r => r.path), record.generatingScript);
        for (const r of receipts) if (digest(readUtf8(r.path)) !== r.afterHash) throw new Error(`Source changed after completion: ${r.path}`);
        const originals = receipts.map(r => ({ path: r.path, text: readUtf8(r.path) }));
        try { receipts.forEach(r => this.atomicText(r.path, r.beforeText)); } catch (error) { return this.restoreSourcesAfterFailure(originals, error); }
        try { return this.setStatus(id, 'reverted', note); }
        catch (error) { return this.restoreSourcesAfterFailure(originals, error); }
    }
    private restoreSourcesAfterFailure(originals: { path: string; text: string }[], cause: unknown): never {
        const failed: string[] = [];
        for (const original of originals) {
            try { this.atomicText(original.path, original.text); } catch { failed.push(original.path); }
        }
        if (failed.length) throw new Error(`${cause instanceof Error ? cause.message : String(cause)}. Source rollback incomplete; review these files before continuing: ${failed.join(', ')}`);
        throw cause;
    }
    private atomicText(file: string, text: string): void {
        const temp = `${file}.gds-navigator-${process.pid}-${crypto.randomUUID()}.tmp`;
        try { fs.writeFileSync(temp, text, 'utf8'); fs.renameSync(temp, file); } finally { try { if (fs.existsSync(temp)) fs.unlinkSync(temp); } catch { /* preserve primary error */ } }
    }
}
