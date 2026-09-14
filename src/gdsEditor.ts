import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { parseGdsFile } from './parseGds';
import { findSidecar, deriveScriptFromSidecar } from './sidecar';
import { openSource } from './jumpToSource';
import { runPythonScript } from './pythonRunner';
import { writeToClipboard } from './clipboardUtil';
import { EnvProvider } from './envProvider';

/** Measurements of a shape drawn in the viewer (um). */
interface DrawnShape {
    type?: string;
    bbox?: number[];
    width?: number;
    height?: number;
    radius?: number;
    length?: number;
    area?: number;
    center?: number[];
    coordinates?: number[][];
}

interface ComponentSelection {
    provId: number | string;
    layer: string;
    bbox: number[];
    provenance: {
        file?: string;
        line?: number | string;
        function?: string;
        cell?: string;
        instance_name?: string;
        loop_index?: number[];
        array_index?: number[] | number[][];
        call_chain?: Array<{ file?: string; line?: number | string; function?: string }>;
        [key: string]: unknown;
    };
    /** Set for shapes drawn with the viewer's draw tools. */
    drawn?: boolean;
    shape?: DrawnShape;
}

/** Extension-side port of the webview's _normalizeCallChain: accepts either
 *  call_chain arrays ({file,line,function}) or call_stack strings
 *  ("file:line in function"), skipping the primary file:line duplicate. */
/** Format a loop/array index as Python-style zero-based tuples:
 *  [3,2] -> "(3,2)"; nested arrays [[0,1],[2,0]] -> "(0,1)×(2,0)". */
function fmtIndices(v: number[] | number[][]): string {
    const nested = v.length > 0 && Array.isArray(v[0]);
    if (nested) {
        return (v as number[][]).map((lv) => `(${lv.join(',')})`).join('×');
    }
    return `(${(v as number[]).join(',')})`;
}

function normalizeCallChain(prov: Record<string, unknown>): Array<{ file: string; line: number; function: string }> {
    let entries: Array<{ file: string; line: number; function: string }> = [];
    const chain = prov.call_chain;
    const stack = prov.call_stack;
    if (Array.isArray(chain)) {
        entries = (chain as Array<Record<string, unknown>>).map((cc) => ({
            file: String(cc.file || ''),
            line: parseInt(String(cc.line), 10) || 0,
            function: String(cc.function || ''),
        }));
    } else if (Array.isArray(stack)) {
        entries = (stack as string[]).map((cs) => {
            const m = cs.match(/^(.+?):(\d+)\s+in\s+(.+)$/);
            return m ? { file: m[1], line: parseInt(m[2], 10), function: m[3] } : { file: cs, line: 0, function: '' };
        });
    } else {
        return [];
    }
    const primaryFile = String(prov.file || '').replace(/\\/g, '/');
    const primaryLine = parseInt(String(prov.line), 10) || 0;
    if (primaryFile && primaryLine) {
        entries = entries.filter((e) => e.file.replace(/\\/g, '/') !== primaryFile || e.line !== primaryLine);
    }
    return entries;
}

interface ViewerEntry {
    panel: vscode.WebviewPanel;
    gdsPath: string;
    ready: boolean;
    pythonFile?: string;
    loading: boolean;
    /** Last selection reported via selectComponents — used by commandCopyYaml. */
    lastSelection?: ComponentSelection[];
}

/**
 * Read-only custom editor: double-clicking a .gds opens the OpenLayers-based
 * GDS Navigator. Provenance sidecars (`<name>.provenance.json`, fallback
 * `<name>.json`) are detected automatically; clicking a shape jumps to the
 * generating Python source. If no sidecar exists, the user can appoint the
 * generating .py script manually and rebuild.
 */
export class GdsEditorProvider implements vscode.CustomReadonlyEditorProvider<vscode.CustomDocument> {
    static readonly viewType = 'gdsNavigator.viewer';

    private viewers = new Map<string, ViewerEntry[]>();
    private watchers: vscode.FileSystemWatcher[] = [];
    private htmlTemplate?: string;
    /** most recently resolved viewer — used by commands */
    activeGdsPath?: string;

