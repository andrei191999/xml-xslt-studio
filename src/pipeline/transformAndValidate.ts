import * as vscode from 'vscode';
import { execAsync, checkToolAvailable, getInstallInstructions } from '../utils/execAsync';
import { detectUblDocumentFromContent } from '../validation/documentDetector';
import { validateXsdFromContent } from '../validation/xsdValidator';
import { validateSchematronFromContent } from '../validation/schematronValidator';
import { UblDocumentInfo, ValidationIssue, ValidationResult, ValidationScope } from '../validation/types';
import { runInstrumentedTransform, TraceEntry } from '../tracing/xsltTracer';
import { mapIssuesToXsltSource, TracedIssue } from '../tracing/errorTraceMapper';
import { runSaxonTransform } from '../utils/javaRunner';

export interface TransformResult {
    output: string;
    isUbl: boolean;
    documentInfo: UblDocumentInfo | null;
    validationResult: ValidationResult | null;
    tracedIssues?: TracedIssue[];
    traceEntries?: TraceEntry[];
}

export interface PipelineOptions {
    sourceXml: string;
    xsltStylesheet: string;
    artifactsPath: string;
    extensionPath: string;
    validationScope?: ValidationScope;
    enableTracing?: boolean;
    onProgress?: (message: string) => void;
}

export async function transformAndValidate(options: PipelineOptions): Promise<TransformResult> {
    const { sourceXml, xsltStylesheet, artifactsPath, extensionPath, validationScope = 'full', enableTracing = false, onProgress } = options;

    const progress = (msg: string) => onProgress?.(msg);

    let output: string;
    let traceEntries: TraceEntry[] = [];

    if (enableTracing) {
        // Step 1 (traced): Run instrumented transform
        progress('Running instrumented XSLT transformation...');
        const traced = await runInstrumentedTransform(sourceXml, xsltStylesheet, extensionPath);
        output = traced.cleanOutput;
        traceEntries = traced.traceEntries;
    } else {
        // Step 1: Try xsltproc, fallback to bundled Saxon
        progress('Running XSLT transformation...');
        const xsltprocAvailable = await checkToolAvailable('xsltproc');

        if (xsltprocAvailable) {
            try {
                const result = await execAsync('xsltproc', [xsltStylesheet, sourceXml]);
                output = result.stdout;
            } catch (error: any) {
                if (error.stdout) {
                    output = error.stdout;
                } else {
                    throw new Error(`XSLT transformation failed: ${error.message}`);
                }
            }
        } else {
            // Fallback to bundled Saxon
            output = await runSaxonTransform(extensionPath, sourceXml, xsltStylesheet);
        }
    }

    // Step 2: Detect if output is UBL
    progress('Detecting document type...');
    const docInfo = detectUblDocumentFromContent(output);

    if (!docInfo) {
        // Not UBL - return output without validation
        return {
            output,
            isUbl: false,
            documentInfo: null,
            validationResult: null,
        };
    }

    // Step 3: Output is UBL - run validation
    const allIssues: ValidationIssue[] = [];
    const validationResult: ValidationResult = {
        issues: [],
        documentInfo: docInfo,
        xsdPassed: true,
        en16931Passed: null,
        peppolPassed: null,
    };

    // XSD validation
    if (validationScope === 'full' || validationScope === 'xsd-only') {
        progress('Running XSD validation...');
        try {
            const xsdIssues = await validateXsdFromContent(output, docInfo, artifactsPath, extensionPath);
            allIssues.push(...xsdIssues);
            validationResult.xsdPassed = xsdIssues.length === 0;
        } catch (error: any) {
            vscode.window.showErrorMessage(`XSD validation error: ${error.message}`);
            validationResult.xsdPassed = false;
        }
    }

    // EN16931 business rules (Invoice and CreditNote only)
    if ((validationScope === 'full' || validationScope === 'business-rules-only') && docInfo.isInvoiceOrCreditNote) {
        progress('Checking EN16931 business rules...');
        try {
            const en16931Issues = await validateSchematronFromContent(output, 'en16931', artifactsPath, extensionPath);
            allIssues.push(...en16931Issues);
            validationResult.en16931Passed = en16931Issues.filter(
                i => i.severity === vscode.DiagnosticSeverity.Error
            ).length === 0;
        } catch (error: any) {
            vscode.window.showErrorMessage(`EN16931 validation error: ${error.message}`);
            validationResult.en16931Passed = false;
        }
    }

    // Peppol BIS 3.0 rules (Invoice and CreditNote only)
    if ((validationScope === 'full' || validationScope === 'business-rules-only') && docInfo.isInvoiceOrCreditNote) {
        progress('Checking Peppol BIS 3.0 rules...');
        try {
            const peppolIssues = await validateSchematronFromContent(output, 'peppol', artifactsPath, extensionPath);
            allIssues.push(...peppolIssues);
            validationResult.peppolPassed = peppolIssues.filter(
                i => i.severity === vscode.DiagnosticSeverity.Error
            ).length === 0;
        } catch (error: any) {
            vscode.window.showErrorMessage(`Peppol validation error: ${error.message}`);
            validationResult.peppolPassed = false;
        }
    }

    validationResult.issues = allIssues;

    const tracedIssues = enableTracing
        ? mapIssuesToXsltSource(allIssues, traceEntries)
        : undefined;

    return {
        output,
        isUbl: true,
        documentInfo: docInfo,
        validationResult,
        tracedIssues,
        traceEntries: enableTracing ? traceEntries : undefined,
    };
}
