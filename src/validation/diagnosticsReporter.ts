import * as vscode from 'vscode';
import { IssueSeverity, ValidationIssue } from './types';
import { attachRelatedInfo } from '../tracing/errorTraceMapper';

// Source display strings used in diagnostic.source
const SOURCE_LABEL: Record<ValidationIssue['source'], string> = {
    'local-xsd': '[Local-XSD]',
    'local-schematron': '[Local-SCH]',
    'helger': '[Helger]',
};

// Store per-URI traceMap so code action providers can retrieve it
const traceMapStore = new Map<string, Map<number, vscode.Location>>();

export function getTraceMap(uri: vscode.Uri): Map<number, vscode.Location> | undefined {
    return traceMapStore.get(uri.toString());
}

export function reportDiagnostics(
    local: vscode.DiagnosticCollection,
    helger: vscode.DiagnosticCollection,
    outputUri: vscode.Uri,
    issues: ValidationIssue[],
    traceMap: Map<number, vscode.Location>
): void {
    // Normalize URI — untitled: is valid; fall back for unexpected schemes
    const normalizedUri = (outputUri.scheme === 'file' || outputUri.scheme === 'untitled')
        ? outputUri
        : vscode.Uri.parse('xml-xslt-output://result');

    // Clear both collections for this URI before writing new diagnostics
    local.delete(normalizedUri);
    helger.delete(normalizedUri);

    // Store traceMap for later retrieval
    traceMapStore.set(normalizedUri.toString(), traceMap);

    const localDiags: vscode.Diagnostic[] = [];
    const helgerDiags: vscode.Diagnostic[] = [];
    const seen = new Set<string>();

    for (const issue of issues) {
        const dedupKey = `${issue.line}:${issue.ruleId ?? issue.message}`;
        if (seen.has(dedupKey)) { continue; }
        seen.add(dedupKey);

        const line = Math.max(0, issue.line - 1);  // VS Code 0-indexed
        const range = new vscode.Range(line, issue.column, line, Number.MAX_SAFE_INTEGER);
        // Cast directly: IssueSeverity numeric values match vscode.DiagnosticSeverity
        const severity = issue.severity as unknown as vscode.DiagnosticSeverity;
        const message = (issue.ruleId && !issue.message.startsWith('['))
            ? `[${issue.ruleId}] ${issue.message}`
            : issue.message;
        if (!message) { continue; }
        const diag = new vscode.Diagnostic(range, message, severity);
        diag.source = SOURCE_LABEL[issue.source];
        if (issue.ruleId) { diag.code = issue.ruleId; }
        attachRelatedInfo(diag, issue.line, traceMap);

        if (issue.source === 'helger') {
            helgerDiags.push(diag);
        } else {
            localDiags.push(diag);
        }
    }

    local.set(normalizedUri, localDiags);
    helger.set(normalizedUri, helgerDiags);
}

export function reportXsltDiagnostics(
    xslt: vscode.DiagnosticCollection,
    xsltPath: string,
    issues: ValidationIssue[],
    traceMap: Map<number, vscode.Location>
): void {
    const xsltUri = vscode.Uri.file(xsltPath);
    xslt.delete(xsltUri);

    if (traceMap.size === 0) { return; }

    // Deduplicate by (xsltLine, message) — multiple output issues often map to same XSLT line
    const seen = new Set<string>();
    const diags: vscode.Diagnostic[] = [];

    for (const issue of issues) {
        const loc = traceMap.get(issue.line);
        if (!loc) { continue; }

        const key = `${loc.range.start.line}:${issue.message}`;
        if (seen.has(key)) { continue; }
        seen.add(key);

        const severity = issue.severity as unknown as vscode.DiagnosticSeverity;
        const diag = new vscode.Diagnostic(loc.range, issue.message, severity);
        diag.source = SOURCE_LABEL[issue.source] + ' (XSLT source)';
        if (issue.ruleId) { diag.code = issue.ruleId; }
        diags.push(diag);
    }

    if (diags.length > 0) {
        xslt.set(xsltUri, diags);
    }
}
