// Minimal vscode API mock for Jest unit tests.
// Only covers APIs used by the pure functions under test.

export class Uri {
    constructor(public readonly fsPath: string, public readonly scheme: string) {}
    static file(fsPath: string) { return new Uri(fsPath, 'file'); }
    static parse(value: string) {
        const match = value.match(/^([a-z-]+):(.*)$/i);
        return new Uri(match ? match[2] : value, match ? match[1] : 'file');
    }
    static joinPath(base: Uri, ...paths: string[]) {
        const normalized = [base.fsPath, ...paths].join('/').replace(/\\/g, '/').replace(/\/+/g, '/');
        return new Uri(normalized, base.scheme);
    }
    with(changes: { scheme?: string }) { return new Uri(this.fsPath, changes.scheme ?? this.scheme); }
    toString() { return `${this.scheme}:${this.fsPath}`; }
}

export class Position {
    constructor(public readonly line: number, public readonly character: number) {}
}

export class Location {
    constructor(public readonly uri: unknown, public readonly range: unknown) {}
}

export enum ProgressLocation { Notification = 15 }
export enum ViewColumn { Active = -1, Beside = -2, One = 1, Two = 2, Three = 3 }

export const window = {
    activeTextEditor: undefined as undefined | { viewColumn?: ViewColumn },
    tabGroups: { all: [] as Array<{ viewColumn: ViewColumn; tabs: unknown[] }> },
    showErrorMessage: jest.fn(),
    showWarningMessage: jest.fn(),
    showInformationMessage: jest.fn(),
    showQuickPick: jest.fn(),
    showInputBox: jest.fn(),
    withProgress: jest.fn(),
    showTextDocument: jest.fn(),
    createOutputChannel: jest.fn(() => ({ appendLine: jest.fn(), show: jest.fn() })),
    createStatusBarItem: jest.fn(() => ({ text: '', show: jest.fn(), dispose: jest.fn() })),
    createWebviewPanel: jest.fn(),
};

export const workspace = {
    workspaceFolders: undefined as undefined | { uri: { fsPath: string } }[],
    onDidSaveTextDocument: jest.fn(() => ({ dispose: jest.fn() })),
    openTextDocument: jest.fn(),
    textDocuments: [] as unknown[],
    applyEdit: jest.fn(),
};

export const languages = {
    createDiagnosticCollection: jest.fn(() => ({
        set: jest.fn(),
        clear: jest.fn(),
        delete: jest.fn(),
        dispose: jest.fn(),
    })),
    registerCodeActionsProvider: jest.fn(() => ({ dispose: jest.fn() })),
    setTextDocumentLanguage: jest.fn(),
};

export class Diagnostic {
    constructor(public range: unknown, public message: string) {}
}

export class DiagnosticRelatedInformation {
    constructor(public location: unknown, public message: string) {}
}

export enum DiagnosticSeverity { Error = 0, Warning = 1, Information = 2, Hint = 3 }
export enum StatusBarAlignment { Left = 1, Right = 2 }

export class Range {
    constructor(public start: Position, public end: Position) {}
}

export const commands = {
    registerCommand: jest.fn(() => ({ dispose: jest.fn() })),
    executeCommand: jest.fn(),
};

export const env = {
    openExternal: jest.fn(),
};
