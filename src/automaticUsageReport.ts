import { mkdir, rename, unlink, writeFile } from 'fs/promises';
import * as path from 'path';
import { generateUsageReport, UsageReport } from './usageReport';

export interface AutomaticUsageReportOptions {
    delayMs?: number;
    onError?: (message: string) => void;
    generate?: (projectRoot: string) => Promise<UsageReport>;
}
type ReportGenerator = (projectRoot: string) => Promise<UsageReport>;

/** Keeps the local usage report current without involving an AI or a command. */
export class AutomaticUsageReport {
    private readonly root: string;
    private readonly delayMs: number;
    private readonly onError?: (message: string) => void;
    private readonly generate: ReportGenerator;
    private timer: NodeJS.Timeout | undefined;
    private dirty = false;
    private disposed = false;
    private running: Promise<void> | undefined;
    private serial = 0;

    public constructor(root: string, options: AutomaticUsageReportOptions = {}) {
        this.root = path.resolve(root);
        this.delayMs = options.delayMs === undefined ? 10_000 : Math.max(0, options.delayMs);
        if (!Number.isFinite(this.delayMs)) throw new TypeError('Automatic usage report delay must be finite');
        this.onError = options.onError;
        this.generate = options.generate || generateUsageReport;
    }

    public changed(): void {
        if (this.disposed) return;
        this.dirty = true;
        if (!this.timer && !this.running) this.schedule();
    }

    public async flush(): Promise<void> {
        if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
        await this.start();
    }

    public async dispose(): Promise<void> {
        this.disposed = true;
        if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
        await this.start();
    }

    private schedule(): void {
        const timer = setTimeout(() => {
            this.timer = undefined;
            void this.start();
        }, this.delayMs);
        timer.unref?.();
        this.timer = timer;
    }

    private start(): Promise<void> {
        if (this.running) return this.running;
        if (!this.dirty) return Promise.resolve();
        this.running = this.drain().finally(() => { this.running = undefined; });
        return this.running;
    }

    private async drain(): Promise<void> {
        while (this.dirty) {
            this.dirty = false;
            try {
                const report = await this.generate(this.root);
                await this.persist(report);
            } catch (error) {
                this.dirty = true;
                this.report(error);
                return;
            }
        }
    }

    private async persist(report: UsageReport): Promise<void> {
        const directory = path.join(this.root, '.gds-navigator');
        await mkdir(directory, { recursive: true });
        await this.atomicWrite(path.join(directory, 'usage-report.md'), report.markdown);
        await this.atomicWrite(path.join(directory, 'usage-report.json'), JSON.stringify(report.summary, null, 2) + '\n');
    }

    private async atomicWrite(target: string, content: string): Promise<void> {
        const temporary = `${target}.tmp-${process.pid}-${++this.serial}-${Math.random().toString(36).slice(2)}`;
        try {
            await writeFile(temporary, content, 'utf8');
            await rename(temporary, target);
        } finally {
            await unlink(temporary).catch(() => undefined);
        }
    }

    private report(error: unknown): void {
        try { this.onError?.(error instanceof Error ? error.message : String(error)); } catch { /* error reporting must never throw */ }
    }
}
