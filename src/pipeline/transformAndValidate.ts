import * as path from 'path';
import type * as vscode from 'vscode';

import { runSaxonTransform, runPhiveRunner, getActiveJarsDir, PhiveRunnerIssue } from '../utils/javaRunner';
import { ts } from '../utils/execAsync';
import { writeTempFile } from '../utils/tempFile';
import { detectUblDocumentFromContent } from '../validation/documentDetector';
import { validateXsd } from '../validation/xsdValidator';
import { validateHelger } from '../validation/helgerValidator';
import { parseSaxonTrace } from '../tracing/saxonTracer';

import type { UblDocumentInfo, ValidationIssue } from '../validation/types';
import { IssueSeverity, SchematronRuleset } from '../validation/types';
import type { XmlXsltConfig } from '../config/settings';

export interface PipelineOptions {
    xmlContent: string;
    xsltPath: string;           // absolute path to XSLT file
    extensionPath: string;      // context.extensionPath
    artifactsPath: string;      // path.join(extensionPath, 'validation-artifacts')
    globalStorageFsPath?: string; // context.globalStorageUri.fsPath — required for phive
    parameters?: Record<string, string>;
    config: XmlXsltConfig;
    cancellationToken?: vscode.CancellationToken;
    onProgress?: (message: string, increment?: number) => void;
    /** Called with the raw transform output immediately after Saxon finishes, before validation. */
    onTransformComplete?: (output: string, language: string, traceMap: Map<number, vscode.Location>) => Promise<void>;
    outputChannel?: vscode.OutputChannel;
}

export interface PipelineResult {
    output: string;
    outputLanguage: string;     // 'xml', 'html', or 'text'
    isUbl: boolean;
    documentInfo: UblDocumentInfo | null;
    issues: ValidationIssue[];
    traceMap: Map<number, vscode.Location>;
    detectedProfile: string | undefined; // phive DDD-detected VESID, passed to callers
}

function mapPhiveIssues(issues: PhiveRunnerIssue[]): ValidationIssue[] {
    return issues.map(p => ({
        severity: p.severity === 'ERROR' ? IssueSeverity.Error
            : p.severity === 'WARNING' ? IssueSeverity.Warning
            : IssueSeverity.Information,
        message: p.message,
        ruleId: p.ruleId ?? undefined,
        line: p.line || 1,
        column: p.column || 0,
        source: 'local-schematron' as const,
    }));
}

