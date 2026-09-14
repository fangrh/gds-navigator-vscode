import * as vscode from 'vscode';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export interface RunResult {
    ok: boolean;
    /** Path of the most recently modified .gds produced by the script. */
    gdsPath?: string;
}

/**
 * Runs a user Python script with GDS_PROVENANCE=1 so the gdsfactory fork
 * writes the provenance sidecar, then locates the newest .gds output.
 * Ported from superGDS Studio lib/pythonRunner.ts.
 *
 * The script is executed through a runpy wrapper that (a) pre-activates the
 * generic PDK — the provenance fork refuses to build without an active PDK
 * and many layout scripts don't call activate() themselves (a script's own
 * activation simply overrides this) — and (b) keeps __file__ pointing at the
 * real script so provenance records the true path.
 */
const RUN_WRAPPER = [
    'import sys, os',
    'try:',
    '    import gdsfactory as gf',
    '    gf.gpdk.PDK.activate()',
    'except Exception:',
    '    pass',
    "sys.path.insert(0, os.path.dirname(os.path.abspath(sys.argv[1])))",
    'import runpy',
    'runpy.run_path(sys.argv[1], run_name="__main__")',
].join('\n');

export function runPythonScript(
    pythonPath: string,
    scriptPath: string,
    cwd: string,
    output: vscode.OutputChannel
): Promise<RunResult> {
    return new Promise((resolve) => {
        output.show(true);
        output.appendLine(`> ${pythonPath} ${scriptPath}  (GDS_PROVENANCE=1, cwd: ${cwd})`);

        const proc = spawn(pythonPath, ['-c', RUN_WRAPPER, scriptPath], {
            cwd,
            env: { ...process.env, GDS_PROVENANCE: '1' },
            windowsHide: true,
        });
        output.appendLine(`[run] spawn pid pending: ${pythonPath} (cwd: ${cwd})`);
        proc.on('spawn', () => output.appendLine(`[run] started, pid ${proc.pid}`));
        proc.on('error', (err) => output.appendLine(`[run] spawn error: ${err.message}`));

        proc.stdout.on('data', (d: Buffer) => {
            for (const line of d.toString().split('\n')) {
                if (line.trim()) {
                    output.appendLine(line);
                }
            }
        });
        let stderrTail = '';
        proc.stderr.on('data', (d: Buffer) => {
            const text = d.toString();
            stderrTail = (stderrTail + text).slice(-2000);
            for (const line of text.split('\n')) {
                if (line.trim()) {
                    output.appendLine(`[stderr] ${line}`);
                }
            }
        });

        proc.on('error', (err) => {
            vscode.window.showErrorMessage(`GDS Navigator: failed to start Python: ${err.message}`);
            resolve({ ok: false });
        });

        proc.on('close', async (code) => {
            output.appendLine(`[run] exited with code ${code}`);
            if (code !== 0) {
                output.appendLine(`Script exited with code ${code}`);
                vscode.window.showErrorMessage(
                    `GDS Navigator: script failed (exit ${code}). See GDS Navigator output for details.`
                );
                resolve({ ok: false });
                return;
            }
            const gdsPath = await findNewestGds(cwd);
            resolve({ ok: true, gdsPath });
        });
    });
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
