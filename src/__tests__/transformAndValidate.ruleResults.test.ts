import type { XmlXsltConfig } from '../config/settings';
import type { UblDocumentInfo } from '../validation/types';
import type { PhiveRunnerOutput, PhiveRunnerRuleResult, SaxonTransformResult } from '../utils/javaRunner';

jest.mock('../utils/javaRunner', () => ({
    runSaxonTransform: jest.fn(),
    runPhiveRunner: jest.fn(),
    getActiveJarsDir: jest.fn().mockReturnValue('/jars'),
}));

jest.mock('../utils/tempFile', () => ({
    writeTempFile: jest.fn(),
}));

jest.mock('../validation/documentDetector', () => ({
    detectUblDocumentFromContent: jest.fn(),
}));

jest.mock('../validation/xsdValidator', () => ({
    validateXsd: jest.fn(),
}));

jest.mock('../validation/helgerValidator', () => ({
    validateHelger: jest.fn().mockResolvedValue([]),
}));

jest.mock('../tracing/saxonTracer', () => ({
    parseSaxonTrace: jest.fn().mockReturnValue(new Map()),
}));

import { runPipeline } from '../pipeline/transformAndValidate';
import { detectUblDocumentFromContent } from '../validation/documentDetector';
import { writeTempFile } from '../utils/tempFile';
import { runPhiveRunner, runSaxonTransform } from '../utils/javaRunner';

const mockWriteTempFile = writeTempFile as jest.MockedFunction<typeof writeTempFile>;
const mockDetectUblDocumentFromContent = detectUblDocumentFromContent as jest.MockedFunction<typeof detectUblDocumentFromContent>;
const mockRunPhiveRunner = runPhiveRunner as jest.MockedFunction<typeof runPhiveRunner>;
const mockRunSaxonTransform = runSaxonTransform as jest.MockedFunction<typeof runSaxonTransform>;

const BASE_CONFIG: XmlXsltConfig = {
    transform: {
        outputDestination: 'newTab',
        defaultOutputExtension: 'xml',
        enableTracing: false,
    },
    validation: {
        enableAutoValidate: true,
        enableHelger: false,
        helgerEndpoint: 'https://example.test/helger',
        helgerVesidVersion: 'latest',
        helgerTimeoutMs: 15000,
        enableSchematronEN16931: true,
        enableSchematronPeppol: true,
    },
    phive: {
        checkForUpdates: false,
        feedUrl: 'https://example.test/feed.json',
        checkIntervalDays: 7,
    },
    ai: {
        provider: 'openai',
        model: '',
        vertexProject: '',
        vertexRegion: 'us-east5',
        maxRetries: 3,
    },
};

const DOCUMENT_INFO: UblDocumentInfo = {
    rootElement: 'Invoice',
    namespace: 'urn:oasis:names:specification:ubl:schema:xsd:Invoice-2',
    docType: 'Invoice',
    xsdPath: 'C:/artifacts/UBL-Invoice-2.1.xsd',
};

function makeSaxonResult(stdout: string): SaxonTransformResult {
    return {
        stdout,
        traceXml: '',
    };
}

function makePipelineOptions(config: XmlXsltConfig = BASE_CONFIG) {
    return {
        xmlContent: '<source/>',
        xsltPath: 'C:/tmp/template.xslt',
        extensionPath: 'C:/ext',
        artifactsPath: 'C:/ext/validation-artifacts',
        globalStorageFsPath: 'C:/global',
        config,
    };
}

beforeEach(() => {
    mockWriteTempFile.mockReset();
    mockDetectUblDocumentFromContent.mockReset();
    mockRunPhiveRunner.mockReset();
    mockRunSaxonTransform.mockReset();
});