export async function runPipeline(opts: PipelineOptions): Promise<PipelineResult> {
    // Step 1: Write xmlContent to a temp file
    const tempResult = writeTempFile(opts.xmlContent, '.xml');
    const sourceFile = tempResult.filePath;

    try {
        // Step 2: Check cancellation
        if (opts.cancellationToken?.isCancellationRequested) {
            throw new Error('Transform cancelled');
        }

        // Step 3: Run Saxon transform
        opts.onProgress?.('Running XSLT transform...', 0);
        opts.outputChannel?.appendLine(`${ts()} [Saxon] start: xslt=${opts.xsltPath}`);
        const saxonResult = await runSaxonTransform({
            extensionPath: opts.extensionPath,
            sourceFile: sourceFile,
            xsltFile: opts.xsltPath,
            parameters: opts.parameters,
            enableTracing: opts.config.transform.enableTracing,
        });
        opts.outputChannel?.appendLine(`${ts()} [Saxon] done — output ${saxonResult.stdout.length} chars`);

        // Step 4: Detect output language
        const trimmed = saxonResult.stdout.trimStart();
        let outputLanguage: string;
        if (/^<html/i.test(trimmed) || /^<!DOCTYPE html/i.test(trimmed)) {
            outputLanguage = 'html';
        } else if (trimmed.startsWith('<?xml') || trimmed.startsWith('<')) {
            outputLanguage = 'xml';
        } else {
            outputLanguage = 'text';
        }

        // Step 5: Parse Saxon trace
        const traceMap = parseSaxonTrace(saxonResult.traceXml, opts.xsltPath);

        // Step 5b: Surface transform output immediately, before validation starts
        await opts.onTransformComplete?.(saxonResult.stdout, outputLanguage, traceMap);

        // Step 6: Check cancellation
        if (opts.cancellationToken?.isCancellationRequested) {
            throw new Error('Transform cancelled');
        }

        // Step 7: Detect UBL doc type
        const documentInfo = detectUblDocumentFromContent(saxonResult.stdout, opts.artifactsPath);

        let xsdIssues: ValidationIssue[] = [];
        let schemIssues: ValidationIssue[] = [];
        let helgerIssues: ValidationIssue[] = [];
        let detectedProfile: string | undefined = undefined;

        // Step 7b: Surface "not recognised" as an info issue when auto-validate is on
        if (documentInfo === null && opts.config.validation.enableAutoValidate) {
            xsdIssues = [{
                severity: IssueSeverity.Information,
                message: 'Not a recognized UBL document — validation skipped.',
                source: 'local-xsd',
                line: 1,
                column: 0,
            }];
        }

        // Step 8: Validation (only if UBL and auto-validate enabled)
        if (documentInfo !== null && opts.config.validation.enableAutoValidate) {
            const rulesets: SchematronRuleset[] = [];
            if (opts.config.validation.enableSchematronEN16931) {
                rulesets.push(SchematronRuleset.EN16931);
            }
            if (opts.config.validation.enableSchematronPeppol) {
                rulesets.push(SchematronRuleset.Peppol);
            }

            if (rulesets.length > 0) {
                // Phase 8+: phive handles both XSD and Schematron in a single pass.
                // Uses bundled lib/phive-jars/ by default; globalStorage jars if an update was installed.
                const phiveJarsDir = getActiveJarsDir(opts.extensionPath, opts.globalStorageFsPath);

                const phiveTmp = writeTempFile(saxonResult.stdout, '.xml');
                try {
                    opts.onProgress?.('Validating with phive...', 40);
                    opts.outputChannel?.appendLine(`${ts()} [Phive] start`);
                    const phiveOut = await runPhiveRunner({
                        extensionPath: opts.extensionPath,
                        xmlFilePath: phiveTmp.filePath,
                        phiveJarsDir,
                    });
                    opts.outputChannel?.appendLine(
                        `${ts()} [Phive] done — dddDetected=${phiveOut.dddDetected} issues=${phiveOut.issues.length} profile=${phiveOut.profile}`
                    );
                    if (phiveOut.dddDetected && !phiveOut.error) {
                        detectedProfile = phiveOut.profile ?? undefined;
                        schemIssues = mapPhiveIssues(phiveOut.issues);
                    } else if (phiveOut.error) {
                        schemIssues = [{
                            severity: IssueSeverity.Error,
                            message: `Phive validation error: ${phiveOut.error}`,
                            source: 'local-schematron',
                            ruleId: undefined,
                            line: 1,
                            column: 0,
                        }];
                    }
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    opts.outputChannel?.appendLine(`${ts()} [Phive] error: ${msg}`);
                } finally {
                    phiveTmp.cleanup();
                }
            }
        }

        // Step 9: Helger validation (only if UBL and Helger enabled)
        if (documentInfo !== null && opts.config.validation.enableHelger) {
            try {
                opts.onProgress?.('Validating against Helger...', 20);
                opts.outputChannel?.appendLine(`${ts()} [Helger] start`);
                helgerIssues = await validateHelger(saxonResult.stdout, documentInfo, opts.config, detectedProfile);
                opts.outputChannel?.appendLine(`${ts()} [Helger] done — issues=${helgerIssues.length}`);
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                opts.outputChannel?.appendLine(`${ts()} [Helger] error: ${message}`);
            }
        }

        // Step 10: Return result
        return {
            output: saxonResult.stdout,
            outputLanguage,
            isUbl: documentInfo !== null,
            documentInfo,
            issues: [...xsdIssues, ...schemIssues, ...helgerIssues],
            traceMap,
            detectedProfile,
        };
    } finally {
        tempResult.cleanup();
    }
}

/** Back-compat alias used by fixAgent.ts */
export const transformAndValidate = runPipeline;
