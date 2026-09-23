import * as vscode from 'vscode';
import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { readProjectEnvironment, saveProjectEnvironment } from './projectEnvironment';

export interface CondaEnv { name: string; prefix: string; }
export interface PythonDiagnostics {
    executable: string; prefix?: string; basePrefix?: string; pythonVersion?: string;
    gdsfactory?: { path?: string; version?: string; error?: string };
    klayout?: { path?: string; error?: string };
    provenance?: { available?: boolean; error?: string };
    forkRevision?: string; forkDirty?: boolean; packageErrors?: Record<string, string>; error?: string;
}

// Imports may print warnings. Only our tagged record is interpreted as diagnostics.
export function inspectPython(pythonPath: string, timeoutMs = 12_000): Promise<PythonDiagnostics> {
    const code = `import json, pathlib, subprocess, sys
out = {"executable": sys.executable, "prefix": sys.prefix, "basePrefix": sys.base_prefix, "pythonVersion": sys.version.split()[0], "packageErrors": {}}
try:
 import gdsfactory as gf
 out["gdsfactory"] = {"path": gf.__file__, "version": getattr(gf, "__version__", None)}
except Exception as e:
 out["gdsfactory"] = {"error": str(e)}
 out["packageErrors"]["gdsfactory"] = str(e)
try:
 import klayout.db as db
 out["klayout"] = {"path": db.__file__}
except Exception as e:
 out["klayout"] = {"error": str(e)}
 out["packageErrors"]["klayout"] = str(e)
try:
 from gdsfactory.provenance import ProvenanceTracker
 out["provenance"] = {"available": callable(getattr(ProvenanceTracker, "write_sidecar", None))}
except Exception as e:
 out["provenance"] = {"available": False, "error": str(e)}
 out["packageErrors"]["provenance"] = str(e)
try:
 module_path = out.get("gdsfactory", {}).get("path")
 if module_path:
  root = pathlib.Path(module_path).resolve().parent.parent
  if (root / ".git").exists():
   out["forkRevision"] = subprocess.check_output(["git", "-C", str(root), "rev-parse", "HEAD"], text=True, stderr=subprocess.DEVNULL, timeout=2).strip()
   out["forkDirty"] = bool(subprocess.check_output(["git", "-C", str(root), "status", "--porcelain"], text=True, stderr=subprocess.DEVNULL, timeout=2).strip())
except Exception: pass
print("GDS_NAV_DIAGNOSTICS=" + json.dumps(out))`;
    return new Promise(resolve => {
        const proc = spawn(pythonPath, ['-c', code], { windowsHide: true });
        let stdout = '', bytes = 0, settled = false;
        const finish = (value: PythonDiagnostics) => {
            if (settled) return;
            settled = true; clearTimeout(timer); resolve(value);
        };
        const timer = setTimeout(() => { proc.kill(); finish({ executable: pythonPath, error: 'Python diagnostics timed out' }); }, timeoutMs);
        const consume = (d: Buffer, retain: boolean) => {
            bytes += d.length;
            if (bytes > 256 * 1024) { proc.kill(); finish({ executable: pythonPath, error: 'Python diagnostics output limit exceeded' }); }
            else if (retain) stdout += d.toString();
        };
        proc.stdout.on('data', d => consume(d, true));
        proc.stderr.on('data', d => consume(d, false));
        proc.on('error', error => finish({ executable: pythonPath, error: error.message }));
        proc.on('close', exit => {
            if (exit !== 0) return finish({ executable: pythonPath, error: `Python exited with code ${exit}` });
            try {
                const record = stdout.split(/\r?\n/).find(line => line.startsWith('GDS_NAV_DIAGNOSTICS='));
                if (!record) throw new Error('missing record');
                finish(JSON.parse(record.slice('GDS_NAV_DIAGNOSTICS='.length)));
            } catch { finish({ executable: pythonPath, error: 'Invalid diagnostics JSON' }); }
        });
    });
}