    constructor(
        private context: vscode.ExtensionContext,
        private env: EnvProvider,
        private output: vscode.OutputChannel
    ) {}

    // ------------------------------------------------------------------
    // CustomReadonlyEditorProvider
    // ------------------------------------------------------------------

    openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
        return { uri, dispose: () => {} };
    }

    async resolveCustomEditor(
        document: vscode.CustomDocument,
        webviewPanel: vscode.WebviewPanel,
        _token: vscode.CancellationToken
    ): Promise<void> {
        const gdsPath = document.uri.fsPath;
        const entry: ViewerEntry = { panel: webviewPanel, gdsPath, ready: false, loading: false };

        webviewPanel.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
        };
        webviewPanel.webview.html = this.getHtml(webviewPanel.webview);
        this.activeGdsPath = gdsPath;

        const list = this.viewers.get(gdsPath) || [];
        list.push(entry);
        this.viewers.set(gdsPath, list);

        this.watchFile(document.uri);

        webviewPanel.webview.onDidReceiveMessage((message) => this.onMessage(entry, message));
        webviewPanel.onDidDispose(() => {
            const remaining = (this.viewers.get(gdsPath) || []).filter((v) => v !== entry);
            if (remaining.length) {
                this.viewers.set(gdsPath, remaining);
            } else {
                this.viewers.delete(gdsPath);
            }
        });
        webviewPanel.onDidChangeViewState(() => {
            if (webviewPanel.visible) {
                this.activeGdsPath = gdsPath;
            }
        });
    }

    // ------------------------------------------------------------------
    // Message protocol with the webview
    // ------------------------------------------------------------------

    private async onMessage(entry: ViewerEntry, message: any): Promise<void> {
        console.log('[gds-navigator] msg:', message && message.type);
        this.output.appendLine(`[msg] ${message && message.type} (yaml ${typeof (message && message.yaml) === 'string' ? message.yaml.length : '-'})`);
        switch (message.type) {
            case 'webviewReady':
                entry.ready = true;
                await this.loadGds(entry);
                break;
            case 'requestSource':
                await openSource(message.file, message.line, entry.gdsPath);
                break;
            case 'viewerContext':
                entry.pythonFile = message.pythonFile;
                break;
            case 'debugError':
                this.output.appendLine(`[webview-error] ${message.where}: ${message.message}`);
                break;
            case 'debugInfo':
                this.output.appendLine(`[webview-info] ${message.where}: ${message.message}`);
                break;
            case 'rebuild':
                await this.rebuild(entry.gdsPath, entry);
                break;
            case 'insertImage':
                await this.commandInsertImage(entry);
                break;
            case 'imageTransform':
                this.output.appendLine(
                    `[image] ${message.fileName}: pos=(${message.cx}, ${message.cy}) um, scale=${message.umPerPx} um/px, rot=${message.rotDeg}deg${message.note ? ' — ' + message.note : ''}`
                );
                break;
            case 'imageAligned':
                this.output.appendLine(
                    `[image] AUTO-ALIGNED ${message.fileName}: pos=(${message.cx}, ${message.cy}) um, scale=${message.umPerPx} um/px, rot=${message.rotDeg}deg, edge-match=${(Number(message.edgeMatch) * 100).toFixed(1)}% of image edges on layout edges, FOV=${message.fieldOfViewUm} um`
                );
                this.output.show(true);
                break;
            case 'associateScript':
                await this.associateAndRebuild(entry.gdsPath);
                break;
            case 'selectComponents':
                entry.lastSelection = message.components as ComponentSelection[];
                this.logSelection(entry.gdsPath, entry.lastSelection);
                break;
            case 'exportYaml': {
                const yamlText = String(message.yaml || '');
                this.output.appendLine(`[copyYaml] exportYaml received (${yamlText.length} chars); writing via clip.exe + API`);
                void vscode.env.clipboard.writeText(yamlText).then(undefined, () => undefined);
                await writeToClipboard(yamlText);
                this.output.appendLine('[copyYaml] writeToClipboard resolved');
                vscode.window.setStatusBarMessage('GDS Navigator: YAML copied to clipboard', 3000);
                break;
            }
            default:
                // saveAnnotation / deleteAnnotation are intentionally ignored:
                // drawn shapes stay ephemeral in the VS Code port.
                break;
        }
    }

    /** Selection detail (source refs + geometry) is reported in the
     *  "GDS Navigator" Output channel — the viewer itself stays panel-free. */
    private logSelection(gdsPath: string, components: ComponentSelection[]): void {
        if (!components || components.length === 0) {
            this.output.appendLine('Selection cleared');
            return;
        }
        const now = new Date();
        const pad = (n: number) => String(n).padStart(2, '0');
        const stamp = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

        const lines: string[] = [];
        lines.push(`── Selection: ${components.length} component(s) ─ ${path.basename(gdsPath)} ─ ${stamp} ──`);

        const byFile = new Map<string, Set<number>>();
        let n = 0;
        components.forEach((c) => {
            n += 1;
            const prov = c.provenance || {};
            if (c.drawn || !prov.file) {
                // Drawn shape: measurements only, no source code behind it.
                const sg = c.shape || {};
                const b = (sg.bbox && sg.bbox.length ? sg.bbox : c.bbox || [])
                    .map((v) => Number(v).toFixed(2)).join(', ');
                lines.push(`#${n} [drawn ${sg.type || 'shape'}]  bbox=[${b}]`);
                const parts: string[] = [];
                if (sg.width !== undefined) { parts.push(`width=${sg.width} um`); }
                if (sg.height !== undefined) { parts.push(`height=${sg.height} um`); }
                if (sg.radius !== undefined) { parts.push(`radius=${sg.radius} um`); }
                if (sg.length !== undefined) { parts.push(`length=${sg.length} um`); }
                if (sg.area !== undefined) { parts.push(`area=${sg.area} um2`); }
                if (sg.center) { parts.push(`center=[${sg.center.map((v) => Number(v).toFixed(2)).join(', ')}]`); }
                if (parts.length) { lines.push(`   ${parts.join('  ')}`); }
                return;
            }

            const bbox = (c.bbox || []).map((v) => Number(v).toFixed(2)).join(', ');
            const base = String(prov.file).split(/[\\/]/).pop() || '?';
            lines.push(`#${n} ${base}:${prov.line ?? '?'}  layer=${c.layer}  bbox=[${bbox}]`);

            const tags: string[] = [];
            if (prov.instance_name) { tags.push(`instance=${prov.instance_name}`); }
            if (prov.cell && prov.cell !== prov.instance_name) { tags.push(`cell=${prov.cell}`); }
            if (prov.function) { tags.push(`function=${prov.function}()`); }
            if (Array.isArray(prov.loop_index) && prov.loop_index.length) { tags.push(`loop=${fmtIndices(prov.loop_index)}`); }
            if (Array.isArray(prov.array_index) && prov.array_index.length) { tags.push(`array=${fmtIndices(prov.array_index)}`); }
            if (tags.length) { lines.push(`   ${tags.join('  ')}`); }

            const chain = normalizeCallChain(prov);
            if (chain.length > 0) {
                lines.push('   call_chain:');
                const seen = new Set<string>();
                chain.forEach((cc) => {
                    const loc = `@${cc.file || ''}#${cc.line ?? '?'}`;
                    const fn = cc.function ? ` (${cc.function})` : '';
                    if (!seen.has(loc + fn)) {
                        seen.add(loc + fn);
                        lines.push(`     - ${loc}${fn}`);
                    }
                });
            }

            const fileKey = String(prov.file).replace(/\\/g, '/');
            const lineSet = byFile.get(fileKey) || new Set<number>();
            lineSet.add(Number(prov.line) || 0);
            byFile.set(fileKey, lineSet);
        });

        if (byFile.size > 0) {
            const summary = [...byFile.entries()]
                .map(([f, lineSet]) => {
                    const nums = [...lineSet].sort((a, b) => a - b).join(', ');
                    return `${f.split('/').pop()}: lines [${nums}]`;
                })
                .join(' | ');
            lines.push(`files: ${summary}`);
        }
        lines.push('');
        this.output.appendLine(lines.join('\n'));
        // Reveal the Output panel so the detail is visible where it now lives.
        this.output.show(true);
    }

    // ------------------------------------------------------------------
    // Loading / reloading layouts
    // ------------------------------------------------------------------

    private async loadGds(entry: ViewerEntry): Promise<void> {
        if (entry.loading) {
            return;
        }
        entry.loading = true;
        try {
            const { geojson, mode } = await parseGdsFile(
                this.env.getPython(),
                entry.gdsPath,
                this.context.extensionUri.fsPath
            );
            const pythonFile = this.getAssociatedScript(entry.gdsPath) || deriveScriptFromSidecar(entry.gdsPath) || '';
            await entry.panel.webview.postMessage({
                type: 'loadGds',
                geojson,
                gdsPath: entry.gdsPath,
                pythonFile,
                annotations: [],
                mode,
            });
        } catch (err: any) {
            const detail = err?.message || String(err);
            this.output.appendLine(`Failed to parse ${entry.gdsPath}: ${detail}`);
            vscode.window.showErrorMessage(`GDS Navigator: ${detail}`);
            await entry.panel.webview.postMessage({ type: 'rebuildError' });
        } finally {
            entry.loading = false;
        }
    }

    /** Reload every viewer showing `gdsPath`. */
    async refresh(gdsPath: string): Promise<void> {
        const list = this.viewers.get(gdsPath) || [];
        for (const entry of list) {
            if (entry.ready) {
                await this.loadGds(entry);
            }
        }
    }

    // ------------------------------------------------------------------
    // Rebuild (run the generating script) and script association
    // ------------------------------------------------------------------

    /** Manually appointed .py script per GDS (persisted per workspace). */
    private assocKey(gdsPath: string): string {
        return `gdsNavigator.assoc:${gdsPath.toLowerCase()}`;
    }

    getAssociatedScript(gdsPath: string): string | undefined {
        return this.context.workspaceState.get<string>(this.assocKey(gdsPath));
    }

    setAssociatedScript(gdsPath: string, scriptPath: string): void {
        this.context.workspaceState.update(this.assocKey(gdsPath), scriptPath);
    }

    /** Script used for rebuilds: explicit association > sidecar derivation. */
    private resolveScriptFor(gdsPath: string): string | undefined {
        return this.getAssociatedScript(gdsPath) || deriveScriptFromSidecar(gdsPath);
    }

    async rebuild(gdsPath: string, entry?: ViewerEntry): Promise<void> {
        let script = this.resolveScriptFor(gdsPath);
        if (!script) {
            script = await this.promptForScript(gdsPath, 'No provenance sidecar found. Choose the Python script that generates this GDS to rebuild it with provenance.');
            if (!script) {
                await (entry?.panel.webview.postMessage({ type: 'rebuildError' }));
                return;
            }
        }
        await this.runScriptFor(script, gdsPath);
    }

    private async runScriptFor(script: string, gdsPath?: string): Promise<void> {
        // Layout scripts typically write to paths relative to the project root
        // (e.g. write_gds("gds/x.gds")), so run them with the workspace folder
        // as cwd when possible — matching how the user runs them manually.
        const ws = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(script));
        const cwd = ws ? ws.uri.fsPath : path.dirname(script);
        const result = await runPythonScript(this.env.getPython(), script, cwd, this.output);
        if (!result.ok) {
            const list = gdsPath ? this.viewers.get(gdsPath) || [] : [];
            for (const v of list) {
                v.panel.webview.postMessage({ type: 'rebuildError' });
            }
            return;
        }
        const produced = result.gdsPath;
        if (produced && this.viewers.has(produced)) {
            await this.refresh(produced);
        } else if (produced && produced !== gdsPath) {
            const open = 'Open layout';
            const choice = await vscode.window.showInformationMessage(
                `GDS Navigator: build produced ${path.basename(produced)}`,
                open
            );
            if (choice === open) {
                await vscode.commands.executeCommand(
                    'vscode.openWith',
                    vscode.Uri.file(produced),
                    GdsEditorProvider.viewType
                );
            }
        } else if (produced) {
            await this.refresh(produced);
        }
    }

    async associateAndRebuild(gdsPath: string): Promise<void> {
        const script = await this.promptForScript(
            gdsPath,
            `No provenance sidecar found for ${path.basename(gdsPath)}. Appoint the Python script that generates it.`
        );
        if (!script) {
            return;
        }
        this.setAssociatedScript(gdsPath, script);
        await this.runScriptFor(script, gdsPath);
    }

    private async promptForScript(gdsPath: string, prompt: string): Promise<string | undefined> {
        vscode.window.showInformationMessage(prompt);
        const picked = await vscode.window.showOpenDialog({
            canSelectMany: false,
            openLabel: 'Appoint script',
            filters: { 'Python script': ['py'] },
            title: `Python script that generates ${path.basename(gdsPath)}`,
        });
        return picked && picked.length ? picked[0].fsPath : undefined;
    }

    /** Command entry: run any script (active editor or file picker). */
    async commandRunScript(): Promise<void> {
        let script: string | undefined;
        const active = vscode.window.activeTextEditor?.document.uri.fsPath;
        if (active && active.endsWith('.py')) {
            script = active;
        } else {
            const picked = await vscode.window.showOpenDialog({
                canSelectMany: false,
                openLabel: 'Run script',
                filters: { 'Python script': ['py'] },
            });
            script = picked && picked.length ? picked[0].fsPath : undefined;
        }
        if (script) {
            await this.runScriptFor(script);
        }
    }

    /** Pick a microscope image, read it as a data URL and push it into the
     *  viewer as an overlay layer. Browser-decodable formats only (convert
     *  TIFF to PNG/JPG first). */
    async commandInsertImage(entry?: ViewerEntry): Promise<void> {
        const target = entry?.gdsPath || this.activeGdsPath;
        if (!target) {
            vscode.window.showErrorMessage('GDS Navigator: no GDS viewer is active.');
            return;
        }
        const viewer = entry || (this.viewers.get(target) || []).find((v) => v.ready);
        if (!viewer) {
            vscode.window.showWarningMessage('GDS Navigator: no ready viewer.');
            return;
        }
        const picked = await vscode.window.showOpenDialog({
            canSelectMany: false,
            openLabel: 'Insert microscope image',
            filters: { 'Image (PNG/JPG/BMP/WebP)': ['png', 'jpg', 'jpeg', 'bmp', 'webp'] },
        });
        const imgPath = picked && picked.length ? picked[0].fsPath : undefined;
        if (!imgPath) {
            return;
        }
        let dataUrl: string;
        try {
            const buf = await vscode.workspace.fs.readFile(vscode.Uri.file(imgPath));
            const mime = imgPath.toLowerCase().endsWith('.png') ? 'image/png'
                : imgPath.toLowerCase().endsWith('.bmp') ? 'image/bmp'
                : imgPath.toLowerCase().endsWith('.webp') ? 'image/webp'
                : 'image/jpeg';
            dataUrl = `data:${mime};base64,${Buffer.from(buf).toString('base64')}`;
        } catch (err: any) {
            vscode.window.showErrorMessage(`GDS Navigator: cannot read ${path.basename(imgPath)}: ${err?.message || err}`);
            return;
        }
        this.output.appendLine(`[image] loaded ${path.basename(imgPath)} (${Math.round(dataUrl.length / 1024)} KB as data URL)`);
        await viewer.panel.webview.postMessage({ type: 'loadImage', dataUrl, fileName: path.basename(imgPath) });
    }

    /** Command entry: rebuild the layout of the active viewer. */
    async commandRebuild(): Promise<void> {
        if (!this.activeGdsPath) {
            vscode.window.showErrorMessage('GDS Navigator: no GDS viewer is active.');
            return;
        }
        await this.rebuild(this.activeGdsPath);
    }

    /** Command entry: with the cursor on a line of the generating .py file,
     *  select the layout features whose provenance points at that line. */
    async commandSelectBySource(): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        const file = editor?.document.uri.fsPath;
        if (!editor || !file || !file.endsWith('.py')) {
            vscode.window.showErrorMessage('GDS Navigator: open the generating .py file and place the cursor on a line first.');
            return;
        }
        const target = this.activeGdsPath;
        if (!target) {
            vscode.window.showErrorMessage('GDS Navigator: no GDS viewer is active.');
            return;
        }
        const entry = (this.viewers.get(target) || []).find((v) => v.ready);
        if (!entry) {
            vscode.window.showWarningMessage('GDS Navigator: no ready viewer.');
            return;
        }
        const line = editor.selection.active.line + 1;
        await entry.panel.webview.postMessage({ type: 'selectBySource', file, line });
        this.output.appendLine(`[selectBySource] ${path.basename(file)}:${line} -> ${path.basename(target)}`);
    }

    /** Command entry: copy the active viewer's current selection as AI-ready
     *  YAML. Built extension-side from the cached selectComponents payload —
     *  identical format to the webview's copyYAML, without depending on the
     *  webview->host exportYaml round-trip. */
    async commandCopyYaml(): Promise<void> {
        const target = this.activeGdsPath;
        if (!target) {
            vscode.window.showErrorMessage('GDS Navigator: no GDS viewer is active.');
            return;
        }
        const entry = (this.viewers.get(target) || []).find((v) => v.ready);
        if (!entry) {
            vscode.window.showWarningMessage('GDS Navigator: no ready viewer.');
            return;
        }
        // Drawn shapes carry no file in their provenance; GDS features do.
        const gds = (entry.lastSelection || []).filter((c) => (c.provenance || {}).file);
        const drawn = (entry.lastSelection || []).filter((c) => !(c.provenance || {}).file);
        if (!entry.lastSelection || entry.lastSelection.length === 0) {
            vscode.window.showWarningMessage('GDS Navigator: select a component first.');
            return;
        }

        const lines: string[] = [];
        gds.forEach((c, i) => {
            const prov = c.provenance || {};
            const bbox = (c.bbox || []).map((v) => Number(v).toFixed(4)).join(', ');
            const base = String(prov.file || '').split(/[\\/]/).pop() || '?';
            lines.push(`${base} Component ${i + 1}: Line ${prov.line ?? '?'}, bbox:[${bbox}]`);
            if (Array.isArray(prov.loop_index) && prov.loop_index.length) {
                lines.push(`  loop_index: ${fmtIndices(prov.loop_index)}  # zero-based, outermost first`);
            }
            if (Array.isArray(prov.array_index) && prov.array_index.length) {
                lines.push(`  array_index: ${fmtIndices(prov.array_index)}`);
            }
            const chain = normalizeCallChain(prov);
            if (chain.length > 0) {
                lines.push('  call_chain:');
                const seen = new Set<string>();
                chain.forEach((cc) => {
                    const loc = `@${cc.file || ''}#${cc.line ?? '?'}`;
                    const fn = cc.function ? ` (${cc.function})` : '';
                    if (!seen.has(loc + fn)) {
                        seen.add(loc + fn);
                        lines.push(`    - ${loc}${fn}`);
                    }
                });
            }
        });
        if (drawn.length > 0) {
            if (lines.length > 0) {
                lines.push('');
            }
            lines.push('annotations:');
            drawn.forEach((c) => {
                const sg = c.shape;
                const b = (sg && sg.bbox && sg.bbox.length ? sg.bbox : c.bbox || []);
                lines.push(`  - shape: ${String((sg && sg.type) || (c.provenance || {}).shapeType || 'shape')}`);
                lines.push(`    bbox: [${b.map((v) => Math.round(Number(v) * 100) / 100).join(', ')}]`);
                if (sg) {
                    if (sg.width !== undefined) { lines.push(`    width: ${sg.width}`); }
                    if (sg.height !== undefined) { lines.push(`    height: ${sg.height}`); }
                    if (sg.radius !== undefined) { lines.push(`    radius: ${sg.radius}`); }
                    if (sg.length !== undefined) { lines.push(`    length: ${sg.length}`); }
                    if (sg.area !== undefined) { lines.push(`    area: ${sg.area}`); }
                    if (sg.center) { lines.push(`    center: [${sg.center.join(', ')}]`); }
                } else {
                    const w = b.length === 4 ? Math.round((b[2] - b[0]) * 100) / 100 : undefined;
                    const h = b.length === 4 ? Math.round((b[3] - b[1]) * 100) / 100 : undefined;
                    if (w !== undefined) { lines.push(`    width: ${w}`); }
                    if (h !== undefined) { lines.push(`    height: ${h}`); }
                }
            });
        }

        const yamlText = lines.join('\n');
        this.output.appendLine(`[copyYaml] extension-side YAML built (${yamlText.length} chars); writing to clipboard`);
        void vscode.env.clipboard.writeText(yamlText).then(
            () => {
                vscode.env.clipboard.readText().then(
                    (v) => this.output.appendLine(`[copyYaml] API writeText done; readback ${v.length} chars ${v === yamlText ? '== MATCH' : '!= MISMATCH'}`),
                    () => undefined
                );
            },
            (err: unknown) => this.output.appendLine(`[copyYaml] API writeText rejected: ${String(err)}`)
        );
        await writeToClipboard(yamlText);
        this.output.appendLine('[copyYaml] writeToClipboard (Set-Clipboard detached) resolved');
        const readback = await Promise.resolve(vscode.env.clipboard.readText()).catch(() => '(read failed)');
        this.output.appendLine(`[copyYaml] final clipboard readback: ${readback.length} chars ${readback === yamlText ? '== MATCH ✓' : '!= MISMATCH'}`);
        vscode.window.setStatusBarMessage('GDS Navigator: YAML copied to clipboard (paste to your AI agent)', 4000);
    }

    /** Command entry: appoint a script for the active viewer. */
    async commandAssociate(): Promise<void> {
        if (!this.activeGdsPath) {
            vscode.window.showErrorMessage('GDS Navigator: no GDS viewer is active.');
            return;
        }
        await this.associateAndRebuild(this.activeGdsPath);
    }

    // ------------------------------------------------------------------
    // File watching — reload when the .gds or its sidecar changes
    // ------------------------------------------------------------------

    private watched = new Set<string>();

    private watchFile(uri: vscode.Uri): void {
        const gdsPath = uri.fsPath;
        const watch = (file: string) => {
            if (this.watched.has(file)) {
                return;
            }
            this.watched.add(file);
            const folder = vscode.Uri.file(path.dirname(file));
            const pattern = path.basename(file);
            const watcher = vscode.workspace.createFileSystemWatcher(
                new vscode.RelativePattern(folder, pattern)
            );
            const reload = (() => {
                let timer: NodeJS.Timeout | undefined;
                return () => {
                    if (timer) {
                        clearTimeout(timer);
                    }
                    timer = setTimeout(() => this.refresh(gdsPath), 300);
                };
            })();
            watcher.onDidChange(reload);
            this.watchers.push(watcher);
            this.context.subscriptions.push(watcher);
        };
        watch(gdsPath);
        for (const candidate of [gdsPath.replace(/\.gds$/i, '.provenance.json'), gdsPath.replace(/\.gds$/i, '.json')]) {
            if (fs.existsSync(candidate)) {
                watch(candidate);
            }
        }
    }

    // ------------------------------------------------------------------
    // Webview HTML from the ported viewer template
    // ------------------------------------------------------------------

    private getHtml(webview: vscode.Webview): string {
        if (!this.htmlTemplate) {
            this.htmlTemplate = fs.readFileSync(
                path.join(this.context.extensionUri.fsPath, 'webview', 'viewer.html'),
                'utf-8'
            );
        }
        const olCss = webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, 'media', 'ol.css')
        );
        const olJs = webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, 'media', 'ol.js')
        );
        const csp = [
            "default-src 'none'",
            `img-src ${webview.cspSource} data: blob:`,
            `style-src ${webview.cspSource} 'unsafe-inline'`,
            `script-src ${webview.cspSource} 'unsafe-inline'`,
            `font-src ${webview.cspSource}`,
        ].join('; ');
        return this.htmlTemplate
            .replace('__OL_CSS__', `<link rel="stylesheet" href="${olCss}">`)
            .replace('__OL_JS__', `<script src="${olJs}"></script>`)
            .replace('<head>', `<head>\n<meta http-equiv="Content-Security-Policy" content="${csp}">`);
    }
}
