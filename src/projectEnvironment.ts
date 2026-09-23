import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import type { PythonDiagnostics } from './envProvider';

const MARKER = 'GDS Navigator managed environment';
const BEGIN = '<!-- gds-navigator-environment:start -->';
const END = '<!-- gds-navigator-environment:end -->';
export interface ProjectEnvironment {
    version: 1;
    python: string;
    environment: { GDS_PROVENANCE: '1' };
    verifiedAt: string;
    gdsfactory: string;
    forkRevision?: string;
    forkDirty?: boolean;
}
export function readProjectEnvironment(root: string): ProjectEnvironment | undefined {
    const file = path.join(root, '.gds-navigator', 'environment.json');
    try {
        if (fs.statSync(file).size > 64 * 1024) return undefined;
        const value = JSON.parse(fs.readFileSync(file, 'utf8'));
        return value.version === 1 && path.isAbsolute(value.python) && typeof value.gdsfactory === 'string'
            && value.environment?.GDS_PROVENANCE === '1' ? value : undefined;
    } catch { return undefined; }
}

/** Save a checked interpreter and an agent entry point, never replacing custom launchers. */
export function saveProjectEnvironment(root: string, diagnostics: PythonDiagnostics): ProjectEnvironment {
    if (diagnostics.error || !path.isAbsolute(diagnostics.executable) || !fs.existsSync(diagnostics.executable)
        || !diagnostics.gdsfactory?.path || diagnostics.gdsfactory.error || !diagnostics.klayout?.path
        || diagnostics.klayout.error || !diagnostics.provenance?.available) {
        throw new Error('Project default requires a working Python with KLayout and provenance-enabled gdsfactory.');
    }
    const value: ProjectEnvironment = {
        version: 1, python: diagnostics.executable, environment: { GDS_PROVENANCE: '1' },
        verifiedAt: new Date().toISOString(), gdsfactory: diagnostics.gdsfactory.path,
        forkRevision: diagnostics.forkRevision, forkDirty: diagnostics.forkDirty,
    };
    const dir = path.join(root, '.gds-navigator');
    const launcher = `# ${MARKER}
$PythonArguments = $args
$ErrorActionPreference = 'Stop'
$projectRuntime = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'environment.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($projectRuntime.version -ne 1 -or !(Test-Path -LiteralPath $projectRuntime.python -PathType Leaf)) {
    throw 'GDS Python is unavailable. Open a GDS in VS Code and run GDS: Set Up Project Environment.'
}
$previousProvenance = $env:GDS_PROVENANCE
try {
    $env:GDS_PROVENANCE = '1'
    & $projectRuntime.python @PythonArguments
    $resultCode = $LASTEXITCODE
} finally { $env:GDS_PROVENANCE = $previousProvenance }
exit $resultCode
`;
    const cmd = `@echo off\r\nrem ${MARKER}\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0.gds-navigator\\run-python.ps1" %*\r\nexit /b %errorlevel%\r\n`;
    const agentGuide = `# GDS project Python\n\n${MARKER}.\n\nRun Python using the project launcher, never an arbitrary PATH Python:\n\n\`\`\`powershell\n.\\gds-python.cmd <script.py> [arguments]\n.\\gds-python.cmd -m pip --version\n\`\`\`\n\nThe launcher reads .gds-navigator/environment.json and enables GDS_PROVENANCE=1 before importing gdsfactory. VS Code GDS Navigator uses the same selected executable. If you cannot run Windows commands, read the JSON and invoke its python value directly with its environment variables. Do not silently choose another Python, install a stock gdsfactory, or replace the editable fork. Report a missing interpreter or dependency.\n\nFor tracked geometry, use gdsfactory Component.add_polygon/add_ref and Component.write_gds. Direct gdstk or KLayout writes bypass this tracking. Preserve existing layout geometry unless the work order requests changes. Check the generated .provenance.json and source references before declaring completion. Selecting an environment alone does not provide missing dependencies or provenance for arbitrary backends.\n\nUse the existing work-order queue and its documented CLI for status changes. Do not mark an order done solely because a build exits successfully.\n`;
    const agentsPath = path.join(root, 'AGENTS.md');
    const previousAgents = fs.existsSync(agentsPath) ? fs.readFileSync(agentsPath, 'utf8') : '';
    const block = `${BEGIN}\n## GDS Python environment\n\nBefore running or changing layout generators, read [.gds-navigator/AGENT_ENVIRONMENT.md](.gds-navigator/AGENT_ENVIRONMENT.md). Use \`.\\gds-python.cmd\` so builds use this folder's checked provenance environment.\n${END}`;
    const start = previousAgents.indexOf(BEGIN), end = previousAgents.indexOf(END);
    if ((start >= 0) !== (end >= 0) || (start >= 0 && end < start)) throw new Error('Incomplete managed AGENTS.md block; preserve it and repair it before setup.');
    const agents = start < 0 ? previousAgents + (previousAgents ? '\n\n' : '') + block + '\n'
        : previousAgents.slice(0, start) + block + previousAgents.slice(end + END.length);
    const files: [string, string][] = [
        [path.join(dir, 'run-python.ps1'), launcher], [path.join(root, 'gds-python.cmd'), cmd],
        [path.join(dir, 'AGENT_ENVIRONMENT.md'), agentGuide], [agentsPath, agents],
        [path.join(dir, 'environment.json'), JSON.stringify(value, null, 2) + '\n'],
    ];
    for (const [file] of files.slice(0, 3)) {
        if (fs.existsSync(file) && !fs.readFileSync(file, 'utf8').includes(MARKER)) throw new Error(`Setup will not overwrite custom file: ${file}`);
    }
    const environmentFile = path.join(dir, 'environment.json');
    if (fs.existsSync(environmentFile) && !readProjectEnvironment(root)) throw new Error('Malformed environment.json; existing file preserved.');
    fs.mkdirSync(dir, { recursive: true });
    for (const [file, contents] of files) {
        if (fs.existsSync(file)) {
            const before = fs.readFileSync(file);
            if (before.toString('utf8') === contents) continue;
            const backup = path.join(dir, 'backups', 'environment', createHash('sha256').update(file).update(before).digest('hex').slice(0, 20) + '-' + path.basename(file));
            fs.mkdirSync(path.dirname(backup), { recursive: true });
            if (!fs.existsSync(backup)) fs.writeFileSync(backup, before, { flag: 'wx' });
        }
        const temp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(temp, contents, { flag: 'wx' });
        fs.renameSync(temp, file);
    }
    return value;
}
