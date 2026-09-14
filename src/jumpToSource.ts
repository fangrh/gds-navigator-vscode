import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

const highlightType = vscode.window.createTextEditorDecorationType({
    backgroundColor: 'rgba(137, 180, 250, 0.25)',
    border: '1px solid rgba(137, 180, 250, 0.8)',
});

/**
 * Open the provenance-referenced source file at the given line, next to the
 * GDS viewer, with a temporary highlight. Absolute paths recorded in the
 * provenance win; otherwise the file is located by basename in the workspace
 * (provenance recorded on another machine only stores its own paths).
 */
export async function openSource(rawFile: string, rawLine: number, gdsPath?: string): Promise<void> {
    const line = Math.max(1, parseInt(String(rawLine), 10) || 1);
    const file = (rawFile || '').replace(/\\/g, '/');

    const candidates: string[] = [];
    if (path.isAbsolute(file) && fs.existsSync(file)) {
        candidates.push(file);
    }
    const basename = path.basename(file);
    if (gdsPath) {
        const nextToGds = path.join(path.dirname(gdsPath), basename);
        if (fs.existsSync(nextToGds)) {
            candidates.push(nextToGds);
        }
    }
    if (candidates.length === 0 && basename && vscode.workspace.workspaceFolders) {
        try {
            const uris = await vscode.workspace.findFiles(`**/${basename}`, '**/node_modules/**', 5);
            for (const uri of uris) {
                candidates.push(uri.fsPath);
            }
        } catch {
            // ignore — fall through to error below
        }
    }

    if (candidates.length === 0) {
        const openAnyway = 'Open anyway';
        const choice = await vscode.window.showErrorMessage(
            `GDS Navigator: provenance file not found on this machine: ${file}`,
            openAnyway
        );
        if (choice !== openAnyway) {
            return;
        }
        await vscode.workspace.openTextDocument({ content: `// provenance reference (not found): ${file}:${line}` }).then(
            (doc) => vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside })
        );
        return;
    }

    const doc = await vscode.workspace.openTextDocument(candidates[0]);
    const lineIdx = Math.min(line - 1, Math.max(0, doc.lineCount - 1));
    const editor = await vscode.window.showTextDocument(doc, {
        viewColumn: vscode.ViewColumn.Beside,
        selection: new vscode.Range(lineIdx, 0, lineIdx, 0),
    });
    editor.revealRange(new vscode.Range(lineIdx, 0, lineIdx, 0), vscode.TextEditorRevealType.InCenter);

    const range = new vscode.Range(lineIdx, 0, lineIdx, 0);
    editor.setDecorations(highlightType, [range]);
    setTimeout(() => {
        editor.setDecorations(highlightType, []);
    }, 2500);
}
