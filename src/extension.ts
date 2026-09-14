import * as vscode from 'vscode';
import { EnvProvider } from './envProvider';
import { GdsEditorProvider } from './gdsEditor';

export function activate(context: vscode.ExtensionContext): void {
    const output = vscode.window.createOutputChannel('GDS Navigator');
    const env = new EnvProvider(context);
    const provider = new GdsEditorProvider(context, env, output);

    context.subscriptions.push(
        vscode.window.registerCustomEditorProvider(GdsEditorProvider.viewType, provider, {
            webviewOptions: { retainContextWhenHidden: true },
            supportsMultipleEditorsPerDocument: false,
        }),
        vscode.commands.registerCommand('gdsNavigator.selectPythonEnv', () => env.pick()),
        vscode.commands.registerCommand('gdsNavigator.runScript', () => provider.commandRunScript()),
        vscode.commands.registerCommand('gdsNavigator.rebuild', () => provider.commandRebuild()),
        vscode.commands.registerCommand('gdsNavigator.copyYaml', () => provider.commandCopyYaml()),
        vscode.commands.registerCommand('gdsNavigator.selectBySource', () => provider.commandSelectBySource()),
        vscode.commands.registerCommand('gdsNavigator.insertImage', () => provider.commandInsertImage()),
        vscode.commands.registerCommand('gdsNavigator.associateScript', () => provider.commandAssociate()),
        vscode.commands.registerCommand('gdsNavigator.openViewer', async () => {
            const active = vscode.window.activeTextEditor?.document.uri;
            if (!active || !active.fsPath.toLowerCase().endsWith('.gds')) {
                vscode.window.showErrorMessage('GDS Navigator: open a .gds file first.');
                return;
            }
            await vscode.commands.executeCommand('vscode.openWith', active, GdsEditorProvider.viewType);
        }),
        output
    );
}

export function deactivate(): void {
    // nothing to clean up — disposables are in context.subscriptions
}
