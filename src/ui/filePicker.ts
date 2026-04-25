import * as path from 'path';
import * as vscode from 'vscode';
import { RecentFilesManager } from './recentFiles';

export type FilePickerType = 'xml' | 'xslt';

export interface FilePickResult {
    fsPath: string;
    wasRecentlyUsed: boolean;
}

const EXTENSIONS: Record<FilePickerType, string[]> = {
    xml:  ['.xml'],
    xslt: ['.xsl', '.xslt'],
};

const BROWSE_BUTTON: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon('folder-opened'),
    tooltip: 'Browse...',
};

export async function pickFile(
    fileType: FilePickerType,
    context: vscode.ExtensionContext,
    preselectedPath?: string   // absolute path to pre-highlight (from <?xml-stylesheet?> PI)
): Promise<FilePickResult | undefined> {
    const recent = new RecentFilesManager(context.globalState);
    const recentPaths = recent.getAll(fileType);
    const exts = EXTENSIONS[fileType];

    // Collect open tab paths matching this file type
    const openTabPaths: string[] = [];
    for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
            if (tab.input instanceof vscode.TabInputText) {
                const uri = tab.input.uri;
                if (uri.scheme === 'file' && exts.some(e => uri.fsPath.endsWith(e))) {
                    if (!openTabPaths.includes(uri.fsPath)) {
                        openTabPaths.push(uri.fsPath);
                    }
                }
            }
        }
    }

    type PickItem = vscode.QuickPickItem & { fsPath?: string };

    // Open tabs — exclude paths already in recent
    const freshTabs = openTabPaths.filter(p => !recentPaths.includes(p));

    // Build item list: all recent (up to MAX_RECENT=10) + all open tabs; QuickPick scrolls natively
    const items: PickItem[] = [];
    if (recentPaths.length > 0) {
        items.push({ label: 'RECENT', kind: vscode.QuickPickItemKind.Separator });
        for (const p of recentPaths) {
            items.push({ label: path.basename(p), description: path.dirname(p), fsPath: p });
        }
    }
    if (freshTabs.length > 0) {
        items.push({ label: 'OPEN TABS', kind: vscode.QuickPickItemKind.Separator });
        for (const p of freshTabs) {
            items.push({ label: path.basename(p), description: path.dirname(p), fsPath: p });
        }
    }

    const qp = vscode.window.createQuickPick<PickItem>();
    qp.title = fileType === 'xml' ? 'Select XML file' : 'Select XSLT stylesheet';
    qp.placeholder = 'Type to filter, or click Browse...';
    qp.buttons = [BROWSE_BUTTON];
    qp.items = items;

    // Pre-selection: set activeItems AFTER assigning items
    if (preselectedPath) {
        const match = items.find(i => i.fsPath === preselectedPath);
        if (match) {
            qp.activeItems = [match];
        }
    }

    return new Promise<FilePickResult | undefined>((resolve) => {
        // Guard: qp.hide() fires onDidHide synchronously. Set this flag before
        // calling hide() in accept/button handlers so onDidHide does not race and
        // resolve(undefined) before the actual result is ready.
        let didResolve = false;

        qp.onDidTriggerButton(async (btn) => {
            if (btn === BROWSE_BUTTON) {
                didResolve = true;
                qp.hide();
                const uris = await vscode.window.showOpenDialog({
                    canSelectMany: false,
                    filters: fileType === 'xml'
                        ? { 'XML Files': ['xml'] }
                        : { 'XSLT Files': ['xsl', 'xslt'] },
                });
                if (uris && uris[0]) {
                    const fsPath = uris[0].fsPath;
                    await recent.push(fileType, fsPath);
                    resolve({ fsPath, wasRecentlyUsed: false });
                } else {
                    resolve(undefined);
                }
            }
        });

        qp.onDidAccept(async () => {
            const selected = qp.selectedItems[0];
            if (selected?.fsPath) {
                didResolve = true;
                qp.hide();
                await recent.push(fileType, selected.fsPath);
                const wasRecentlyUsed = recentPaths.includes(selected.fsPath);
                resolve({ fsPath: selected.fsPath, wasRecentlyUsed });
            }
        });

        qp.onDidHide(() => {
            qp.dispose();
            if (!didResolve) {
                resolve(undefined);
            }
        });

        qp.show();
    });
}
