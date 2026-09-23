import { spawn } from 'child_process';
/** Sequential, bounded fallback. Never report a failed process as a copy. */
export function writeToClipboard(text: string): Promise<void> {
    const win = process.platform === 'win32';
    const cmd = win ? 'powershell.exe' : process.platform === 'darwin' ? 'pbcopy' : 'xclip';
    const args = win ? ['-NoProfile', '-Command', '[Console]::InputEncoding = [System.Text.Encoding]::UTF8; Set-Clipboard -Value ([Console]::In.ReadToEnd())'] : process.platform === 'darwin' ? [] : ['-selection', 'clipboard'];
    return new Promise((resolve, reject) => {
        const proc = spawn(cmd, args, { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
        const timer = setTimeout(() => { proc.kill(); reject(new Error('Clipboard write timed out')); }, 5000);
        proc.once('error', error => { clearTimeout(timer); reject(error); });
        proc.once('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`Clipboard process exited ${code}`)); });
        proc.stdin.on('error', reject);
        proc.stdin.end(text, 'utf8');
    });
}
