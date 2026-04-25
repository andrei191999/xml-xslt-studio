import * as fs from 'fs';
import * as vscode from 'vscode';

const MAX_RECENT = 10;

type FileType = 'xml' | 'xslt';

// Key pattern in globalState: "xmlXslt.recentFiles.{fileType}"
function storageKey(fileType: FileType): string {
    return `xmlXslt.recentFiles.${fileType}`;
}

export class RecentFilesManager {
    constructor(private readonly globalState: vscode.Memento) {}

    getAll(fileType: FileType): string[] {
        const stored = this.globalState.get<string[]>(storageKey(fileType), []);
        // Filter out paths that no longer exist on disk
        return stored.filter(p => fs.existsSync(p));
    }

    async push(fileType: FileType, fsPath: string): Promise<void> {
        const current = this.globalState.get<string[]>(storageKey(fileType), []);
        // Deduplicate: remove existing entry for this path, then prepend
        const deduped = current.filter(p => p !== fsPath);
        const updated = [fsPath, ...deduped].slice(0, MAX_RECENT);
        await this.globalState.update(storageKey(fileType), updated);
    }
}
