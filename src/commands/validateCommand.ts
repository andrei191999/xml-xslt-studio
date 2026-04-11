import * as vscode from 'vscode';
import * as path from 'path';
import { detectUblDocument } from '../validation/documentDetector';
import { validateXsd } from '../validation/xsdValidator';
import { validateSchematron } from '../validation/schematronValidator';
import { reportDiagnostics, showSummaryNotification } from '../validation/diagnosticsReporter';
import { ValidationResult, ValidationScope, ValidationIssue } from '../validation/types';
import { getDiagnosticCollection } from '../extension';

function getArtifactsPath(context: vscode.ExtensionContext): string {
    return path.join(context.extensionPath, 'validation-artifacts');
}

export function createValidateCommand(
    context: vscode.ExtensionContext,
    scope: ValidationScope
): () => Promise<void> {
    return async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showWarningMessage('No active editor. Open an XML file first.');
            return;
        }

        const document = editor.document;
        if (document.isUntitled) {
            vscode.window.showWarningMessage('Please save the file before validating.');
            return;
        }

        const filePath = document.uri.fsPath;
        const artifactsPath = getArtifactsPath(context);
        const diagnosticCollection = getDiagnosticCollection();

        // Clear previous diagnostics for this file
        diagnosticCollection.delete(document.uri);

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Validating UBL document...',
            cancellable: false
        }, async (progress) => {
            try {
                progress.report({ increment: 0, message: 'Detecting document type...' });

                const docInfo = detectUblDocument(filePath);
                if (!docInfo) {
                    vscode.window.showWarningMessage(
                        'Not a recognized UBL 2.1 document. The root element does not match any known UBL document type.'
                    );
                    return;
                }

                const allIssues: ValidationIssue[] = [];
                const result: ValidationResult = {
                    issues: [],
                    documentInfo: docInfo,
                    xsdPassed: true,
                    en16931Passed: null,
                    peppolPassed: null,
                };

                // XSD validation
                if (scope === 'full' || scope === 'xsd-only') {
                    progress.report({ increment: 20, message: 'Running XSD validation...' });
                    try {
                        const xsdIssues = await validateXsd(filePath, docInfo, artifactsPath, context.extensionPath);
                        allIssues.push(...xsdIssues);
                        result.xsdPassed = xsdIssues.length === 0;
                    } catch (error: any) {
                        vscode.window.showErrorMessage(`XSD validation error: ${error.message}`);
                        result.xsdPassed = false;
                    }
                }

                // EN16931 business rules (Invoice and CreditNote only)
                if ((scope === 'full' || scope === 'business-rules-only') && docInfo.isInvoiceOrCreditNote) {
                    progress.report({ increment: 25, message: 'Checking EN16931 business rules...' });
                    try {
                        const en16931Issues = await validateSchematron(filePath, 'en16931', artifactsPath, context.extensionPath);
                        allIssues.push(...en16931Issues);
                        result.en16931Passed = en16931Issues.filter(
                            i => i.severity === vscode.DiagnosticSeverity.Error
                        ).length === 0;
                    } catch (error: any) {
                        vscode.window.showErrorMessage(`EN16931 validation error: ${error.message}`);
                        result.en16931Passed = false;
                    }
                }

                // Peppol BIS 3.0 rules (Invoice and CreditNote only)
                if ((scope === 'full' || scope === 'business-rules-only') && docInfo.isInvoiceOrCreditNote) {
                    progress.report({ increment: 25, message: 'Checking Peppol BIS 3.0 rules...' });
                    try {
                        const peppolIssues = await validateSchematron(filePath, 'peppol', artifactsPath, context.extensionPath);
                        allIssues.push(...peppolIssues);
                        result.peppolPassed = peppolIssues.filter(
                            i => i.severity === vscode.DiagnosticSeverity.Error
                        ).length === 0;
                    } catch (error: any) {
                        vscode.window.showErrorMessage(`Peppol validation error: ${error.message}`);
                        result.peppolPassed = false;
                    }
                }

                result.issues = allIssues;

                progress.report({ increment: 20, message: 'Reporting results...' });

                reportDiagnostics(diagnosticCollection, document.uri, allIssues);
                showSummaryNotification(result);

            } catch (error: any) {
                vscode.window.showErrorMessage(`Validation failed: ${error.message}`);
                console.error('UBL Validation Error:', error);
            }
        });
    };
}
