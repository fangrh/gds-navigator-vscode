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
    private fileItems?: SidebarItem[];
    private fileGeneration = 0;
    private fileLoad?: { generation: number; promise: Promise<SidebarItem[]> };

    constructor() {
        const watcher = vscode.workspace.createFileSystemWatcher('**/*.{gds,GDS}');
        this.subscriptions.push(watcher, watcher.onDidCreate(() => this.refresh()), watcher.onDidDelete(() => this.refresh()),
            vscode.workspace.onDidChangeWorkspaceFolders(() => this.refresh()));
    }

    refresh(): void {
        // File discovery is the only expensive tree operation. Invalidate it
        // only when a watcher/workspace event says the directory contents may
        // have changed; repeated TreeView queries can then reuse the nodes.
        this.fileGeneration += 1;
        this.fileItems = undefined;
        this.fileLoad = undefined;
        this.changed.fire(undefined);
    }
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
        if (this.fileItems) return this.fileItems;
        const generation = this.fileGeneration;
        if (this.fileLoad?.generation === generation) return this.fileLoad.promise;
        const promise = this.loadFileItems(generation);
        this.fileLoad = { generation, promise };
        const clearCurrentLoad = () => {
            if (this.fileLoad?.promise === promise) this.fileLoad = undefined;
        };
        promise.then(clearCurrentLoad, clearCurrentLoad);
        return promise;
    }

    private async loadFileItems(generation: number): Promise<SidebarItem[]> {
        const uris = await vscode.workspace.findFiles('**/*.{gds,GDS}', '**/{node_modules,.git,.venv,venv}/**', FILE_LIMIT + 1);
        const sorted = uris.slice(0, FILE_LIMIT)
            .map(uri => ({ uri, relative: vscode.workspace.asRelativePath(uri) }))
            .sort((a, b) => a.relative.localeCompare(b.relative));
        const nodes = sorted.map(({ uri, relative }) => {
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
        // A refresh may have happened while findFiles was pending. Such a
        // result is still valid for its caller, but must not become the cache.
        if (generation === this.fileGeneration) this.fileItems = nodes;
        return nodes;
    }
}
