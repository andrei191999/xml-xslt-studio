import * as vscode from 'vscode';
import * as path from 'path';
import { detectUblDocumentFromContent } from '../validation/documentDetector';
import { validateXsdFromContent } from '../validation/xsdValidator';
import { validateSchematronFromContent } from '../validation/schematronValidator';
import { ValidationIssue, ValidationResult } from '../validation/types';
import { reportTracedDiagnostics, showSummaryNotification } from '../validation/diagnosticsReporter';
import { getDiagnosticCollection, setLastTransformContext } from '../extension';
import { runInstrumentedTransform } from '../tracing/xsltTracer';
import { mapIssuesToXsltSource } from '../tracing/errorTraceMapper';
import { PipelineOptions } from '../pipeline/transformAndValidate';

export function createTransformCommand(
    context: vscode.ExtensionContext
): () => Promise<void> {
    return async () => {
        try {
            // Check if the active editor has an XSLT file — if so, use it directly
            const activeEditor = vscode.window.activeTextEditor;
            const activeFile = activeEditor?.document.uri.fsPath;
            const isXsltActive = activeFile &&
                /\.(xsl|xslt)$/i.test(activeFile) &&
                activeEditor?.document.uri.scheme === 'file';

            let xmlPath: string;
            let xslPath: string;

            if (isXsltActive) {
                // XSLT is in view — only ask for the XML input
                xslPath = activeFile;

                const xmlFiles = await vscode.window.showOpenDialog({
                    canSelectMany: false,
                    openLabel: 'Select XML Input File',
                    filters: {
                        'XML Files': ['xml'],
                        'All Files': ['*']
                    }
                });

                if (!xmlFiles || xmlFiles.length === 0) {
                    vscode.window.showInformationMessage('No XML file selected');
                    return;
                }

                xmlPath = xmlFiles[0].fsPath;
            } else {
                // No XSLT in view — ask for both files
                const xmlFiles = await vscode.window.showOpenDialog({
                    canSelectMany: false,
                    openLabel: 'Select XML Input File',
                    filters: {
                        'XML Files': ['xml'],
                        'All Files': ['*']
                    }
                });

                if (!xmlFiles || xmlFiles.length === 0) {
                    vscode.window.showInformationMessage('No XML file selected');
                    return;
                }

                xmlPath = xmlFiles[0].fsPath;

                const xslFiles = await vscode.window.showOpenDialog({
                    canSelectMany: false,
                    openLabel: 'Select XSL/XSLT File',
                    filters: {
                        'XSL Files': ['xsl', 'xslt'],
                        'All Files': ['*']
                    }
                });

                if (!xslFiles || xslFiles.length === 0) {
                    vscode.window.showInformationMessage('No XSL file selected');
                    return;
                }

                xslPath = xslFiles[0].fsPath;
            }
            const artifactsPath = path.join(context.extensionPath, 'validation-artifacts');
            const diagnosticCollection = getDiagnosticCollection();

            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: 'Transforming XML...',
                cancellable: false
            }, async (progress) => {
                try {
                    // Run instrumented transform to get trace entries
                    progress.report({ increment: 20, message: 'Running XSLT transformation...' });

                    const { cleanOutput: output, traceEntries } = await runInstrumentedTransform(
                        xmlPath, xslPath, context.extensionPath
                    );

                    progress.report({ increment: 20, message: 'Creating output...' });

                    // Show output directly in editor
                    const outputDoc = await vscode.workspace.openTextDocument({
                        content: output,
                        language: 'xml'
                    });
                    await vscode.window.showTextDocument(outputDoc);

                    // Auto-detect UBL and validate if applicable
                    progress.report({ increment: 10, message: 'Detecting document type...' });
                    const docInfo = detectUblDocumentFromContent(output);

                    if (!docInfo) {
                        // Not UBL - nothing more to do
                        return;
                    }

                    // Output is UBL - run validation automatically
                    const allIssues: ValidationIssue[] = [];
                    const validationResult: ValidationResult = {
                        issues: [],
                        documentInfo: docInfo,
                        xsdPassed: true,
                        en16931Passed: null,
                        peppolPassed: null,
                    };

                    // XSD validation
                    progress.report({ increment: 15, message: 'Running XSD validation...' });
                    try {
                        const xsdIssues = await validateXsdFromContent(
                            output, docInfo, artifactsPath, context.extensionPath
                        );
                        allIssues.push(...xsdIssues);
                        validationResult.xsdPassed = xsdIssues.length === 0;
                    } catch (error: any) {
                        vscode.window.showErrorMessage(`XSD validation error: ${error.message}`);
                        validationResult.xsdPassed = false;
                    }

                    // EN16931 business rules (Invoice and CreditNote only)
                    if (docInfo.isInvoiceOrCreditNote) {
                        progress.report({ increment: 15, message: 'Checking EN16931 business rules...' });
                        try {
                            const en16931Issues = await validateSchematronFromContent(
                                output, 'en16931', artifactsPath, context.extensionPath
                            );
                            allIssues.push(...en16931Issues);
                            validationResult.en16931Passed = en16931Issues.filter(
                                i => i.severity === vscode.DiagnosticSeverity.Error
                            ).length === 0;
                        } catch (error: any) {
                            vscode.window.showErrorMessage(`EN16931 validation error: ${error.message}`);
                            validationResult.en16931Passed = false;
                        }

                        // Peppol BIS 3.0 rules
                        progress.report({ increment: 15, message: 'Checking Peppol BIS 3.0 rules...' });
                        try {
                            const peppolIssues = await validateSchematronFromContent(
                                output, 'peppol', artifactsPath, context.extensionPath
                            );
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

                    // Map validation issues to correct output lines + XSLT source
                    const tracedIssues = mapIssuesToXsltSource(allIssues, traceEntries, output);

                    // Report diagnostics with XSLT source links
                    reportTracedDiagnostics(diagnosticCollection, outputDoc.uri, tracedIssues);

                    // Store transform context for AI fix agent
                    const pipelineOpts: PipelineOptions = {
                        sourceXml: xmlPath,
                        xsltStylesheet: xslPath,
                        artifactsPath,
                        extensionPath: context.extensionPath,
                        enableTracing: true,
                    };
                    setLastTransformContext(pipelineOpts, output, outputDoc.uri);
                    showSummaryNotification(validationResult);

                } catch (error: any) {
                    vscode.window.showErrorMessage(`Transformation failed: ${error.message}`);
                    console.error('XSLT Transformation Error:', error);
                }
            });

        } catch (error: any) {
            vscode.window.showErrorMessage(`Error: ${error.message}`);
            console.error('Extension Error:', error);
        }
    };
}
