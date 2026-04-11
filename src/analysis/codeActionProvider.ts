import * as vscode from 'vscode';

/**
 * CodeActionProvider for Quick Fix integration on missing-element diagnostics.
 * When a diagnostic has relatedInformation pointing to an XSLT template,
 * this provides a "Go to XSLT template" action and a stub "Add missing element" action.
 */
export class MissingElementCodeActionProvider implements vscode.CodeActionProvider {
    public static readonly providedCodeActionKinds = [
        vscode.CodeActionKind.QuickFix,
    ];

    provideCodeActions(
        document: vscode.TextDocument,
        range: vscode.Range,
        context: vscode.CodeActionContext,
    ): vscode.CodeAction[] {
        const actions: vscode.CodeAction[] = [];

        for (const diagnostic of context.diagnostics) {
            if (!isMissingElementDiagnostic(diagnostic)) {
                continue;
            }

            // Extract the missing element name from the diagnostic message
            const missingElement = extractMissingElement(diagnostic.message);
            if (!missingElement) {
                continue;
            }

            // If there's related information pointing to an XSLT source
            if (diagnostic.relatedInformation && diagnostic.relatedInformation.length > 0) {
                const related = diagnostic.relatedInformation[0];
                const goToAction = new vscode.CodeAction(
                    `Go to XSLT template that produces this section`,
                    vscode.CodeActionKind.QuickFix
                );
                goToAction.command = {
                    command: 'vscode.open',
                    title: 'Open XSLT Template',
                    arguments: [
                        related.location.uri,
                        { selection: related.location.range },
                    ],
                };
                goToAction.diagnostics = [diagnostic];
                goToAction.isPreferred = true;
                actions.push(goToAction);
            }

            // Suggest adding the missing element
            const addAction = new vscode.CodeAction(
                `Add <cbc:${missingElement}> element (stub)`,
                vscode.CodeActionKind.QuickFix
            );
            addAction.diagnostics = [diagnostic];
            // Insert a stub element at the diagnostic line
            const insertPosition = new vscode.Position(diagnostic.range.start.line + 1, 0);
            addAction.edit = new vscode.WorkspaceEdit();
            addAction.edit.insert(
                document.uri,
                insertPosition,
                `    <cbc:${missingElement}>TODO</cbc:${missingElement}>\n`
            );
            actions.push(addAction);
        }

        return actions;
    }
}

function isMissingElementDiagnostic(diagnostic: vscode.Diagnostic): boolean {
    const msg = diagnostic.message.toLowerCase();
    return (
        msg.includes('missing child element') ||
        msg.includes('must exist') ||
        msg.includes('is mandatory') ||
        msg.includes('shall exist') ||
        (msg.includes('missing') && (msg.includes('element') || msg.includes('cbc:') || msg.includes('cac:')))
    );
}

function extractMissingElement(message: string): string | null {
    // Try various patterns
    const patterns = [
        /Expected.*?\{[^}]*\}(\w+)/i,
        /missing.*?(?:cbc:|cac:)(\w+)/i,
        /element.*?'(?:\{[^}]*\})?(\w+)'.*?must exist/i,
    ];
    for (const p of patterns) {
        const m = message.match(p);
        if (m && m[1]) {
            return m[1];
        }
    }
    return null;
}
