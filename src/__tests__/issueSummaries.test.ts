import * as vscode from 'vscode';

import { buildIssueSummaries, countIssueSummaries } from '../webview/issueSummaries';
import { IssueSeverity, type ValidationIssue } from '../validation/types';

describe('issueSummaries', () => {
    it('attaches trace data and output uri for transform issues', () => {
        const issues: ValidationIssue[] = [{
            severity: IssueSeverity.Error,
            message: 'Broken rule',
            ruleId: 'PEPPOL-EN16931-R001',
            source: 'local-schematron',
            line: 12,
            column: 3,
        }];
        const traceMap = new Map<number, vscode.Location>([
            [12, new vscode.Location(
                vscode.Uri.file('/workspace/transform.xsl'),
                new vscode.Range(new vscode.Position(7, 0), new vscode.Position(7, 10)),
            )],
        ]);

        expect(buildIssueSummaries(issues, {
            traceMap,
            outputUri: vscode.Uri.parse('untitled:xslt-studio-output.xml'),
        })).toEqual([{
            severity: 'error',
            message: 'Broken rule',
            ruleId: 'PEPPOL-EN16931-R001',
            source: 'local-schematron',
            line: 12,
            column: 3,
            xsltLine: 8,
            xsltPath: '/workspace/transform.xsl',
            outputUri: 'untitled:xslt-studio-output.xml',
        }]);
    });

    it('counts error, warning, and info summaries', () => {
        const counts = countIssueSummaries([
            { severity: 'error', message: 'e', source: 'local-xsd', line: 1, column: 0 },
            { severity: 'warning', message: 'w', source: 'local-xsd', line: 1, column: 0 },
            { severity: 'info', message: 'i', source: 'helger', line: 1, column: 0 },
        ]);

        expect(counts).toEqual({
            errorCount: 1,
            warningCount: 1,
            infoCount: 1,
        });
    });
});
