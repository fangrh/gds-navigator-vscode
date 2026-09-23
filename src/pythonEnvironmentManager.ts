import { spawn as nodeSpawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export type EnvironmentManager = 'uv' | 'conda' | 'venv';

export interface CommandResult {
    command: string;
    args: string[];
    code: number | null;
    stdout: string;
    stderr: string;
}

export interface CommandOptions {
    timeoutMs?: number;
    signal?: AbortSignal;
}

export type SpawnFunction = typeof nodeSpawn;

export interface PythonEnvironmentManagerOptions {
    spawn?: SpawnFunction;
    timeoutMs?: number;
    maxOutputBytes?: number;
}

export interface PythonExecutable {
    executable: string;
    version?: string;
    source: 'configured' | 'current' | 'path';
}

export interface EnvironmentTools {
    uv?: string;
    conda?: string;
}

export interface CreateEnvironmentOptions {
    target: string;
    manager: EnvironmentManager;
    /** Python executable used by uv or venv. Conda uses pythonVersion instead. */
    pythonExecutable?: string;
    /** Conda package selector, for example `3.12`. */
    pythonVersion?: string;
    uvExecutable?: string;
    condaExecutable?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
}

export interface InstallPackagesOptions {
    interpreter: string;
    packages?: string[];
    gdsfactoryForkPath?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;

function pythonInPrefix(prefix: string): string {
    if (process.platform === 'win32') {
        const windows = path.join(prefix, 'Scripts', 'python.exe');
        return fs.existsSync(windows) ? windows : path.join(prefix, 'python.exe');
    }
    return path.join(prefix, 'bin', 'python');
}

function abortError(): Error {
    const error = new Error('Operation cancelled');
    error.name = 'AbortError';
    return error;
}

export class PythonEnvironmentManager {
    private readonly runSpawn: SpawnFunction;
    private readonly defaultTimeoutMs: number;
    private readonly maxOutputBytes: number;

    constructor(options: PythonEnvironmentManagerOptions = {}) {
        this.runSpawn = options.spawn || nodeSpawn;
        this.defaultTimeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
        this.maxOutputBytes = options.maxOutputBytes || DEFAULT_MAX_OUTPUT_BYTES;
    }

    async run(command: string, args: string[], options: CommandOptions = {}): Promise<CommandResult> {
        if (options.signal?.aborted) throw abortError();
        const timeoutMs = options.timeoutMs || this.defaultTimeoutMs;
        return new Promise((resolve, reject) => {
            let stdout = '';
            let stderr = '';
            let bytes = 0;
            let settled = false;
            let timer: ReturnType<typeof setTimeout> | undefined;
            let onAbort: (() => void) | undefined;
            let proc: ChildProcess;
            const finish = (result?: CommandResult, error?: Error) => {
                if (settled) return;
                settled = true;
                if (timer) clearTimeout(timer);
                if (onAbort && options.signal) options.signal.removeEventListener('abort', onAbort);
                if (error) reject(error); else resolve(result!);
            };
            const stop = (error: Error) => {
                try { proc?.kill(); } catch { /* process may have exited */ }
                finish(undefined, error);
            };
            try {
                proc = this.runSpawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
            } catch (error) {
                finish(undefined, error instanceof Error ? error : new Error(String(error)));
                return;
            }
            const consume = (chunk: Buffer, output: 'stdout' | 'stderr') => {
                bytes += chunk.length;
                if (bytes > this.maxOutputBytes) {
                    stop(new Error(`Command output exceeded ${this.maxOutputBytes} bytes: ${command}`));
                    return;
                }
                if (output === 'stdout') stdout += chunk.toString(); else stderr += chunk.toString();
            };
            proc.stdout?.on('data', (chunk: Buffer) => consume(chunk, 'stdout'));
            proc.stderr?.on('data', (chunk: Buffer) => consume(chunk, 'stderr'));
            proc.on('error', error => finish(undefined, error));
            proc.on('close', code => finish({ command, args, code, stdout, stderr }));
            timer = setTimeout(() => stop(new Error(`Command timed out after ${timeoutMs} ms: ${command}`)), timeoutMs);
            onAbort = () => stop(abortError());
            options.signal?.addEventListener('abort', onAbort, { once: true });
        });
    }

    async discoverTools(options: CommandOptions = {}): Promise<EnvironmentTools> {
        const tools: EnvironmentTools = {};
        for (const [key, command] of [['uv', 'uv'], ['conda', 'conda']] as const) {
            try {
                const result = await this.run(command, ['--version'], options);
                if (result.code === 0) tools[key] = command;
            } catch { /* an unavailable optional manager is expected */ }
        }
        return tools;
    }

    async discoverPythonExecutables(configured: string[] = [], options: CommandOptions = {}): Promise<PythonExecutable[]> {
        const output: PythonExecutable[] = [];
        const seen = new Set<string>();
        const add = (executable: string, source: PythonExecutable['source'], version?: string) => {
            const key = process.platform === 'win32' ? executable.toLowerCase() : executable;
            if (!seen.has(key)) { seen.add(key); output.push({ executable, source, version }); }
        };
        for (const executable of configured) {
            if (!executable) continue;
            try {
                const result = await this.run(executable, ['-c', 'import sys; print(sys.executable); print(sys.version.split()[0])'], options);
                if (result.code === 0) {
                    const lines = result.stdout.trim().split(/\r?\n/).map(line => line.trim()).filter(Boolean);
                    if (lines[0]) add(lines[0], 'configured', lines[1]);
                }
            } catch { /* retain only verified executables */ }
        }
        const pathCandidates = [process.execPath, ...(process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python'])];
        for (const executable of pathCandidates) {
            try {
                const result = await this.run(executable, ['-c', 'import sys; print(sys.executable); print(sys.version.split()[0])'], options);
                if (result.code === 0) {
                    const lines = result.stdout.trim().split(/\r?\n/).map(line => line.trim()).filter(Boolean);
                    if (lines[0]) add(lines[0], executable === process.execPath ? 'current' : 'path', lines[1]);
                }
            } catch { /* PATH candidate unavailable */ }
        }
        return output;
    }

    async create(options: CreateEnvironmentOptions): Promise<{ interpreter: string; result: CommandResult }> {
        if (fs.existsSync(options.target)) throw new Error(`Environment target already exists: ${options.target}`);
        if (!path.isAbsolute(options.target)) throw new Error(`Environment target must be absolute: ${options.target}`);
        const python = options.pythonExecutable || process.execPath;
        let command: string;
        let args: string[];
        if (options.manager === 'uv') {
            command = options.uvExecutable || 'uv';
            args = ['venv', '--seed', '--no-python-downloads'];
            if (options.pythonExecutable) args.push('--python', options.pythonExecutable);
            args.push(options.target);
        } else if (options.manager === 'conda') {
            command = options.condaExecutable || 'conda';
            args = ['create', '--prefix', options.target];
            args.push(options.pythonVersion ? `python=${options.pythonVersion}` : 'python');
            args.push('-y');
        } else {
            command = python;
            args = ['-m', 'venv', options.target];
        }
        let result: CommandResult;
        try {
            result = await this.run(command, args, { timeoutMs: options.timeoutMs, signal: options.signal });
        } catch (error) {
            if (fs.existsSync(options.target)) {
                throw new Error(`Environment creation interrupted; target appeared or is partially created: ${options.target}. ${String(error)}`);
            }
            throw error;
        }
        if (result.code !== 0) throw new Error(`Environment creation failed (${result.code}): ${result.stderr.slice(0, 2048)}`);
        const interpreter = pythonInPrefix(options.target);
        if (!fs.existsSync(interpreter)) throw new Error(`Environment created without an interpreter: ${interpreter}`);
        return { interpreter, result };
    }

    async install(options: InstallPackagesOptions): Promise<CommandResult | undefined> {
        const packages = [...(options.packages || [])];
        for (const spec of packages) if (!spec.trim() || spec.startsWith('-')) throw new Error(`Invalid package specification: ${spec}`);
        if (options.gdsfactoryForkPath) {
            const fork = path.resolve(options.gdsfactoryForkPath);
            if (!fs.existsSync(fork) || !fs.statSync(fork).isDirectory()) throw new Error(`gdsfactory fork path is not a directory: ${fork}`);
            packages.push('-e', fork);
        }
        if (!packages.length) return undefined;
        const result = await this.run(options.interpreter, ['-m', 'pip', 'install', ...packages], { timeoutMs: options.timeoutMs, signal: options.signal });
        if (result.code !== 0) throw new Error(`Package installation failed (${result.code}): ${result.stderr.slice(0, 2048)}`);
        return result;
    }
}

export function pythonInEnvironment(prefix: string): string { return pythonInPrefix(prefix); }

/** Convenience functions for callers that do not need to retain a manager instance. */
export function discoverEnvironmentTools(options: CommandOptions = {}, managerOptions: PythonEnvironmentManagerOptions = {}): Promise<EnvironmentTools> {
    return new PythonEnvironmentManager(managerOptions).discoverTools(options);
}

export function discoverPythonExecutables(configured: string[] = [], options: CommandOptions = {}, managerOptions: PythonEnvironmentManagerOptions = {}): Promise<PythonExecutable[]> {
    return new PythonEnvironmentManager(managerOptions).discoverPythonExecutables(configured, options);
}

export function createProjectEnvironment(options: CreateEnvironmentOptions, managerOptions: PythonEnvironmentManagerOptions = {}): Promise<{ interpreter: string; result: CommandResult }> {
    return new PythonEnvironmentManager(managerOptions).create(options);
}

export function installProjectPackages(options: InstallPackagesOptions, managerOptions: PythonEnvironmentManagerOptions = {}): Promise<CommandResult | undefined> {
    return new PythonEnvironmentManager(managerOptions).install(options);
}
