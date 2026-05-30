/**
 * Unit tests for PhiveRunner JSON output parsing as consumed by validateSchematron.
 *
 * runPhiveRunner and writeTempFile are mocked so no Java process or temp file I/O occurs.
 */

import { IssueSeverity } from '../validation/types';
import { SchematronRuleset } from '../validation/types';
import { PhiveRunnerOutput } from '../utils/javaRunner';

jest.mock('../utils/javaRunner', () => ({
    ...jest.requireActual('../utils/javaRunner'),
    runPhiveRunner: jest.fn(),
    ensureJava: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../utils/tempFile', () => ({
    writeTempFile: jest.fn().mockReturnValue({ filePath: '/tmp/test.xml', cleanup: jest.fn() }),
}));

import { validateSchematron, validateSchematronWithMetadata } from '../validation/schematronValidator';
import { runPhiveRunner } from '../utils/javaRunner';

const mockRunner = runPhiveRunner as jest.MockedFunction<typeof runPhiveRunner>;

const RULESETS = [SchematronRuleset.Peppol];
const DETECTED_OUTPUT: PhiveRunnerOutput = {
    profile: 'eu.peppol.bis3.ubl.invoice:2025.11.0',
    vesid:   'eu.peppol.bis3.ubl.invoice:2025.11.0',
    dddDetected: true,
    issues: [],
    ruleResults: [],
};

beforeEach(() => mockRunner.mockReset());

// ---------------------------------------------------------------------------
// Early-exit guards
// ---------------------------------------------------------------------------

