import * as vscode from 'vscode';

const AI_FIX_SOURCES = new Set(['[Local-XSD]', '[Local-SCH]', '[Helger]']);

export class AiFixCodeActionProvider implements vscode.CodeActionProvider {
    public static readonly providedCodeActionKinds = [
        vscode.CodeActionKind.QuickFix,
    ];

    public static readonly documentSelector: vscode.DocumentSelector = [{ language: 'xml' }];

    provideCodeActions(
        _document: vscode.TextDocument,
        _range: vscode.Range,
        context: vscode.CodeActionContext
    ): vscode.CodeAction[] {
        const actions: vscode.CodeAction[] = [];

        for (const diagnostic of context.diagnostics) {
            if (!diagnostic.source || !AI_FIX_SOURCES.has(diagnostic.source)) {
                continue;
            }

            // Only offer AI fix when there's an XSLT source trace (relatedInformation)
            if (!diagnostic.relatedInformation || diagnostic.relatedInformation.length === 0) {
                continue;
            }

            const action = new vscode.CodeAction(
                'Fix with AI',
                vscode.CodeActionKind.QuickFix
            );
            action.command = {
                command: 'xmlXslt.fixThisError',
                title: 'AI: Fix this error',
                arguments: [diagnostic],
            };
            action.diagnostics = [diagnostic];
            // Not preferred — "Go to XSLT" stays preferred
            action.isPreferred = false;
            actions.push(action);
        }

        return actions;
    }
}
