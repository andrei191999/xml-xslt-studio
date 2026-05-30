import {
    clearLastValidationExport,
    getLastValidationExport,
    hasPhiveHtmlExportableRuleResults,
    setLastValidationExport,
    type LastValidationExportSnapshot,
} from '../state/lastValidationExport';
import type { PhiveRunnerRuleResult } from '../utils/javaRunner';

type LegacyPhiveRunnerRuleResult = Omit<PhiveRunnerRuleResult, 'status'> & {
    status?: PhiveRunnerRuleResult['status'];
};

function makeSnapshot(overrides: Partial<LastValidationExportSnapshot> = {}): LastValidationExportSnapshot {
    return {
        timestamp: 1715887845123,
        xmlPath: 'C:/tmp/input.xml',
        xsltPath: 'C:/tmp/template.xslt',
        detectedProfile: 'eu.peppol.bis3:invoice:2025.11.0',
        validatedXmlContent: '<Invoice/>',
        ...overrides,
    };
}

describe('lastValidationExport', () => {
    afterEach(() => {
        clearLastValidationExport();
    });

    it('returns undefined before a snapshot is stored', () => {
        expect(getLastValidationExport()).toBeUndefined();
    });

    it('stores and returns the latest snapshot', () => {
        const snapshot = makeSnapshot();

        setLastValidationExport(snapshot);

        expect(getLastValidationExport()).toEqual(snapshot);
    });

    it('clears the stored snapshot', () => {
        setLastValidationExport(makeSnapshot());

        clearLastValidationExport();

        expect(getLastValidationExport()).toBeUndefined();
    });

    it('returns false for empty rule results', () => {
        expect(hasPhiveHtmlExportableRuleResults([])).toBe(false);
    });

    it('returns false for non-phive rows', () => {
        const ruleResults: PhiveRunnerRuleResult[] = [
            { ruleId: 'xsd-1', description: 'xsd', passed: true, source: 'xsd', status: 'passed' },
            { ruleId: 'sch-1', description: 'schematron', passed: false, source: 'schematron', status: 'failed' },
        ];

        expect(hasPhiveHtmlExportableRuleResults(ruleResults)).toBe(false);
    });

    it('returns false for skipped phive rows', () => {
        const ruleResults: PhiveRunnerRuleResult[] = [
            { ruleId: 'phive-skip', description: 'skipped', passed: false, source: 'phive', status: 'skipped' },
        ];

        expect(hasPhiveHtmlExportableRuleResults(ruleResults)).toBe(false);
    });

    it('returns true for passed phive rows', () => {
        const ruleResults: PhiveRunnerRuleResult[] = [
            { ruleId: 'phive-pass', description: 'passed', passed: true, source: 'phive', status: 'passed' },
        ];

        expect(hasPhiveHtmlExportableRuleResults(ruleResults)).toBe(true);
    });

    it('returns true for failed phive rows', () => {
        const ruleResults: PhiveRunnerRuleResult[] = [
            { ruleId: 'phive-fail', description: 'failed', passed: false, source: 'phive', status: 'failed' },
        ];

        expect(hasPhiveHtmlExportableRuleResults(ruleResults)).toBe(true);
    });

    it('treats legacy phive rows without status as exportable', () => {
        const ruleResults: LegacyPhiveRunnerRuleResult[] = [
            { ruleId: 'phive-legacy', description: 'legacy', passed: true, source: 'phive' },
        ];

        expect(hasPhiveHtmlExportableRuleResults(ruleResults)).toBe(true);
    });
});