export function pythonInPrefix(prefix: string): string {
    if (process.platform !== 'win32') return path.join(prefix, 'bin', 'python');
    const venv = path.join(prefix, 'Scripts', 'python.exe');
    return fs.existsSync(venv) ? venv : path.join(prefix, 'python.exe');
}

export async function discoverPythonCandidates(_context: vscode.ExtensionContext): Promise<string[]> {
    const out: string[] = [];
    const add = (value?: string) => { if (value && !out.includes(value)) out.push(value); };
    const folders = vscode.workspace.workspaceFolders || [];
    for (const folder of folders) {
        for (const name of ['.venv-fork', '.venv', 'venv']) add(pythonInPrefix(path.join(folder.uri.fsPath, name)));
    }
    let configured = vscode.workspace.getConfiguration('python').get<string>('defaultInterpreterPath', '');
    configured = configured.replace(/\$\{workspaceFolder\}/g, folders[0]?.uri.fsPath || '');
    if (configured) {
        try { add(fs.statSync(configured).isDirectory() ? pythonInPrefix(configured) : configured); } catch { /* absent */ }
    }
    for (const prefix of [process.env.VIRTUAL_ENV, process.env.CONDA_PREFIX]) if (prefix) add(pythonInPrefix(prefix));
    try {
        const file = path.join(process.env.USERPROFILE || process.env.HOME || '', '.conda', 'environments.txt');
        if (fs.statSync(file).size <= 64 * 1024) {
            for (const prefix of fs.readFileSync(file, 'utf8').split(/\r?\n/).slice(0, 32)) if (prefix.trim()) add(pythonInPrefix(prefix.trim()));
        }
    } catch { /* optional Conda registry */ }
    return out.filter(value => fs.existsSync(value)).slice(0, 24);
}

