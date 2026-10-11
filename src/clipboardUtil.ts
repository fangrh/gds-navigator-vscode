import { spawn } from 'child_process';
/** Sequential, bounded fallback. Never report a failed process as a copy. */
export function writeToClipboard(text: string): Promise<void> {
    const win = process.platform === 'win32';
    const cmd = win ? 'powershell.exe' : process.platform === 'darwin' ? 'pbcopy' : 'xclip';
    const args = win ? ['-NoProfile', '-Command', '[Console]::InputEncoding = [System.Text.Encoding]::UTF8; Set-Clipboard -Value ([Console]::In.ReadToEnd())'] : process.platform === 'darwin' ? [] : ['-selection', 'clipboard'];
    return new Promise((resolve, reject) => {
        const proc = spawn(cmd, args, { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
        let settled = false;
        const timer = setTimeout(() => abort(new Error('Clipboard write timed out')), 5000);
        function finish(error?: Error): boolean {
            if (settled) return false;
            settled = true;
            clearTimeout(timer);
            if (error) reject(error); else resolve();
            return true;
        }
        function abort(error: Error): void {
            // Reject before killing: a resulting close event must retain the failure.
            if (finish(error)) proc.kill();
        }
        proc.once('error', error => finish(error));
        proc.once('close', code => finish(code === 0 ? undefined : new Error(`Clipboard process exited ${code}`)));
        proc.stdin.on('error', abort);
        try { proc.stdin.end(text, 'utf8'); } catch (error) { abort(error as Error); }
    });
}
