import { spawn } from 'child_process';

/**
 * Deterministic cross-platform clipboard write.
 *
 * vscode.env.clipboard.writeText and clip.exe have both been observed to
 * silently no-op when spawned from CLI-launched extension hosts; PowerShell
 * Set-Clipboard (.NET API) is used on Windows as the primary path, with
 * pbcopy/xclip elsewhere. Best-effort: always resolves.
 */
export function writeToClipboard(text: string): Promise<void> {
    const isWin = process.platform === 'win32';
    const isMac = process.platform === 'darwin';

    if (isWin) {
        return new Promise((resolve) => {
            try {
                // $input reads the full stdin; Set-Clipboard uses the .NET API.
                // detached: the ext host may run inside a job object whose
                // children are barred from touching the interactive clipboard;
                // a detached child escapes it.
                const proc = spawn('powershell.exe', ['-NoProfile', '-Command', '$input | Set-Clipboard'], {
                    windowsHide: true,
                    detached: true,
                    stdio: ['pipe', 'ignore', 'ignore'],
                });
                const done = () => resolve();
                proc.on('error', done);
                proc.on('close', () => setTimeout(done, 200));
                proc.stdin.on('error', done);
                proc.stdin.write(text, () => proc.stdin.end());
                proc.unref();
            } catch {
                resolve();
            }
        });
    }

    const cmd = isMac ? 'pbcopy' : 'xclip';
    const args = isMac ? [] : ['-selection', 'clipboard'];
    return new Promise((resolve) => {
        try {
            const proc = spawn(cmd, args, { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
            const done = () => resolve();
            proc.on('error', done);
            proc.on('close', done);
            proc.stdin.on('error', done);
            proc.stdin.write(text, () => proc.stdin.end());
        } catch {
            resolve();
        }
    });
}
