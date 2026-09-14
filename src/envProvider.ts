import * as vscode from 'vscode';
import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

export interface CondaEnv {
    name: string;
    prefix: string;
}

/** Python executable inside a conda prefix. */
export function pythonInPrefix(prefix: string): string {
    return path.join(prefix, process.platform === 'win32' ? 'python.exe' : path.join('bin', 'python'));
}

/**
 * Enumerates conda environments, remembers the selected one and exposes it
 * through a status bar item. Mirrors the env dropdown of superGDS Studio.
 */
export class EnvProvider {
    private statusBar: vscode.StatusBarItem;

    constructor(private context: vscode.ExtensionContext) {
        this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90);
        this.statusBar.command = 'gdsNavigator.selectPythonEnv';
        this.statusBar.tooltip = 'GDS Navigator: select the Python environment used to parse GDS and run build scripts';
        context.subscriptions.push(this.statusBar);
        this.updateStatusBar();
    }

    /** Python executable to use: config > picked conda env > plain "python". */
    getPython(): string {
        const configured = vscode.workspace.getConfiguration('gdsNavigator').get<string>('pythonPath', '');
        if (configured.trim()) {
            return configured.trim();
        }
        const picked = this.context.workspaceState.get<string>('gdsNavigator.pythonPath');
        if (picked) {
            return picked;
        }
        return 'python';
    }

    setPython(pythonPath: string): void {
        this.context.workspaceState.update('gdsNavigator.pythonPath', pythonPath);
        this.updateStatusBar();
    }

    private updateStatusBar(): void {
        const configured = vscode.workspace.getConfiguration('gdsNavigator').get<string>('pythonPath', '');
        const py = configured.trim() || this.context.workspaceState.get<string>('gdsNavigator.pythonPath') || 'python';
        this.statusBar.text = `$(circuit-board) GDS: ${shortLabel(py)}`;
        this.statusBar.show();
    }

    async listCondaEnvs(): Promise<CondaEnv[]> {
        return new Promise((resolve) => {
            const proc = spawn('conda', ['env', 'list', '--json'], { windowsHide: true });
            let out = '';
            proc.stdout.on('data', (d) => (out += d.toString()));
            proc.stderr.on('data', () => { /* conda may print warnings */ });
            proc.on('error', () => resolve([]));
            proc.on('close', () => {
                try {
                    const data = JSON.parse(out);
                    const envs: CondaEnv[] = [];
                    const seen = new Set<string>();
                    for (const prefix of data.envs as string[] || []) {
                        if (seen.has(prefix)) {
                            continue;
                        }
                        seen.add(prefix);
                        const isBase = path.resolve(prefix) === path.resolve(data.prefix || '');
                        const name = isBase ? 'base' : path.basename(prefix);
                        envs.push({ name, prefix });
                    }
                    resolve(envs);
                } catch {
                    resolve([]);
                }
            });
        });
    }

    async pick(): Promise<void> {
        const envs = await this.listCondaEnvs();
        const items: Array<vscode.QuickPickItem & { python?: string }> = [];

        for (const env of envs) {
            const py = pythonInPrefix(env.prefix);
            if (!fs.existsSync(py)) {
                continue;
            }
            items.push({ label: `$(box) ${env.name}`, description: py, python: py });
        }
        items.push({ label: '$(terminal) Use plain "python" from PATH', python: 'python' });
        items.push({ label: '$(edit) Enter Python path manually...', python: undefined });

        const chosen = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select the Python environment (needs klayout; provenance needs the fangrh/gdsfactory fork)',
        });
        if (!chosen) {
            return;
        }
        if (chosen.python === undefined) {
            const manual = await vscode.window.showInputBox({
                prompt: 'Path to the Python executable',
                placeHolder: 'C:\\Users\\me\\miniconda3\\envs\\gds\\python.exe',
                ignoreFocusOut: true,
            });
            if (!manual || !fs.existsSync(manual)) {
                vscode.window.showErrorMessage('GDS Navigator: invalid Python path.');
                return;
            }
            this.setPython(manual);
        } else {
            this.setPython(chosen.python);
        }
        vscode.window.showInformationMessage(`GDS Navigator: using ${this.getPython()}`);
    }
}

function shortLabel(py: string): string {
    if (py === 'python' || py === 'python3') {
        return py;
    }
    const dir = path.dirname(py);
    const envName = path.basename(dir);
    // .../envs/gds/python.exe -> "gds"; .../venv/Scripts/python.exe -> "venv";
    // .../miniconda3/python.exe -> "base"
    if (envName === 'Scripts' || envName === 'bin' || envName === '') {
        return path.basename(path.dirname(dir)) || py;
    }
    return envName || py;
}
