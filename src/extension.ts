import * as vscode from 'vscode';
import { EnvProvider } from './envProvider';
import { GdsEditorProvider } from './gdsEditor';
let activeProvider: GdsEditorProvider | undefined;

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
        vscode.commands.registerCommand('gdsNavigator.selectPythonEnv', () => env.pick(provider.activeGdsPath)),
        vscode.commands.registerCommand('gdsNavigator.setupProjectEnvironment', () => env.setupProject(provider.activeGdsPath, true)),
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
