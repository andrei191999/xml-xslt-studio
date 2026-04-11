import * as vscode from 'vscode';
import { ValidationIssue, ValidationResult } from './types';
import { TracedIssue } from '../tracing/errorTraceMapper';

// Store traced issues per URI so the AI agent can retrieve full trace data from a diagnostic
const tracedIssueStore = new Map<string, TracedIssue[]>();

export function storeTracedIssues(uri: vscode.Uri, issues: TracedIssue[]): void {
    tracedIssueStore.set(uri.toString(), issues);
}

export function getTracedIssue(uri: vscode.Uri, diagnostic: vscode.Diagnostic): TracedIssue | undefined {
    const issues = tracedIssueStore.get(uri.toString());
    if (!issues) {
        return undefined;
    }
    const line = diagnostic.range.start.line + 1; // Convert back to 1-indexed
    return issues.find(i =>
        i.line === line && i.message === diagnostic.message
    );
}

export function getTracedIssues(uri: vscode.Uri): TracedIssue[] | undefined {
    return tracedIssueStore.get(uri.toString());
}

export function reportDiagnostics(
    collection: vscode.DiagnosticCollection,
    uri: vscode.Uri,
    issues: ValidationIssue[]
): void {
    const diagnostics: vscode.Diagnostic[] = issues.map(issue => {
        const line = Math.max(0, issue.line - 1); // VS Code is 0-indexed
        const range = new vscode.Range(line, issue.column, line, Number.MAX_SAFE_INTEGER);

        const diagnostic = new vscode.Diagnostic(range, issue.message, issue.severity);
        diagnostic.source = `ubl-${issue.source}`;
        if (issue.ruleId) {
            diagnostic.code = issue.ruleId;
        }

        return diagnostic;
    });

    collection.set(uri, diagnostics);
}

export function reportTracedDiagnostics(
    collection: vscode.DiagnosticCollection,
    outputUri: vscode.Uri,
    tracedIssues: TracedIssue[]
): void {
    const diagnostics: vscode.Diagnostic[] = tracedIssues.map(issue => {
        const line = Math.max(0, issue.line - 1);
        const range = new vscode.Range(line, issue.column, line, Number.MAX_SAFE_INTEGER);
        const diagnostic = new vscode.Diagnostic(range, issue.message, issue.severity);
        diagnostic.source = `ubl-${issue.source}`;
        if (issue.ruleId) {
            diagnostic.code = issue.ruleId;
        }

        // Add related information linking to the exact XSLT source line
        if (issue.xsltSourceFile && issue.xsltSourceLine) {
            const xsltUri = vscode.Uri.file(issue.xsltSourceFile);
            const xsltLine = Math.max(0, issue.xsltSourceLine - 1);
            const xsltRange = new vscode.Range(xsltLine, 0, xsltLine, Number.MAX_SAFE_INTEGER);
            const elementInfo = issue.xsltElementName
                ? `<${issue.xsltElementName}>`
                : 'element';
            diagnostic.relatedInformation = [
                new vscode.DiagnosticRelatedInformation(
                    new vscode.Location(xsltUri, xsltRange),
                    `Produced by ${elementInfo} in XSLT at line ${issue.xsltSourceLine}`
                ),
            ];
        }

        return diagnostic;
    });

    collection.set(outputUri, diagnostics);

    // Store traced issues for AI agent retrieval
    storeTracedIssues(outputUri, tracedIssues);
}

export function showSummaryNotification(result: ValidationResult): void {
    const errors = result.issues.filter(
        i => i.severity === vscode.DiagnosticSeverity.Error
    ).length;
    const warnings = result.issues.filter(
        i => i.severity === vscode.DiagnosticSeverity.Warning
    ).length;

    if (errors === 0 && warnings === 0) {
        vscode.window.showInformationMessage(
            'UBL Validation passed - no errors or warnings found.'
        );
        return;
    }

    const parts: string[] = [];
    if (errors > 0) {
        parts.push(`${errors} error${errors !== 1 ? 's' : ''}`);
    }
    if (warnings > 0) {
        parts.push(`${warnings} warning${warnings !== 1 ? 's' : ''}`);
    }

    const summary = `UBL Validation: ${parts.join(', ')} found.`;
    const details: string[] = [];

    if (!result.xsdPassed) {
        details.push('XSD');
    }
    if (result.en16931Passed === false) {
        details.push('EN16931');
    }
    if (result.peppolPassed === false) {
        details.push('Peppol');
    }

    const failedSources = details.length > 0
        ? ` Failed: ${details.join(', ')}.`
        : '';

    if (errors > 0) {
        vscode.window.showErrorMessage(`${summary}${failedSources}`);
    } else {
        vscode.window.showWarningMessage(`${summary}${failedSources}`);
    }
}
