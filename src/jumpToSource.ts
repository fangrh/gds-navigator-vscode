import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

const highlightType = vscode.window.createTextEditorDecorationType({
    backgroundColor: 'rgba(137, 180, 250, 0.25)',
    border: '1px solid rgba(137, 180, 250, 0.8)',
});

/**
 * Open the provenance-referenced source file at the given line, next to the
 * GDS viewer, with a temporary highlight. An existing exact path wins. When
 * provenance points at a moved file, every fallback is explicitly confirmed.
 */
export async function openSource(rawFile: string, rawLine: number, gdsPath?: string): Promise<void> {
    const parsedLine = Number(rawLine);
    const line = Number.isInteger(parsedLine) && parsedLine > 0 ? parsedLine : 0;
    const file = (rawFile || '').replace(/\\/g, '/');

    const candidates: string[] = [];
    const basename = path.basename(file);
    const isSourceFile = (candidate: string): boolean => /\.(py|pyw|js|jsx|ts|tsx|mjs|cjs)$/i.test(candidate);
    if (!isSourceFile(file)) {
        await vscode.window.showErrorMessage(`GDS Navigator: unsupported provenance source file type: ${file || '(empty)'}.`);
        return;
    }
    // Exact absolute and relative paths are authoritative when they exist.
    const exact = path.isAbsolute(file) ? path.normalize(file) : path.resolve(file);
    if (fs.existsSync(exact) && fs.statSync(exact).isFile()) candidates.push(exact);
    if (candidates.length === 0 && gdsPath && !path.isAbsolute(file)) {
        const relativeToGds = path.resolve(path.dirname(gdsPath), file);
        if (fs.existsSync(relativeToGds) && fs.statSync(relativeToGds).isFile()) candidates.push(relativeToGds);
    }
    // Relocation search is intentionally never implicit: even one candidate is
    // shown to the user and labelled as unverified.
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
    if (!line) {
        await vscode.window.showErrorMessage(`GDS Navigator: invalid provenance line for ${file || basename || 'source file'}.`);
        return;
    }

    const uniqueCandidates = [...new Set(candidates.map((candidate) => path.normalize(candidate)))];
    let selected = uniqueCandidates[0];
    const exactWasFound = uniqueCandidates.length === 1 && path.normalize(uniqueCandidates[0]) === path.normalize(exact);
    if (!exactWasFound) {
        const choice = await vscode.window.showQuickPick(uniqueCandidates.map((candidate) => ({ label: `Relocated (unverified): ${path.basename(candidate)}`, description: candidate, candidate })), {
            placeHolder: `Choose provenance source for ${basename}`,
        });
        if (!choice) return;
        selected = choice.candidate;
    }
    const doc = await vscode.workspace.openTextDocument(selected);
    if (line > doc.lineCount) {
        await vscode.window.showErrorMessage(`GDS Navigator: provenance line ${line} is unavailable in ${selected} (file has ${doc.lineCount} lines).`);
        return;
    }
    const lineIdx = line - 1;
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
