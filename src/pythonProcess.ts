import { execFile, spawn, SpawnOptionsWithoutStdio } from 'child_process';

const STOP_GRACE_MS = 1000;
const STOP_KILL_MS = 2000;

/** Each POSIX invocation owns its process group, including ordinary subprocesses. */
export function spawnPythonProcess(pythonPath: string, args: string[], options: SpawnOptionsWithoutStdio = {}) {
    const proc = spawn(pythonPath, args, {
        ...options,
        windowsHide: true,
        detached: process.platform !== 'win32',
    });
    let closed = false;
    let stopping: Promise<void> | undefined;
    proc.once('close', () => { closed = true; });

    const groupExists = () => {
        if (!proc.pid) return false;
        try { process.kill(-proc.pid, 0); return true; }
        catch (error: any) { if (error.code === 'ESRCH') return false; throw error; }
    };
    const waitFor = async (gone: () => boolean, timeoutMs: number) => {
        const deadline = Date.now() + timeoutMs;
        while (!gone()) {
            if (Date.now() >= deadline) return false;
            await new Promise(resolve => setTimeout(resolve, 25));
        }
        return true;
    };
    const signalGroup = (signal: NodeJS.Signals) => {
        if (!proc.pid) return;
        try { process.kill(-proc.pid, signal); }
        catch (error: any) { if (error.code !== 'ESRCH') throw error; }
    };
    const stop = async () => {
        // A failed spawn has no PID, but still emits close after its error event.
        if (!proc.pid) {
            if (!await waitFor(() => closed, STOP_KILL_MS)) throw new Error('Could not confirm Python process exit');
            return;
        }
        if (process.platform === 'win32') {
            if (closed) return;
            await new Promise<void>((resolve, reject) => {
                execFile('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true, timeout: STOP_KILL_MS }, error => {
                    if (error) reject(new Error(`Could not terminate Python process tree: ${error.message}`));
                    else resolve();
                });
            });
            if (!await waitFor(() => closed, STOP_KILL_MS)) throw new Error('Could not confirm Python process tree exit');
            return;
        }
        const gone = () => closed && !groupExists();
        if (gone()) return;
        signalGroup('SIGTERM');
        if (await waitFor(gone, STOP_GRACE_MS)) return;
        signalGroup('SIGKILL');
        if (!await waitFor(gone, STOP_KILL_MS)) throw new Error('Could not confirm Python process group exit after SIGKILL');
    };

    return { proc, terminate: () => stopping ||= stop() };
}
