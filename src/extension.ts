import * as vscode from 'vscode';
import { EnvProvider } from './envProvider';
import { GdsEditorProvider } from './gdsEditor';
import { createMarkerExample, initializeGdsProject } from './starterProject';
import * as path from 'path';
let activeProvider: GdsEditorProvider | undefined;

async function chooseProjectRoot(): Promise<{ root: string; openAfter: boolean } | undefined> {
    const folders = vscode.workspace.workspaceFolders || [];
    if (folders.length === 1 && folders[0].uri.scheme === 'file') return { root: folders[0].uri.fsPath, openAfter: false };
    if (folders.length > 1) {
        const selected = await vscode.window.showQuickPick(
            folders.filter(folder => folder.uri.scheme === 'file').map(folder => ({ label: folder.name, description: folder.uri.fsPath, root: folder.uri.fsPath })),
            { placeHolder: 'Choose the GDS project folder' });
        return selected ? { root: selected.root, openAfter: false } : undefined;
    }
    const selected = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: 'Choose GDS project folder' });
    return selected?.[0]?.scheme === 'file' ? { root: selected[0].fsPath, openAfter: true } : undefined;
}

async function reportStarterError(action: string, error: unknown): Promise<void> {
    await vscode.window.showErrorMessage(`GDS Navigator: ${action}: ${error instanceof Error ? error.message : String(error)}`);
}

export function activate(context: vscode.ExtensionContext): void {
    const output = vscode.window.createOutputChannel('GDS Navigator');
    const env = new EnvProvider(context);
    void env.ready().catch(error => output.appendLine('[environment] ' + String(error)));
    const provider = new GdsEditorProvider(context, env, output);
    activeProvider = provider;

    context.subscriptions.push(
        provider,
        vscode.window.registerCustomEditorProvider(GdsEditorProvider.viewType, provider, {
            webviewOptions: { retainContextWhenHidden: true },
            supportsMultipleEditorsPerDocument: false,
        }),
        vscode.window.registerTreeDataProvider<vscode.TreeItem>('gdsNavigator.start', {
            getTreeItem: item => item,
            getChildren: () => [],
        }),
        vscode.commands.registerCommand('gdsNavigator.initializeProject', async () => {
            const selected = await chooseProjectRoot(); if (!selected) return;
            try {
                const result = initializeGdsProject(selected.root);
                if (selected.openAfter) await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(selected.root), false);
                else await vscode.window.showTextDocument(vscode.Uri.file(result.guide), { preview: false });
                void vscode.window.showInformationMessage(result.created.length ? 'GDS project folders and start guide are ready.' : 'GDS project is already initialized.');
            } catch (error) { await reportStarterError('could not initialize project', error); }
        }),
        vscode.commands.registerCommand('gdsNavigator.createMarkerExample', async () => {
            const selected = await chooseProjectRoot(); if (!selected) return;
            try {
                const result = createMarkerExample(selected.root, context.extensionUri.fsPath);
                if (selected.openAfter) await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(selected.root), false);
                else {
                    await provider.setAssociatedScript(result.gds, result.script);
                    await vscode.window.showTextDocument(vscode.Uri.file(result.script), { preview: false });
                    await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(result.gds), GdsEditorProvider.viewType);
                }
                void vscode.window.showInformationMessage(result.created ? 'Your 50 µm JJ pad marker script and GDS are ready.' : 'Opening the existing 50 µm JJ pad marker template.');
            } catch (error) { await reportStarterError('could not create marker example', error); }
        }),
        vscode.commands.registerCommand('gdsNavigator.selectPythonEnv', () => env.pick(provider.activeGdsPath)),
        vscode.commands.registerCommand('gdsNavigator.setupProjectEnvironment', async () => {
            const active = provider.activeGdsPath;
            if (active) return env.setupProject(active, true);
            const selected = await chooseProjectRoot();
            if (selected) await env.setupProject(path.join(selected.root, 'layouts', 'jj_pad_center_50_test.gds'), true);
        }),
        vscode.commands.registerCommand('gdsNavigator.runScript', (uri?: vscode.Uri) => provider.commandRunScript(uri)),
        vscode.commands.registerCommand('gdsNavigator.rebuild', () => provider.commandRebuild()),
        vscode.commands.registerCommand('gdsNavigator.copyYaml', () => provider.commandCopyYaml()),
        vscode.commands.registerCommand('gdsNavigator.selectBySource', () => provider.commandSelectBySource()),
        vscode.commands.registerCommand('gdsNavigator.insertImage', (uri?: vscode.Uri) => provider.commandInsertImage(undefined, uri)),
        vscode.commands.registerCommand('gdsNavigator.associateScript', () => provider.commandAssociate()),
        vscode.commands.registerCommand('gdsNavigator.openViewer', async () => {
            const active = vscode.window.activeTextEditor?.document.uri;
            if (!active || !active.fsPath.toLowerCase().endsWith('.gds')) {
                vscode.window.showErrorMessage('GDS Navigator: open a .gds file first.');
                return;
            }
            await vscode.commands.executeCommand('vscode.openWith', active, GdsEditorProvider.viewType);
        }),
        vscode.commands.registerCommand('gdsNavigator.openPython', () => provider.commandOpenPython()),
        vscode.commands.registerCommand('gdsNavigator.relatedFiles', () => provider.commandRelatedFiles()),
        vscode.commands.registerCommand('gdsNavigator.usageLogs', () => provider.commandUsageLogs()),
        vscode.commands.registerCommand('gdsNavigator.reviewUsage', () => provider.commandUsageLogs(undefined, true)),
        output
    );
}

export async function deactivate(): Promise<void> {
    await activeProvider?.shutdownUsage();
    activeProvider = undefined;
}
