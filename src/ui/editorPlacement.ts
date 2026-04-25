import * as path from 'path';
import * as vscode from 'vscode';

export interface OutputDocumentOptions {
    outputDestination?: 'newTab' | 'saveFile';
    defaultOutputExtension?: string;
    sourceXmlPath?: string;
    sourceXsltPath?: string;
}

export type SaveLocationKind = 'workspace' | 'mapper' | 'input' | 'browse';

export interface SaveLocationOption {
    kind: SaveLocationKind;
    label: string;
    folderFsPath?: string;
}

export interface SaveLocationContext {
    workspaceRootFsPath?: string;
    sourceXmlPath?: string;
    sourceXsltPath?: string;
}

function isConcreteColumn(column: vscode.ViewColumn | undefined): column is vscode.ViewColumn {
    return column === vscode.ViewColumn.One
        || column === vscode.ViewColumn.Two
        || column === vscode.ViewColumn.Three;
}

function getTabUri(tab: vscode.Tab): vscode.Uri | undefined {
    const input = tab.input as { uri?: vscode.Uri; modified?: vscode.Uri } | undefined;
    return input?.uri ?? input?.modified;
}

function findOpenColumnForUri(targetUri: vscode.Uri | undefined): vscode.ViewColumn | undefined {
    if (!targetUri) {
        return undefined;
    }
    const key = targetUri.toString();
    for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
            if (getTabUri(tab)?.toString() === key) {
                return group.viewColumn;
            }
        }
    }
    return undefined;
}

function clampColumn(column: number): vscode.ViewColumn {
    if (column <= vscode.ViewColumn.One) {
        return vscode.ViewColumn.One;
    }
    if (column >= vscode.ViewColumn.Three) {
        return vscode.ViewColumn.Three;
    }
    return column as vscode.ViewColumn;
}

export function findOpenTextDocument(targetUri: vscode.Uri): vscode.TextDocument | undefined {
    const key = targetUri.toString();
    return vscode.workspace.textDocuments.find(doc => doc.uri.toString() === key);
}

function normalizeExtension(ext: string | undefined): string {
    const trimmed = (ext ?? 'xml').trim();
    if (!trimmed) { return 'xml'; }
    return trimmed.startsWith('.') ? trimmed.slice(1) : trimmed;
}

function normalizeFolderKey(folder: string): string {
    const normalized = path.resolve(path.normalize(folder));
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function getWorkspaceRootFsPath(): string | undefined {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
        return undefined;
    }
    const uri = folder.uri as { scheme?: string; fsPath: string };
    if (uri.scheme && uri.scheme !== 'file') {
        return undefined;
    }
    return uri.fsPath;
}

export function buildSaveLocationOptions(context: SaveLocationContext): SaveLocationOption[] {
    const options: SaveLocationOption[] = [];
    const seen = new Set<string>();
    const addFolderOption = (
        kind: Exclude<SaveLocationKind, 'browse'>,
        label: string,
        folderFsPath: string | undefined,
    ): void => {
        if (!folderFsPath) {
            return;
        }
        const key = normalizeFolderKey(folderFsPath);
        if (seen.has(key)) {
            return;
        }
        seen.add(key);
        options.push({ kind, label, folderFsPath });
    };

    addFolderOption('workspace', 'Workspace root', context.workspaceRootFsPath);
    addFolderOption('mapper', 'Mapper location', context.sourceXsltPath ? path.dirname(context.sourceXsltPath) : undefined);
    addFolderOption('input', 'Input location', context.sourceXmlPath ? path.dirname(context.sourceXmlPath) : undefined);
    options.push({ kind: 'browse', label: 'Browse' });
    return options;
}

async function promptSaveLocationOption(context: SaveLocationContext): Promise<SaveLocationOption | undefined> {
    const options = buildSaveLocationOptions(context);
    const items = options.map(option => ({
        label: option.label,
        description: option.folderFsPath,
        option,
    }));
    const picked = await vscode.window.showQuickPick(items, {
        placeHolder: 'Choose where to save transform output',
    });
    return picked?.option;
}

