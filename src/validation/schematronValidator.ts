import { IssueSeverity, ValidationIssue, SchematronRuleset } from './types';
import { writeTempFile } from '../utils/tempFile';
import { runPhiveRunner, PhiveRunnerIssue, type PhiveRunnerRuleResult } from '../utils/javaRunner';

export interface SchematronValidationResult {
    issues: ValidationIssue[];
    ruleResults: PhiveRunnerRuleResult[];
    detectedProfile?: string;
}

export async function validateSchematron(
    xmlContent: string,
    rulesets: SchematronRuleset[],
    _artifactsPath: string,
    extensionPath: string,
    phiveJarsDir?: string
): Promise<ValidationIssue[]> {
    return (await validateSchematronWithMetadata(xmlContent, rulesets, _artifactsPath, extensionPath, phiveJarsDir)).issues;
}

export async function validateSchematronWithMetadata(
    xmlContent: string,
    rulesets: SchematronRuleset[],
    _artifactsPath: string,
    extensionPath: string,
    phiveJarsDir?: string
): Promise<SchematronValidationResult> {
    if (rulesets.length === 0 || !phiveJarsDir) {
        return { issues: [], ruleResults: [] };
    }

    const tmp = writeTempFile(xmlContent, '.xml');
    try {
        const result = await runPhiveRunner({ extensionPath, xmlFilePath: tmp.filePath, phiveJarsDir });

        if (result.error) {
            return {
                issues: [{
                    severity: IssueSeverity.Error,
                    message: `Phive validation failed: ${result.error}`,
                    source: 'local-schematron',
                    ruleId: undefined,
                    line: 1,
                    column: 0,
                }],
                ruleResults: result.ruleResults,
                detectedProfile: result.profile ?? result.vesid ?? undefined,
            };
        }
        if (!result.dddDetected) {
            return { issues: [], ruleResults: result.ruleResults, detectedProfile: result.profile ?? result.vesid ?? undefined };
        }
        return {
            issues: mapPhiveIssues(result.issues),
            ruleResults: result.ruleResults,
            detectedProfile: result.profile ?? result.vesid ?? undefined,
        };
    } catch (err) {
        return {
            issues: [{
                severity: IssueSeverity.Error,
                message: `Phive runner error: ${err instanceof Error ? err.message : String(err)}`,
                source: 'local-schematron',
                ruleId: undefined,
                line: 1,
                column: 0,
            }],
            ruleResults: [],
        };
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