describe('runPipeline ruleResults', () => {
    it('returns phive ruleResults when PHIVE validation runs', async () => {
        const sourceCleanup = jest.fn();
        const phiveCleanup = jest.fn();
        const ruleResults: PhiveRunnerRuleResult[] = [
            {
                ruleId: 'PEPPOL-EN16931-R010',
                description: 'Missing element',
                status: 'failed',
                passed: false,
                source: 'phive',
            },
        ];
        const phiveOutput: PhiveRunnerOutput = {
            profile: 'eu.peppol.bis3.ubl.invoice:2025.11.0',
            vesid: 'eu.peppol.bis3.ubl.invoice:2025.11.0',
            dddDetected: true,
            issues: [],
            ruleResults,
        };

        mockWriteTempFile
            .mockReturnValueOnce({ filePath: 'C:/tmp/source.xml', cleanup: sourceCleanup })
            .mockReturnValueOnce({ filePath: 'C:/tmp/output.xml', cleanup: phiveCleanup });
        mockRunSaxonTransform.mockResolvedValue(makeSaxonResult('<Invoice/>'));
        mockDetectUblDocumentFromContent.mockReturnValue(DOCUMENT_INFO);
        mockRunPhiveRunner.mockResolvedValue(phiveOutput);

        const result = await runPipeline(makePipelineOptions());

        expect(result.ruleResults).toEqual(ruleResults);
        expect(mockRunPhiveRunner).toHaveBeenCalledTimes(1);
    });

    it('returns empty ruleResults when auto-validate is disabled', async () => {
        const sourceCleanup = jest.fn();

        mockWriteTempFile.mockReturnValueOnce({ filePath: 'C:/tmp/source.xml', cleanup: sourceCleanup });
        mockRunSaxonTransform.mockResolvedValue(makeSaxonResult('<Invoice/>'));
        mockDetectUblDocumentFromContent.mockReturnValue(DOCUMENT_INFO);

        const result = await runPipeline(
            makePipelineOptions({
                ...BASE_CONFIG,
                validation: {
                    ...BASE_CONFIG.validation,
                    enableAutoValidate: false,
                },
            }),
        );

        expect(result.ruleResults).toEqual([]);
        expect(mockRunPhiveRunner).not.toHaveBeenCalled();
    });

    it('returns phive ruleResults when PHIVE output includes an error', async () => {
        const sourceCleanup = jest.fn();
        const phiveCleanup = jest.fn();
        const ruleResults: PhiveRunnerRuleResult[] = [
            {
                ruleId: 'PEPPOL-EN16931-R055',
                description: 'Fatal validation branch still carries rule metadata',
                status: 'failed',
                passed: false,
                source: 'phive',
            },
        ];
        const phiveOutput: PhiveRunnerOutput = {
            profile: 'eu.peppol.bis3.ubl.invoice:2025.11.0',
            vesid: 'eu.peppol.bis3.ubl.invoice:2025.11.0',
            dddDetected: true,
            issues: [],
            error: 'PHIVE execution failed',
            ruleResults,
        };

        mockWriteTempFile
            .mockReturnValueOnce({ filePath: 'C:/tmp/source.xml', cleanup: sourceCleanup })
            .mockReturnValueOnce({ filePath: 'C:/tmp/output.xml', cleanup: phiveCleanup });
        mockRunSaxonTransform.mockResolvedValue(makeSaxonResult('<Invoice/>'));
        mockDetectUblDocumentFromContent.mockReturnValue(DOCUMENT_INFO);
        mockRunPhiveRunner.mockResolvedValue(phiveOutput);

        const result = await runPipeline(makePipelineOptions());

        expect(result.ruleResults).toEqual(ruleResults);
        expect(result.issues).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    source: 'local-schematron',
                    message: 'Phive validation error: PHIVE execution failed',
                }),
            ]),
        );
    });

    it('returns empty ruleResults when the transform output is not recognized as UBL', async () => {
        const sourceCleanup = jest.fn();

        mockWriteTempFile.mockReturnValueOnce({ filePath: 'C:/tmp/source.xml', cleanup: sourceCleanup });
        mockRunSaxonTransform.mockResolvedValue(makeSaxonResult('<root/>'));
        mockDetectUblDocumentFromContent.mockReturnValue(null);

        const result = await runPipeline(makePipelineOptions());

        expect(result.ruleResults).toEqual([]);
        expect(mockRunPhiveRunner).not.toHaveBeenCalled();
    });
});
