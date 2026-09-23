import * as vscode from 'vscode';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export interface RunResult {
    ok: boolean;
    /** The single new or modified .gds produced by this script run. */
    gdsPath?: string;
    reason?: string;
    candidates?: string[];
    diagnostics?: Record<string, unknown>;
}

export interface RunOptions {
    timeoutMs?: number;
    maxOutputBytes?: number;
    signal?: AbortSignal;
}

/**
 * Runs a user Python script with GDS_PROVENANCE=1 so the gdsfactory fork
 * writes the provenance sidecar, then detects outputs changed by this run.
 * Ported from superGDS Studio lib/pythonRunner.ts.
 *
 * The script is executed through a runpy wrapper that (a) pre-activates the
 * generic PDK — the provenance fork refuses to build without an active PDK
 * and many layout scripts don't call activate() themselves (a script's own
 * activation simply overrides this) — and (b) keeps __file__ pointing at the
 * real script so provenance records the true path.
 */
const RUN_WRAPPER = [
    'import sys, os, builtins, io, json, hashlib, functools',
    'from pathlib import Path',
    'AUDIT = os.environ.get("GDS_NAV_AUDIT_FILE")',
    'def _fp(value):',
    '    try:',
    '        p = os.path.abspath(os.fspath(value))',
    '        if not os.path.isfile(p): return {"exists": False}',
    '        st = os.stat(p); h = hashlib.sha256()',
    '        with _raw_open(p, "rb") as f:',
    '            for chunk in iter(lambda: f.read(1024 * 1024), b""): h.update(chunk)',
    '        return {"exists": True, "size": st.st_size, "mtimeMs": st.st_mtime_ns / 1000000, "sha256": h.hexdigest()}',
    '    except Exception: return {"exists": False}',
    'def _record(kind, value, before=None, after=None):',
    '    if not AUDIT: return',
    '    try:',
    '        p = os.path.abspath(os.fspath(value))',
    '        if not p.lower().endswith(".gds"): return',
    '        row = {"kind": kind, "path": p, "before": before if before is not None else _fp(p), "after": after if after is not None else _fp(p)}',
    '        with _raw_open(AUDIT, "a", encoding="utf-8") as audit: audit.write(json.dumps(row, separators=(",", ":")) + "\\n")',
    '    except Exception: pass',
    '_raw_open = builtins.open',
    'class _AuditFile:',
    '    def __init__(self, file, mode, handle, before): self.file, self.mode, self.handle, self.before = file, mode, handle, before; self.done = False',
    '    def __getattr__(self, name): return getattr(self.handle, name)',
    '    def write(self, *args): result = self.handle.write(*args); self.flush(); return result',
    '    def writelines(self, *args): result = self.handle.writelines(*args); self.flush(); return result',
    '    def flush(self): self.handle.flush(); _record("open", self.file, self.before, _fp(self.file))',
    '    def __enter__(self): self.handle.__enter__(); return self',
    '    def __exit__(self, *args): self.handle.__exit__(*args); self.close()',
    '    def close(self):',
    '        if not self.done:',
    '            self.done = True; self.handle.close(); _record("open", self.file, self.before, _fp(self.file))',
    '        return None',
    '    def __del__(self):\n        try: self.close()\n        except Exception: pass',
    'def _audit_open(opener, file, mode="r", *args, **kwargs):',
    '    write = any(c in mode for c in "wax+") if isinstance(mode, str) else False',
    '    if not write: return opener(file, mode, *args, **kwargs)',
    '    try: p = os.path.abspath(os.fspath(file))',
    '    except Exception: return opener(file, mode, *args, **kwargs)',
    '    handle = opener(file, mode, *args, **kwargs)',
    '    return _AuditFile(file, mode, handle, _fp(p)) if p.lower().endswith(".gds") else handle',
    'builtins.open = functools.partial(_audit_open, _raw_open)',
    'io.open = functools.partial(_audit_open, io.open)',
    '_raw_rename, _raw_replace, _raw_os_open, _raw_os_close = os.rename, os.replace, os.open, os.close',
    'def _rename(src, dst, *args):',
    '    sb, db = _fp(src), _fp(dst); result = _raw_rename(src, dst, *args); _record("rename", src, sb, _fp(src)); _record("rename", dst, db, _fp(dst)); return result',
    'def _replace(src, dst, *args):',
    '    sb, db = _fp(src), _fp(dst); result = _raw_replace(src, dst, *args); _record("replace", src, sb, _fp(src)); _record("replace", dst, db, _fp(dst)); return result',
    'os.rename, os.replace = _rename, _replace',
    '_fds = {}',
    'def _os_open(file, flags, mode=0o777, *, dir_fd=None):',
    '    fd = _raw_os_open(file, flags, mode, dir_fd=dir_fd) if dir_fd is not None else _raw_os_open(file, flags, mode)',
    '    if flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND):',
    '        try:',
    '            p = os.path.abspath(os.fspath(file))',
    '            if p.lower().endswith(".gds"): _fds[fd] = (p, _fp(p))',
    '        except Exception: pass',
    '    return fd',
    'def _os_close(fd):',
    '    tracked = _fds.pop(fd, None); result = _raw_os_close(fd)',
    '    if tracked: _record("os.open", tracked[0], tracked[1], _fp(tracked[0]))',
    '    return result',
    'os.open, os.close = _os_open, _os_close',
    'try: import gdsfactory as gf',
    'except Exception: gf = None',
    'try: gf.gpdk.PDK.activate() if gf else None',
    'except Exception: pass',
    'try:',
    '    _component = getattr(gf, "Component", None)',
    '    _write_gds = getattr(_component, "write_gds", None) if _component else None',
    '    if _write_gds:',
    '        def _audited_write_gds(self, *args, **kwargs):',
    '            result_path = kwargs.get("gdspath") or (args[0] if args and isinstance(args[0], (str, bytes, os.PathLike)) else None)',
    '            before = _fp(result_path) if result_path else None',
    '            result = _write_gds(self, *args, **kwargs)',
    '            returned = result if isinstance(result, (str, bytes, os.PathLike)) else result_path',
    '            if returned: _record("component.write_gds", returned, before, _fp(returned))',
    '            return result',
    '        _component.write_gds = _audited_write_gds',
    'except Exception: pass',
    "sys.path.insert(0, os.path.dirname(os.path.abspath(sys.argv[1])))",
    'import runpy',
    'script_path = sys.argv[1]',
    'sys.argv = [script_path]',
    'runpy.run_path(script_path, run_name="__main__")',
].join('\n');