function getPrimarySaveFolder(context: SaveLocationContext): string | undefined {
    const options = buildSaveLocationOptions(context);
    const firstFolder = options.find(opt => opt.kind !== 'browse');
    return firstFolder?.folderFsPath;
}

function getSuggestedOutputFileUri(
    defaultOutputExtension?: string,
    context: SaveLocationContext = {},
): vscode.Uri | undefined {
    const ext = normalizeExtension(defaultOutputExtension);
    const fileName = `xslt-studio-output.${ext}`;
    const primaryFolder = getPrimarySaveFolder(context);
    if (primaryFolder) {
        return vscode.Uri.file(path.join(primaryFolder, fileName));
    }
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (workspaceFolder?.scheme === 'file') {
        return vscode.Uri.joinPath(workspaceFolder, fileName);
    }
    const activeEditorUri = vscode.window.activeTextEditor?.document.uri;
    if (activeEditorUri?.scheme === 'file') {
        return vscode.Uri.joinPath(vscode.Uri.file(path.dirname(activeEditorUri.fsPath)), fileName);
    }
    return undefined;
}

export function findTargetColumn(
    targetUri: vscode.Uri | undefined,
    panelCol: vscode.ViewColumn | undefined,
): vscode.ViewColumn {
    const existingColumn = findOpenColumnForUri(targetUri);
    if (isConcreteColumn(existingColumn)) {
        return existingColumn;
    }

    const occupied = vscode.window.tabGroups.all
        .map(group => group.viewColumn)
        .filter(isConcreteColumn)
        .sort((a, b) => a - b);

    if (!isConcreteColumn(panelCol) || occupied.length === 0) {
        return vscode.ViewColumn.One;
    }

    const leftmost = occupied[0];
    const rightmost = occupied[occupied.length - 1];

    if (panelCol === rightmost) {
        return clampColumn(panelCol - 1);
    }
    if (panelCol === leftmost) {
        return clampColumn(panelCol + 1);
    }

    return vscode.ViewColumn.One;
}

export function getNamedOutputTargetUri(options: OutputDocumentOptions = {}): vscode.Uri {
    const saveContext: SaveLocationContext = {
        workspaceRootFsPath: getWorkspaceRootFsPath(),
        sourceXmlPath: options.sourceXmlPath,
        sourceXsltPath: options.sourceXsltPath,
    };
    const suggested = getSuggestedOutputFileUri(
        options.defaultOutputExtension ?? 'xml',
        saveContext,
    );
    if (suggested) {
        return suggested.with({ scheme: 'untitled' });
    }
    return vscode.Uri.parse('untitled:xslt-studio-output.xml');
}

export async function replaceDocumentText(doc: vscode.TextDocument, content: string): Promise<void> {
    const fullRange = new vscode.Range(
        doc.positionAt(0),
        doc.positionAt(doc.getText().length),
    );
    const edit = new vscode.WorkspaceEdit();
    edit.set(doc.uri, [vscode.TextEdit.replace(fullRange, content)]);
    await vscode.workspace.applyEdit(edit);
}

export async function showDocumentInTargetColumn(
    doc: vscode.TextDocument,
    targetUri: vscode.Uri | undefined,
    panelCol: vscode.ViewColumn | undefined,
    options: Omit<vscode.TextDocumentShowOptions, 'viewColumn'> = {},
): Promise<vscode.TextEditor> {
    const viewColumn = findTargetColumn(targetUri ?? doc.uri, panelCol);
    return vscode.window.showTextDocument(doc, { ...options, viewColumn });
}

