import * as fs from 'fs';
import * as path from 'path';

const GUIDE = `# Start a GDS project

This folder has three places to start:

- \`scripts/\`: editable Python layout generators.
- \`layouts/\`: generated GDS files to inspect in GDS Navigator.
- \`images/\`: microscope images you choose to add.

In the GDS Navigator sidebar, choose **Create marker template (50 µm JJ pad)**
to add \`scripts/generate_jj_pad_center_50.py\` and
\`layouts/jj_pad_center_50_test.gds\`. Open the GDS immediately, or edit the
Python script and run **GDS: Run Python Script (Build GDS)**.
The script uses gdsfactory. **Set up Python environment** in the sidebar checks
the interpreter and enables source provenance when a compatible fork is installed.

The template contains the user's numbered marker grid and a 50 µm JJ pad.
Align microscope images using the numbered markers; electrode or background
shapes are not registration evidence.
`;

export interface StarterProjectResult { guide: string; created: string[]; }
export interface MarkerExampleResult { script: string; gds: string; created: boolean; }

function ensureRoot(root: string): string {
    const resolved = path.resolve(root);
    if (!fs.statSync(resolved).isDirectory()) throw new Error('Choose an existing project folder.');
    return resolved;
}

export function initializeGdsProject(root: string): StarterProjectResult {
    const resolved = ensureRoot(root), created: string[] = [];
    for (const name of ['scripts', 'layouts', 'images']) {
        const folder = path.join(resolved, name);
        if (!fs.existsSync(folder)) { fs.mkdirSync(folder); created.push(folder); }
        else if (!fs.statSync(folder).isDirectory()) throw new Error(`${name} exists and is not a folder.`);
    }
    const guide = path.join(resolved, 'GDS_START_HERE.md');
    try { fs.writeFileSync(guide, GUIDE, { encoding: 'utf8', flag: 'wx' }); created.push(guide); }
    catch (error: any) { if (error?.code !== 'EEXIST') throw error; }
    if (!fs.statSync(guide).isFile()) throw new Error('GDS_START_HERE.md exists and is not a file.');
    return { guide, created };
}

export function createMarkerExample(root: string, extensionRoot: string): MarkerExampleResult {
    const resolved = ensureRoot(root);
    const script = path.join(resolved, 'scripts', 'generate_jj_pad_center_50.py');
    const gds = path.join(resolved, 'layouts', 'jj_pad_center_50_test.gds');
    const sourceScript = path.join(extensionRoot, 'templates', 'generate_jj_pad_center_50.py');
    const sourceGds = path.join(extensionRoot, 'templates', 'jj_pad_center_50_test.gds');
    if (!fs.existsSync(sourceScript) || !fs.existsSync(sourceGds)
        || !fs.statSync(sourceScript).isFile() || !fs.statSync(sourceGds).isFile()) {
        throw new Error('Bundled marker example is incomplete. Reinstall GDS Navigator.');
    }
    const hasScript = fs.existsSync(script), hasGds = fs.existsSync(gds);
    if (hasScript && hasGds) return { script, gds, created: false };
    if (hasScript || hasGds) throw new Error('One marker example file already exists. Keep it and resolve the filename before creating the pair.');
    initializeGdsProject(resolved);
    fs.copyFileSync(sourceScript, script, fs.constants.COPYFILE_EXCL);
    try { fs.copyFileSync(sourceGds, gds, fs.constants.COPYFILE_EXCL); }
    catch (error) { fs.unlinkSync(script); throw error; }
    return { script, gds, created: true };
}