export function runPythonScript(
    pythonPath: string,
    scriptPath: string,
    cwd: string,
    output: vscode.OutputChannel,
    options: RunOptions = {}
): Promise<RunResult> {
    return new Promise((resolve) => {
        const timeoutMs = Number.isFinite(options.timeoutMs) && (options.timeoutMs || 0) > 0 ? options.timeoutMs! : 15 * 60 * 1000;
        const maxOutputBytes = Number.isFinite(options.maxOutputBytes) && (options.maxOutputBytes || 0) > 0 ? options.maxOutputBytes! : 8 * 1024 * 1024;
        let before = new Map<string, string>();
        let settled = false;
        let timer: NodeJS.Timeout | undefined;
        let terminationTimer: NodeJS.Timeout | undefined;
        let terminationResult: RunResult | undefined;
        let removeAbort = () => {};
        let auditDir: string | undefined;
        let auditFile: string | undefined;
        const finish = (result: RunResult) => { if (settled) return; settled = true; if (timer) clearTimeout(timer); if (terminationTimer) clearTimeout(terminationTimer); removeAbort(); if (auditDir) void fs.promises.rm(auditDir, { recursive: true, force: true }).catch(() => {}); resolve(result); };
        const snapshot = async () => {
            before = await snapshotGds(cwd);
            auditDir = await fs.promises.mkdtemp(path.join(require('os').tmpdir(), 'gds-nav-audit-'));
            auditFile = path.join(auditDir, 'writes.jsonl');
        };
        void snapshot().then(() => {
        if (options.signal?.aborted) { finish({ ok: false, reason: 'Python build cancelled' }); return; }
        output.show(true);
        output.appendLine(`> ${pythonPath} ${scriptPath}  (GDS_PROVENANCE=1, cwd: ${cwd})`);

        const proc = spawn(pythonPath, ['-c', RUN_WRAPPER, scriptPath], {
            cwd,
            env: { ...process.env, GDS_PROVENANCE: '1', GDS_NAV_AUDIT_FILE: auditFile },
            windowsHide: true,
        });
        output.appendLine(`[run] spawn pid pending: ${pythonPath} (cwd: ${cwd})`);
        proc.on('spawn', () => output.appendLine(`[run] started, pid ${proc.pid}`));
        proc.on('error', (err) => output.appendLine(`[run] spawn error: ${err.message}`));

        let outputBytes = 0;
        const terminate = () => { if (process.platform === 'win32' && proc.pid) spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true }); else proc.kill(); };
        const requestTermination = (result: RunResult) => { if (settled || terminationResult) return; terminationResult = result; terminate(); terminationTimer = setTimeout(() => finish(result), 2000); };
        const overflow = () => { output.appendLine('[run] output limit exceeded; terminating Python'); requestTermination({ ok: false, reason: 'Python output exceeded the configured limit' }); };
        proc.stdout.on('data', (d: Buffer) => {
            outputBytes += d.byteLength; if (outputBytes > maxOutputBytes) { overflow(); return; }
            for (const line of d.toString().split('\n')) {
                if (line.trim()) {
                    output.appendLine(line);
                }
            }
        });
        let stderrTail = '';
        proc.stderr.on('data', (d: Buffer) => {
            outputBytes += d.byteLength; if (outputBytes > maxOutputBytes) { overflow(); return; }
            const text = d.toString();
            stderrTail = (stderrTail + text).slice(-2000);
            for (const line of text.split('\n')) {
                if (line.trim()) {
                    output.appendLine(`[stderr] ${line}`);
                }
            }
        });

        proc.on('error', (err) => {
            if (terminationResult) return;
            vscode.window.showErrorMessage(`GDS Navigator: failed to start Python: ${err.message}`);
            finish({ ok: false, reason: `Failed to start Python: ${err.message}` });
        });

        timer = setTimeout(() => { output.appendLine(`[run] timed out after ${timeoutMs} ms`); requestTermination({ ok: false, reason: `Python build timed out after ${Math.round(timeoutMs / 1000)}s` }); }, timeoutMs);
        const abort = () => requestTermination({ ok: false, reason: 'Python build cancelled' });
        if (options.signal) { removeAbort = () => options.signal!.removeEventListener('abort', abort); if (options.signal.aborted) abort(); else options.signal.addEventListener('abort', abort, { once: true }); }

        proc.on('close', async (code) => {
            output.appendLine(`[run] exited with code ${code}`);
            if (terminationResult) { finish(terminationResult); return; }
            if (code !== 0) {
                output.appendLine(`Script exited with code ${code}`);
                const missing = stderrTail.match(/ModuleNotFoundError: No module named ['"]([^'"\r\n]+)['"]/);
                const reason = missing
                    ? `Python ${pythonPath} is missing module "${missing[1]}" required by this script. Use GDS: Set Up Project Environment to choose the intended environment, or add this dependency there.`
                    : `Script exited with code ${code}`;
                vscode.window.showErrorMessage(
                    `GDS Navigator: ${reason}. See GDS Navigator output for details.`
                );
                finish({ ok: false, reason });
                return;
            }
            try {
                const changed = await findAuditedChangedGds(cwd, before, auditFile);
                if (changed.length !== 1) {
                    const reason = changed.length === 0 ? 'Python build produced no new or modified GDS file' : `Python build produced multiple GDS files (${changed.length}); choose an explicit output`;
                    finish({ ok: false, reason, candidates: changed });
                    return;
                }
                finish({ ok: true, gdsPath: changed[0], candidates: changed });
            } catch (err: any) { finish({ ok: false, reason: `Could not inspect build outputs: ${err?.message || err}` }); }
        });
        }).catch((err) => finish({ ok: false, reason: `Could not inspect build outputs: ${err.message}` }));
    });
}

