import type * as vscode from 'vscode';

import type { ValidationIssueSummary } from './types';
import { IssueSeverity, type ValidationIssue } from '../validation/types';

interface BuildIssueSummariesOptions {
    outputUri?: vscode.Uri;
    traceMap?: Map<number, vscode.Location>;
}

export function buildIssueSummaries(
    issues: ValidationIssue[],
    options: BuildIssueSummariesOptions = {},
): ValidationIssueSummary[] {
    return issues.map(issue => {
        const traceLoc = issue.line > 0 ? options.traceMap?.get(issue.line) : undefined;
        return {
            severity: issue.severity === IssueSeverity.Error
                ? 'error'
                : issue.severity === IssueSeverity.Warning
                    ? 'warning'
                    : 'info',
            message: issue.message,
            ruleId: issue.ruleId,
            source: issue.source,
            line: issue.line,
            column: issue.column,
            xsltLine: traceLoc ? traceLoc.range.start.line + 1 : undefined,
            xsltPath: traceLoc?.uri.fsPath,
            outputUri: options.outputUri?.toString(),
        };
    });
}

export function countIssueSummaries(issues: ValidationIssueSummary[]): {
    errorCount: number;
    warningCount: number;
    infoCount: number;
} {
    return {
        errorCount: issues.filter(issue => issue.severity === 'error').length,
        warningCount: issues.filter(issue => issue.severity === 'warning').length,
        infoCount: issues.filter(issue => issue.severity === 'info').length,
    };
}
