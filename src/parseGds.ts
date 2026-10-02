import * as vscode from 'vscode';
import { parseGdsFileCore, ParseResult } from './parseGdsCore';

export { ParseResult } from './parseGdsCore';

const DEFAULT_TIMEOUT_MS = 120_000;

export function parseGdsFile(pythonPath: string, gdsPath: string, extensionDir: string, signal?: AbortSignal): Promise<ParseResult> {
    const configuredTimeout = vscode.workspace.getConfiguration('gdsNavigator').get<number>('parseTimeoutSec', 120);
    const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? Math.min(configuredTimeout * 1000, 60 * 60 * 1000) : DEFAULT_TIMEOUT_MS;
    return parseGdsFileCore(pythonPath, gdsPath, extensionDir, signal, timeoutMs);
}