async function snapshotGds(dir: string): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    async function walk(current: string): Promise<void> {
        let entries: fs.Dirent[]; try { entries = await fs.promises.readdir(current, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) { if (entry.name.startsWith('.') || entry.name === 'node_modules') continue; const full = path.join(current, entry.name); if (entry.isDirectory()) await walk(full); else if (entry.name.toLowerCase().endsWith('.gds')) { try { const s = await fs.promises.stat(full); const hash = await sha256File(full); result.set(path.resolve(full), `${s.size}:${s.mtimeMs}:${hash}`); } catch { /* race */ } } }
    }
    await walk(dir); return result;
}

export async function findChangedGds(dir: string, before: Map<string, string> = new Map()): Promise<string[]> {
    const after = await snapshotGds(dir); const changed: string[] = [];
    for (const [file, fingerprint] of after) if (!sameFingerprint(before.get(file), fingerprint)) changed.push(file);
    return changed.sort();
}

async function sha256File(file: string): Promise<string> {
    const hash = require('crypto').createHash('sha256');
    const stream = fs.createReadStream(file);
    for await (const chunk of stream) hash.update(chunk as Buffer);
    return hash.digest('hex');
}

function sameFingerprint(before: string | undefined, after: string): boolean {
    if (!before) return false;
    if (before === after) return true;
    // Keep compatibility with callers that supplied the historical size:mtime map.
    const old = before.split(':'); const current = after.split(':');
    return old.length === 2 && current.length >= 2 && old[0] === current[0] && old[1] === current[1];
}