describe('validateSchematron — early-exit guards', () => {
    it('returns [] without calling runner when rulesets is empty', async () => {
        const result = await validateSchematron('xml', [], '/art', '/ext', '/jars');
        expect(result).toEqual([]);
        expect(mockRunner).not.toHaveBeenCalled();
    });

    it('returns [] without calling runner when phiveJarsDir is absent', async () => {
        const result = await validateSchematron('xml', RULESETS, '/art', '/ext');
        expect(result).toEqual([]);
        expect(mockRunner).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// DDD detection results
// ---------------------------------------------------------------------------

describe('validateSchematron — DDD detection', () => {
    it('returns [] when dddDetected is false and no error', async () => {
        mockRunner.mockResolvedValue({ profile: null, vesid: null, dddDetected: false, issues: [], ruleResults: [] });
        const result = await validateSchematron('xml', RULESETS, '/art', '/ext', '/jars');
        expect(result).toEqual([]);
    });

    it('returns an error issue when result.error is set (fatal runner exit)', async () => {
        mockRunner.mockResolvedValue({
            profile: null, vesid: null, dddDetected: false, issues: [],
            ruleResults: [],
            error: 'No VES registered for VESID: foo:bar:1.0',
        });
        const result = await validateSchematron('xml', RULESETS, '/art', '/ext', '/jars');
        expect(result).toHaveLength(1);
        expect(result[0].severity).toBe(IssueSeverity.Error);
        expect(result[0].message).toContain('No VES registered');
        expect(result[0].source).toBe('local-schematron');
        expect(result[0].line).toBe(1);
    });

    it('returns an error issue when runPhiveRunner throws', async () => {
        mockRunner.mockRejectedValue(new Error('PhiveRunner invalid JSON (exit 1): classpath error'));
        const result = await validateSchematron('xml', RULESETS, '/art', '/ext', '/jars');
        expect(result).toHaveLength(1);
        expect(result[0].severity).toBe(IssueSeverity.Error);
        expect(result[0].message).toContain('PhiveRunner invalid JSON');
    });
});

// ---------------------------------------------------------------------------
// Severity mapping
// ---------------------------------------------------------------------------

describe('validateSchematron — severity mapping', () => {
    function withIssues(issues: PhiveRunnerOutput['issues']): PhiveRunnerOutput {
        return { ...DETECTED_OUTPUT, issues };
    }

    it('maps ERROR to IssueSeverity.Error', async () => {
        mockRunner.mockResolvedValue(withIssues([
            { severity: 'ERROR', ruleId: 'PEPPOL-R010', message: 'Missing element', line: 42, column: 8, test: null, location: null },
        ]));
        const result = await validateSchematron('xml', RULESETS, '/art', '/ext', '/jars');
        expect(result[0].severity).toBe(IssueSeverity.Error);
    });

    it('maps WARNING to IssueSeverity.Warning', async () => {
        mockRunner.mockResolvedValue(withIssues([
            { severity: 'WARNING', ruleId: 'PEPPOL-W001', message: 'Recommendation', line: 5, column: 0, test: null, location: null },
        ]));
        const result = await validateSchematron('xml', RULESETS, '/art', '/ext', '/jars');
        expect(result[0].severity).toBe(IssueSeverity.Warning);
    });

    it('maps INFORMATION to IssueSeverity.Information', async () => {
        mockRunner.mockResolvedValue(withIssues([
            { severity: 'INFORMATION', ruleId: null, message: 'Info note', line: 1, column: 0, test: null, location: null },
        ]));
        const result = await validateSchematron('xml', RULESETS, '/art', '/ext', '/jars');
        expect(result[0].severity).toBe(IssueSeverity.Information);
    });
});

// ---------------------------------------------------------------------------
// Field mapping
// ---------------------------------------------------------------------------

describe('validateSchematron — field mapping', () => {
    function singleIssue(overrides: Partial<PhiveRunnerOutput['issues'][0]> = {}): PhiveRunnerOutput {
        return {
            ...DETECTED_OUTPUT,
            issues: [{
                severity: 'ERROR', ruleId: 'RULE-1', message: 'msg', line: 10, column: 5, test: null, location: null,
                ...overrides,
            }],
        };
    }

    it('preserves ruleId when present', async () => {
        mockRunner.mockResolvedValue(singleIssue({ ruleId: 'PEPPOL-EN16931-R010' }));
        const result = await validateSchematron('xml', RULESETS, '/art', '/ext', '/jars');
        expect(result[0].ruleId).toBe('PEPPOL-EN16931-R010');
    });

    it('converts null ruleId to undefined', async () => {
        mockRunner.mockResolvedValue(singleIssue({ ruleId: null }));
        const result = await validateSchematron('xml', RULESETS, '/art', '/ext', '/jars');
        expect(result[0].ruleId).toBeUndefined();
    });

    it('preserves non-zero line numbers', async () => {
        mockRunner.mockResolvedValue(singleIssue({ line: 42 }));
        const result = await validateSchematron('xml', RULESETS, '/art', '/ext', '/jars');
        expect(result[0].line).toBe(42);
    });

    it('defaults line 0 to 1', async () => {
        mockRunner.mockResolvedValue(singleIssue({ line: 0 }));
        const result = await validateSchematron('xml', RULESETS, '/art', '/ext', '/jars');
        expect(result[0].line).toBe(1);
    });

    it('preserves column as-is (including 0)', async () => {
        mockRunner.mockResolvedValue(singleIssue({ column: 0 }));
        const result = await validateSchematron('xml', RULESETS, '/art', '/ext', '/jars');
        expect(result[0].column).toBe(0);
    });

    it('maps multiple issues in order', async () => {
        mockRunner.mockResolvedValue({
            ...DETECTED_OUTPUT,
            issues: [
                { severity: 'ERROR',   ruleId: 'R1', message: 'first',  line: 1, column: 0, test: null, location: null },
                { severity: 'WARNING', ruleId: 'R2', message: 'second', line: 2, column: 0, test: null, location: null },
            ],
        });
        const result = await validateSchematron('xml', RULESETS, '/art', '/ext', '/jars');
        expect(result).toHaveLength(2);
        expect(result[0].message).toBe('first');
        expect(result[1].message).toBe('second');
    });

    it('returns [] when dddDetected is true but issues array is empty', async () => {
        mockRunner.mockResolvedValue({ ...DETECTED_OUTPUT, issues: [] });
        const result = await validateSchematron('xml', RULESETS, '/art', '/ext', '/jars');
        expect(result).toEqual([]);
    });

    it('ignores additive ruleResults metadata when mapping issues', async () => {
        mockRunner.mockResolvedValue({
            ...singleIssue({ ruleId: 'PEPPOL-EN16931-R010', message: 'Mapped issue' }),
            ruleResults: [
                {
                    ruleId: 'layer:peppol',
                    description: 'Peppol layer',
                    status: 'skipped',
                    passed: false,
                    source: 'phive',
                },
                {
                    ruleId: 'PEPPOL-EN16931-R010',
                    description: 'Mapped issue',
                    status: 'failed',
                    passed: false,
                    source: 'phive',
                },
                {
                    ruleId: 'layer:en16931',
                    description: 'EN16931 layer',
                    status: 'passed',
                    passed: true,
                    source: 'phive',
                },
            ],
        });
        const result = await validateSchematron('xml', RULESETS, '/art', '/ext', '/jars');
        expect(result).toHaveLength(1);
        expect(result[0].ruleId).toBe('PEPPOL-EN16931-R010');
        expect(result[0].message).toBe('Mapped issue');
    });

    it('returns PHIVE ruleResults metadata for callers that render active rules', async () => {
        const ruleResults = [
            {
                ruleId: 'ubl-credit-note',
                description: 'external/schemas/ubl21/maindoc/UBL-CreditNote-2.1.xsd',
                status: 'failed' as const,
                passed: false,
                source: 'phive' as const,
            },
            {
                ruleId: 'cen-en16931',
                description: 'external/schematron/openpeppol/2025.11/xslt/CEN-EN16931-UBL.xslt',
                status: 'skipped' as const,
                passed: false,
                source: 'phive' as const,
            },
        ];
        mockRunner.mockResolvedValue({
            ...singleIssue({ ruleId: 'PEPPOL-EN16931-R010', message: 'Mapped issue' }),
            profile: 'eu.peppol.bis3.ubl.creditnote:2025.11.0',
            ruleResults,
        });

        const result = await validateSchematronWithMetadata('xml', RULESETS, '/art', '/ext', '/jars');

        expect(result.issues).toHaveLength(1);
        expect(result.ruleResults).toEqual(ruleResults);
        expect(result.detectedProfile).toBe('eu.peppol.bis3.ubl.creditnote:2025.11.0');
    });
});