export async function openOrUpdateNamedOutputDocument(
    content: string,
    language: string,
    panelCol: vscode.ViewColumn | undefined,
    options: OutputDocumentOptions = {},
): Promise<vscode.TextDocument | undefined> {
    if (options.outputDestination === 'saveFile') {
        const ext = normalizeExtension(options.defaultOutputExtension);
        const saveContext: SaveLocationContext = {
            workspaceRootFsPath: getWorkspaceRootFsPath(),
            sourceXmlPath: options.sourceXmlPath,
            sourceXsltPath: options.sourceXsltPath,
        };
        const selectedLocation = await promptSaveLocationOption(saveContext);
        if (!selectedLocation) {
            return undefined;
        }
        const defaultUri = selectedLocation.kind === 'browse'
            ? undefined
            : vscode.Uri.file(path.join(selectedLocation.folderFsPath!, `xslt-studio-output.${ext}`));
        const saveUri = await vscode.window.showSaveDialog({
            defaultUri,
            saveLabel: 'Save Transform Output',
            filters: {
                'Output files': [ext],
                'All files': ['*'],
            },
        });
        if (!saveUri) {
            return undefined;
        }
        await vscode.workspace.fs.writeFile(saveUri, Buffer.from(content, 'utf8'));
        const savedDoc = await vscode.workspace.openTextDocument(saveUri);
        if (savedDoc.languageId !== language) {
            await vscode.languages.setTextDocumentLanguage(savedDoc, language);
        }
        await showDocumentInTargetColumn(savedDoc, saveUri, panelCol, { preview: false });
        return savedDoc;
    }

    const targetUri = getNamedOutputTargetUri(options);
    const existingDoc = findOpenTextDocument(targetUri);
    let doc: vscode.TextDocument;

    if (existingDoc) {
        doc = existingDoc;
    } else {
        try {
            doc = await vscode.workspace.openTextDocument(targetUri);
        } catch (err: any) {
            if (/already exists/i.test(err?.message ?? '')) {
                const recovered = await recoverFromConflict(
                    content,
                    language,
                    panelCol,
                    options.defaultOutputExtension,
                    options.sourceXmlPath,
                    options.sourceXsltPath,
                );
                return recovered;
            }
            throw err;
        }
    }

    await replaceDocumentText(doc, content);
    if (doc.languageId !== language) {
        await vscode.languages.setTextDocumentLanguage(doc, language);
    }
    await showDocumentInTargetColumn(doc, targetUri, panelCol, { preview: false });
    return doc;
}

async function recoverFromConflict(
    content: string,
    language: string,
    panelCol: vscode.ViewColumn | undefined,
    defaultOutputExtension?: string,
    sourceXmlPath?: string,
    sourceXsltPath?: string,
): Promise<vscode.TextDocument | undefined> {
    const choice = await vscode.window.showQuickPick(
        ['Overwrite existing file', 'Create incremented name', 'Cancel'],
        { placeHolder: 'Output file already exists on disk' },
    );
    if (!choice || choice === 'Cancel') { return undefined; }

    if (choice === 'Overwrite existing file') {
        const fileUri = getSuggestedOutputFileUri(defaultOutputExtension, {
            workspaceRootFsPath: getWorkspaceRootFsPath(),
            sourceXmlPath,
            sourceXsltPath,
        });
        if (!fileUri) { return undefined; }
        const doc = await vscode.workspace.openTextDocument(fileUri);
        await replaceDocumentText(doc, content);
        if (doc.languageId !== language) {
            await vscode.languages.setTextDocumentLanguage(doc, language);
        }
        await showDocumentInTargetColumn(doc, fileUri, panelCol, { preview: false });
        return doc;
    }

    // Create incremented name
    const ext = normalizeExtension(defaultOutputExtension);
    const baseUri = getSuggestedOutputFileUri(ext, {
        workspaceRootFsPath: getWorkspaceRootFsPath(),
        sourceXmlPath,
        sourceXsltPath,
    });
    for (let i = 2; i <= 99; i++) {
        const name = `xslt-studio-output-${i}.${ext}`;
        const uri = baseUri
            ? vscode.Uri.joinPath(vscode.Uri.file(path.dirname(baseUri.fsPath)), name).with({ scheme: 'untitled' })
            : vscode.Uri.parse(`untitled:${name}`);
        const existing = findOpenTextDocument(uri);
        if (existing) { continue; }
        try {
            const doc = await vscode.workspace.openTextDocument(uri);
            await replaceDocumentText(doc, content);
            if (doc.languageId !== language) {
                await vscode.languages.setTextDocumentLanguage(doc, language);
            }
            await showDocumentInTargetColumn(doc, uri, panelCol, { preview: false });
            return doc;
        } catch {
            continue;
        }
    }
    return undefined;
}