const MANUAL_KEY = 'gdsNavigator.pythonPath';
export class EnvProvider {
    private statusBar: vscode.StatusBarItem;
    private automatic?: { python: string; provenance: boolean };
    private detection?: Promise<void>;
    private generation = 0;
    private detected = false;
    private selecting = false;
    private manualOverride?: string;
    private setupPromises = new Map<string, Promise<void>>();
    private promptedRoots = new Set<string>();
    private activeFile?: string;
    private readonly probe: (python: string, timeoutMs?: number) => Promise<PythonDiagnostics>;
    constructor(private context: vscode.ExtensionContext, private options?: {
        probe?: (python: string, timeoutMs?: number) => Promise<PythonDiagnostics>;
        discover?: () => Promise<string[]>;
    }) {
        this.probe = options?.probe || inspectPython;
        this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90);
        this.statusBar.command = 'gdsNavigator.selectPythonEnv';
        context.subscriptions.push(this.statusBar, vscode.workspace.onDidChangeConfiguration(event => {
            if (!this.selecting && (event.affectsConfiguration('gdsNavigator.pythonPath') || event.affectsConfiguration('python.defaultInterpreterPath'))) {
                this.manualOverride = undefined;
                this.invalidateAutomatic();
                void this.ready();
            }
        }));
        this.updateStatusBar();
    }
    private config(file?: string) {
        return vscode.workspace.getConfiguration('gdsNavigator', file ? vscode.Uri.file(file) : undefined);
    }
    private folderFor(file?: string): string | undefined {
        return file ? vscode.workspace.getWorkspaceFolder?.(vscode.Uri.file(file))?.uri.fsPath || path.dirname(file)
            : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    }
    private explicit(file?: string): string {
        if (file) {
            const configured = this.config(file).get<string>('pythonPath', '').trim();
            const root = this.folderFor(file);
            const saved = root ? readProjectEnvironment(root) : undefined;
            if (configured || saved) return configured || saved!.python;
        }
        return this.manualOverride || this.config().get<string>('pythonPath', '').trim()
            || this.context.workspaceState.get<string>(MANUAL_KEY) || '';
    }
    setActiveFile(file?: string): void { this.activeFile = file; this.updateStatusBar(); }
    getPython(file = this.activeFile): string { return this.explicit(file) || this.automatic?.python || 'python'; }
    ready(file?: string): Promise<void> {
        if (this.explicit(file) || this.detected) return Promise.resolve();
        if (this.detection) return this.detection;
        const generation = this.generation;
        const pending: Promise<void> = this.detect(generation).catch(() => {
            if (generation === this.generation) this.detected = true;
        }).then(async () => {
            // Consumers waiting on a superseded scan must wait for the replacement too.
            if (generation !== this.generation && !this.explicit()) await this.ready();
        }).finally(() => {
            if (this.detection === pending) { this.detection = undefined; this.updateStatusBar(); }
        });
        this.detection = pending; this.updateStatusBar();
        return pending;
    }
    invalidateAutomatic(): void {
        this.generation++; this.automatic = undefined; this.detected = false; this.detection = undefined;
        this.updateStatusBar();
    }
    private async detect(generation: number): Promise<void> {
        const deadline = Date.now() + 30_000;
        const candidates = await (this.options?.discover ? this.options.discover() : discoverPythonCandidates(this.context));
        const seen = new Set<string>();
        let fallback: string | undefined;
        const current = () => generation === this.generation && !this.explicit();
        const tryCandidates = async (values: string[]) => {
            for (const candidate of values) {
                if (!current() || Date.now() >= deadline || seen.size >= 24) return false;
                const key = process.platform === 'win32' ? candidate.toLowerCase() : candidate;
                if (seen.has(key)) continue;
                seen.add(key);
                const d = await this.probe(candidate, Math.max(1, Math.min(12_000, deadline - Date.now())));
                if (!current()) return false;
                if (!d.error && d.klayout?.path && !d.klayout.error) {
                    fallback ||= candidate;
                    if (d.gdsfactory?.path && !d.gdsfactory.error && d.provenance?.available) {
                        this.automatic = { python: candidate, provenance: true }; return true;
                    }
                }
            }
            return false;
        };
        let found = await tryCandidates(candidates);
        if (!found && current() && !this.options?.discover && Date.now() < deadline) {
            const conda = await this.listCondaEnvs(Math.min(3000, deadline - Date.now()));
            found = await tryCandidates([...conda.map(env => pythonInPrefix(env.prefix)).filter(p => fs.existsSync(p)), 'python']);
        }
        if (current()) {
            if (!found && fallback) this.automatic = { python: fallback, provenance: false };
            this.detected = true;
        }
    }
    async setPython(pythonPath: string, file?: string): Promise<void> {
        // Publish the user's choice synchronously before any pending probe returns.
        this.manualOverride = pythonPath; this.invalidateAutomatic(); this.selecting = true;
        try {
            await this.context.workspaceState.update(MANUAL_KEY, pythonPath);
            // A workspace value overrides an older user setting without changing other projects.
            if (file || this.config().get<string>('pythonPath', '')) {
                const folder = file && vscode.workspace.getWorkspaceFolder?.(vscode.Uri.file(file));
                if (folder || !file) await this.config(file).update('pythonPath', pythonPath, folder ? vscode.ConfigurationTarget.WorkspaceFolder : vscode.ConfigurationTarget.Workspace);
            }
        } finally { this.selecting = false; this.updateStatusBar(); }
    }
    async clearManualSelection(file?: string): Promise<void> {
        this.selecting = true;
        try {
            await this.context.workspaceState.update(MANUAL_KEY, undefined);
            // Empty workspace value masks a global manual setting for this workspace only.
            const folder = file && vscode.workspace.getWorkspaceFolder?.(vscode.Uri.file(file));
            await this.config(file).update('pythonPath', '', folder ? vscode.ConfigurationTarget.WorkspaceFolder : vscode.ConfigurationTarget.Workspace);
            this.manualOverride = undefined; this.invalidateAutomatic();
        } finally { this.selecting = false; }
        await this.ready();
        const root = this.folderFor(file);
        if (root && readProjectEnvironment(root)) await this.persistProject(root, file, await this.probe(this.automatic?.python || 'python'));
    }
    private updateStatusBar(): void {
        const mode = this.explicit(this.activeFile) ? 'manual' : this.detection ? 'detecting' : this.automatic?.provenance ? 'auto · provenance'
            : this.automatic ? 'auto · KLayout only' : 'auto · unavailable';
        this.statusBar.text = `$(circuit-board) GDS Python: ${mode}`;
        this.statusBar.tooltip = `Python: ${this.getPython()}\n${mode}\nClick to choose manually or use Automatic.`;
        this.statusBar.show();
    }
    async listCondaEnvs(timeoutMs = 3000): Promise<CondaEnv[]> {
        return new Promise(resolve => {
            const proc = spawn('conda', ['env', 'list', '--json'], { windowsHide: true });
            let out = '', bytes = 0, settled = false;
            const finish = (items: CondaEnv[]) => { if (!settled) { settled = true; clearTimeout(timer); resolve(items); } };
            const timer = setTimeout(() => { proc.kill(); finish([]); }, timeoutMs);
            proc.stdout.on('data', data => { bytes += data.length; if (bytes > 128 * 1024) { proc.kill(); finish([]); } else out += data.toString(); });
            proc.stderr.on('data', () => {});
            proc.on('error', () => finish([]));
            proc.on('close', () => {
                try {
                    const envs = JSON.parse(out).envs;
                    finish(Array.isArray(envs) ? [...new Set(envs.filter((p): p is string => typeof p === 'string'))].slice(0, 32).map(prefix => ({ name: path.basename(prefix), prefix })) : []);
                } catch { finish([]); }
            });
        });
    }
    async pick(file?: string): Promise<void> {
        const local = await discoverPythonCandidates(this.context);
        const conda = await this.listCondaEnvs();
        const paths = [...new Set([this.getPython(file), ...local, ...conda.map(env => pythonInPrefix(env.prefix))])];
        const items: Array<vscode.QuickPickItem & { python?: string }> = [
            { label: '$(zap) Automatic', description: 'Prefer a verified provenance-enabled environment', python: '__auto__' },
            ...paths.filter(p => p === 'python' || fs.existsSync(p)).map(p => ({ label: p === 'python' ? '$(terminal) Python from PATH' : `$(box) ${path.basename(path.dirname(p))}`, description: p, python: p })),
            { label: '$(edit) Enter Python path manually…' },
        ];
        const chosen = await vscode.window.showQuickPick(items, { placeHolder: 'Choose Python for this workspace' });
        if (!chosen) return;
        try {
            if (chosen.python === '__auto__') { await this.clearManualSelection(file); return; }
            const selected = chosen.python ?? await vscode.window.showInputBox({ prompt: 'Full path to the Python executable', ignoreFocusOut: true });
            if (!selected) return;
            const normalized = selected.trim().replace(/^"(.*)"$/, '$1');
            if (normalized !== 'python' && (!fs.existsSync(normalized) || !fs.statSync(normalized).isFile())) throw new Error('Choose an existing Python executable.');
            const root = this.folderFor(file);
            if (root && readProjectEnvironment(root)) await this.persistProject(root, file, await this.probe(normalized));
            await this.setPython(normalized, file);
            void vscode.window.showInformationMessage(`GDS Navigator: using ${this.getPython(file)}`);
        } catch (error) { void vscode.window.showErrorMessage(`GDS Navigator: ${String(error)}`); }
    }

    /** First-open onboarding: one prompt per folder/session; never blocks viewing. */
    setupProject(file?: string, force = false): Promise<void> {
        const root = this.folderFor(file);
        if (!root || vscode.workspace.isTrusted === false) return Promise.resolve();
        const pending = this.setupPromises.get(root);
        if (pending) return pending;
        if (!force && this.promptedRoots.has(root)) return Promise.resolve();
        this.promptedRoots.add(root);
        const operation = this.runProjectSetup(root, file, force).catch(error => {
            void vscode.window.showErrorMessage(`GDS project setup: ${String(error)}`);
        }).finally(() => this.setupPromises.delete(root));
        this.setupPromises.set(root, operation);
        return operation;
    }
    private async persistProject(root: string, file: string | undefined, diagnostics: PythonDiagnostics): Promise<void> {
        saveProjectEnvironment(root, diagnostics);
        const resource = vscode.Uri.file(file || path.join(root, 'layout.gds'));
        const folder = vscode.workspace.getWorkspaceFolder?.(resource);
        if (folder) {
            this.selecting = true;
            try {
                await vscode.workspace.getConfiguration('gdsNavigator', resource).update('pythonPath', diagnostics.executable, vscode.ConfigurationTarget.WorkspaceFolder);
                const pythonConfiguration = vscode.workspace.getConfiguration('python', resource);
                // The Python extension is optional; never fail GDS setup if it is absent.
                if (pythonConfiguration.inspect?.('defaultInterpreterPath')) {
                    await pythonConfiguration.update('defaultInterpreterPath', diagnostics.executable, vscode.ConfigurationTarget.WorkspaceFolder);
                }
            } finally { this.selecting = false; }
        }
        this.updateStatusBar();
    }
    private async runProjectSetup(root: string, file: string | undefined, force: boolean): Promise<void> {
        const saved = readProjectEnvironment(root);
        if (!force && saved) {
            const checked = await this.probe(saved.python);
            const configured = this.config(file).get<string>('pythonPath', '').trim();
            if (!checked.error && checked.provenance?.available && checked.klayout?.path && !checked.klayout.error && (!configured || configured === saved.python)) {
                if (!configured) await this.persistProject(root, file, checked);
                return;
            }
        }
        await this.ready(file);
        const local = pythonInPrefix(path.join(root, '.venv-fork'));
        let chosen = this.config(file).get<string>('pythonPath', '').trim() || saved?.python || (fs.existsSync(local) ? local : this.getPython(file));
        let diagnostics = await this.probe(chosen);
        const valid = !diagnostics.error && diagnostics.provenance?.available && diagnostics.klayout?.path && !diagnostics.klayout.error && !diagnostics.gdsfactory?.error;
        const choice = await vscode.window.showInformationMessage(
            valid ? `Set up GDS Python for ${path.basename(root)}? Verified provenance + KLayout: ${chosen}. Saves this folder's default and agent launcher.`
                : `Set up GDS Python for ${path.basename(root)}: choose an environment with provenance-enabled gdsfactory and KLayout.`,
            ...(valid ? ['Use this environment', 'Choose another', 'Not now'] : ['Choose another', 'Not now']));
        if (!choice || choice === 'Not now') return;
        if (choice === 'Choose another') {
            const candidates = [...new Set([chosen, ...await discoverPythonCandidates(this.context), ...(await this.listCondaEnvs()).map(env => pythonInPrefix(env.prefix))])];
            const picked = await vscode.window.showQuickPick([
                ...candidates.filter(p => p === 'python' || fs.existsSync(p)).map(p => ({ label: p, description: 'Verify before saving', python: p })),
                { label: 'Enter Python path…', description: '', python: '' },
            ], { placeHolder: 'Select the Python to verify and save for this folder' });
            if (!picked) return;
            chosen = picked.python || await vscode.window.showInputBox({ prompt: 'Full path to the provenance Python executable' }) || '';
            if (!chosen.trim()) return;
            diagnostics = await this.probe(chosen.trim().replace(/^"(.*)"$/, '$1'));
        }
        await this.persistProject(root, file, diagnostics);
        void vscode.window.showInformationMessage(`GDS project ready. Python is saved for ${path.basename(root)}. Agents can use gds-python.cmd; instructions are in AGENTS.md.`);
    }
}
