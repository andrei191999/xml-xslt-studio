import { IssueSeverity, ValidationIssue, SchematronRuleset } from './types';
import { writeTempFile } from '../utils/tempFile';
import { runPhiveRunner, PhiveRunnerIssue } from '../utils/javaRunner';

export async function validateSchematron(
    xmlContent: string,
    rulesets: SchematronRuleset[],
    _artifactsPath: string,
    extensionPath: string,
    phiveJarsDir?: string
): Promise<ValidationIssue[]> {
    if (rulesets.length === 0 || !phiveJarsDir) {
        return [];
    }

    const tmp = writeTempFile(xmlContent, '.xml');
    try {
        const result = await runPhiveRunner({ extensionPath, xmlFilePath: tmp.filePath, phiveJarsDir });

        if (result.error) {
            return [{
                severity: IssueSeverity.Error,
                message: `Phive validation failed: ${result.error}`,
                source: 'local-schematron',
                ruleId: undefined,
                line: 1,
                column: 0,
            }];
        }
        if (!result.dddDetected) {
            return [];
        }
        return mapPhiveIssues(result.issues);
    } catch (err) {
        return [{
            severity: IssueSeverity.Error,
            message: `Phive runner error: ${err instanceof Error ? err.message : String(err)}`,
            source: 'local-schematron',
            ruleId: undefined,
            line: 1,
            column: 0,
        }];
    } finally {
        tmp.cleanup();
    }
}

function mapPhiveIssues(phiveIssues: PhiveRunnerIssue[]): ValidationIssue[] {
    return phiveIssues.map(p => ({
        severity: p.severity === 'ERROR' ? IssueSeverity.Error
            : p.severity === 'WARNING' ? IssueSeverity.Warning
            : IssueSeverity.Information,
        message: p.message || '(no message text)',
        ruleId: p.ruleId ?? undefined,
        line: p.line || 1,
        column: p.column || 0,
        source: 'local-schematron' as const,
    }));
}
