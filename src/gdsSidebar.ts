import * as vscode from 'vscode';
import * as path from 'path';

const FILE_LIMIT = 500;
type SidebarItem = vscode.TreeItem & { kind?: 'files' | 'file' };

/** Workspace GDS entry points in the Activity Bar. Keep discovery bounded so
 * opening the view stays responsive in large generated projects. */
export class GdsSidebarProvider implements vscode.TreeDataProvider<SidebarItem>, vscode.Disposable {
    private readonly changed = new vscode.EventEmitter<SidebarItem | undefined>();
    readonly onDidChangeTreeData = this.changed.event;
    private readonly subscriptions: vscode.Disposable[] = [];

    constructor() {
        const watcher = vscode.workspace.createFileSystemWatcher('**/*.{gds,GDS}');
        this.subscriptions.push(watcher, watcher.onDidCreate(() => this.refresh()), watcher.onDidDelete(() => this.refresh()),
            vscode.workspace.onDidChangeWorkspaceFolders(() => this.refresh()));
    }

    refresh(): void { this.changed.fire(undefined); }
    dispose(): void { this.subscriptions.forEach(item => item.dispose()); this.changed.dispose(); }
    getTreeItem(item: SidebarItem): vscode.TreeItem { return item; }

    async getChildren(item?: SidebarItem): Promise<SidebarItem[]> {
        if (!item) {
            const actions: [string, string][] = [
                ['Initialize project', 'gdsNavigator.initializeProject'],
                ['Create marker template', 'gdsNavigator.createMarkerExample'],
                ['Set up Python environment', 'gdsNavigator.setupProjectEnvironment'],
                ['Run current Python script', 'gdsNavigator.runScript'],
            ];
            const nodes = actions.map(([label, command]) => {
                const node = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None) as SidebarItem;
                node.command = { command, title: label };
                return node;
            });
            const files = new vscode.TreeItem('GDS Files', vscode.TreeItemCollapsibleState.Expanded) as SidebarItem;
            files.kind = 'files';
            return [...nodes, files];
        }
        if (item.kind !== 'files') return [];
        const uris = await vscode.workspace.findFiles('**/*.{gds,GDS}', '**/{node_modules,.git,.venv,venv}/**', FILE_LIMIT + 1);
        const sorted = uris.slice(0, FILE_LIMIT).sort((a, b) => vscode.workspace.asRelativePath(a).localeCompare(vscode.workspace.asRelativePath(b)));
        const nodes = sorted.map(uri => {
            const relative = vscode.workspace.asRelativePath(uri);
            const node = new vscode.TreeItem(path.basename(uri.fsPath), vscode.TreeItemCollapsibleState.None) as SidebarItem;
            node.kind = 'file';
            node.resourceUri = uri;
            node.description = path.dirname(relative) === '.' ? '' : path.dirname(relative);
            node.tooltip = uri.fsPath;
            node.command = { command: 'vscode.openWith', title: 'Open GDS', arguments: [uri, 'gdsNavigator.viewer'] };
            return node;
        });
        if (uris.length > FILE_LIMIT) {
            const more = new vscode.TreeItem(`Showing first ${FILE_LIMIT} GDS files`, vscode.TreeItemCollapsibleState.None) as SidebarItem;
            more.description = 'Use Explorer for the rest';
            nodes.push(more);
        }
        if (!nodes.length) {
            const empty = new vscode.TreeItem('No GDS files in this workspace', vscode.TreeItemCollapsibleState.None) as SidebarItem;
            nodes.push(empty);
        }
        return nodes;
    }
}