interface AuditRow { path?: string; before?: { exists?: boolean; sha256?: string; size?: number; mtimeMs?: number }; after?: { exists?: boolean; sha256?: string; size?: number; mtimeMs?: number }; }

async function findAuditedChangedGds(dir: string, before: Map<string, string>, auditFile?: string): Promise<string[]> {
    const candidates = new Set(await findChangedGds(dir, before));
    if (auditFile) {
        let text = '';
        try { text = await fs.promises.readFile(auditFile, 'utf8'); } catch { /* cwd fallback remains authoritative */ }
        for (const line of text.split(/\r?\n/)) {
            if (!line.trim()) continue;
            try {
                const row = JSON.parse(line) as AuditRow;
                if (!row.path || !row.path.toLowerCase().endsWith('.gds') || !row.after?.exists) continue;
                const resolved = path.resolve(row.path);
                if (!row.before?.exists || row.before.sha256 !== row.after.sha256 || row.before.size !== row.after.size || row.before.mtimeMs !== row.after.mtimeMs) candidates.add(resolved);
            } catch { /* malformed audit rows are not evidence */ }
        }
    }
    const existing: string[] = [];
    for (const candidate of candidates) { try { if ((await fs.promises.stat(candidate)).isFile()) existing.push(candidate); } catch { /* disappeared output */ } }
    return existing.sort();
}

/** Recursively find the most recently modified .gds under `dir`. */
export async function findNewestGds(dir: string): Promise<string | undefined> {
    let newest: string | undefined;
    let newestMtime = 0;

    async function walk(current: string): Promise<void> {
        let entries: fs.Dirent[];
        try {
            entries = await fs.promises.readdir(current, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            if (entry.name.startsWith('.') || entry.name === 'node_modules') {
                continue;
            }
            const full = path.join(current, entry.name);
            if (entry.isDirectory()) {
                await walk(full);
            } else if (entry.name.toLowerCase().endsWith('.gds')) {
                try {
                    const stat = await fs.promises.stat(full);
                    if (stat.mtimeMs > newestMtime) {
                        newestMtime = stat.mtimeMs;
                        newest = full;
                    }
                } catch {
                    // skip unreadable files
                }
            }
        }
    }

    await walk(dir);
    return newest;
}
