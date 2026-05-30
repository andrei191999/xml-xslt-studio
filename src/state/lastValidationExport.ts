import type { PhiveRunnerRuleResult } from '../utils/javaRunner';

type ExportableRuleResult = Omit<PhiveRunnerRuleResult, 'status'> & {
    status?: PhiveRunnerRuleResult['status'];
};

export interface LastValidationExportSnapshot {
    timestamp: number;
    xmlPath: string;
    xsltPath?: string;
    detectedProfile?: string;
    validatedXmlContent: string;
}

let lastValidationExport: LastValidationExportSnapshot | undefined;

export function getLastValidationExport(): LastValidationExportSnapshot | undefined {
    return lastValidationExport;
}

export function setLastValidationExport(snapshot: LastValidationExportSnapshot): void {
    lastValidationExport = snapshot;
}

export function clearLastValidationExport(): void {
    lastValidationExport = undefined;
}

export function hasPhiveHtmlExportableRuleResults(ruleResults: ExportableRuleResult[] | undefined): boolean {
    return Array.isArray(ruleResults) && ruleResults.some((ruleResult) =>
        ruleResult.source === 'phive' && ruleResult.status !== 'skipped'
    );
}
