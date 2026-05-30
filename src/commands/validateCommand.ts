import * as path from 'path';
import * as vscode from 'vscode';
import { ProgressLocation } from 'vscode';

import { detectUblDocumentFromContent } from '../validation/documentDetector';
import { validateXsd } from '../validation/xsdValidator';
import { validateSchematronWithMetadata } from '../validation/schematronValidator';
import { validateHelger } from '../validation/helgerValidator';
import { reportDiagnostics } from '../validation/diagnosticsReporter';
import { IssueSeverity, ValidationIssue, SchematronRuleset } from '../validation/types';
import { getConfig } from '../config/settings';
import { getActiveJarsDir, type PhiveRunnerRuleResult } from '../utils/javaRunner';
import { ts } from '../utils/execAsync';
import { PanelManager } from '../webview/panelManager';
import { buildIssueSummaries, countIssueSummaries } from '../webview/issueSummaries';
import { clearLastValidationExport, hasPhiveHtmlExportableRuleResults, setLastValidationExport } from '../state/lastValidationExport';
import { pushHistoryEntry } from '../state/validationHistory';

// ---------------------------------------------------------------------------
// createValidateDocumentCommand — full validation (XSD + Schematron + Helger)
// ---------------------------------------------------------------------------

function logIssueSummary(outputChannel: vscode.OutputChannel, tag: string, issues: ValidationIssue[]): void {
    const errors   = issues.filter(i => i.severity === IssueSeverity.Error).length;
    const warnings = issues.filter(i => i.severity === IssueSeverity.Warning).length;
    if (errors === 0 && warnings === 0) {
        outputChannel.appendLine(`[${tag}] OK — no issues`);
    } else {
        outputChannel.appendLine(`[${tag}] ${errors} error(s), ${warnings} warning(s)`);
    }
}

export function createValidateDocumentCommand(
    context: vscode.ExtensionContext,
    local: vscode.DiagnosticCollection,
    helger: vscode.DiagnosticCollection,
    outputChannel: vscode.OutputChannel,
): () => Promise<void> {
    return async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage('No active editor — open a UBL XML document first.');
            return;
        }

        const document = editor.document;
        const content = document.getText();
        const artifactsPath = path.join(context.extensionPath, 'validation-artifacts');
        const extensionPath = context.extensionPath;

        const docInfo = detectUblDocumentFromContent(content, artifactsPath);
        if (docInfo === null) {
            vscode.window.showInformationMessage('Not a recognized UBL document — validation skipped');
            clearLastValidationExport();
            const issue: ValidationIssue = {
                severity: IssueSeverity.Information,
                message: 'Not a recognized UBL document — validation skipped.',
                source: 'local-xsd',
                line: 1,
                column: 0,
            };
            local.delete(document.uri);
            helger.delete(document.uri);
            reportDiagnostics(local, helger, document.uri, [issue], new Map());
            return;
        }

        outputChannel.appendLine(`${ts()} [Validate] ${document.uri.fsPath}`);

        await vscode.window.withProgress(
            { location: ProgressLocation.Notification, title: 'Validating...' },
            async () => {
                const config = getConfig();
                const allIssues: ValidationIssue[] = [];
                let ruleResults: PhiveRunnerRuleResult[] = [];
                let detectedProfile: string | undefined;
                const phiveJarsDir = getActiveJarsDir(extensionPath, context.globalStorageUri.fsPath);

                // XSD — no-op in Phase 8+ (phive handles it)
                const xsdIssues = await validateXsd(content, docInfo, artifactsPath, extensionPath);
                allIssues.push(...xsdIssues);

                // Schematron — collect enabled rulesets
                const rulesets: SchematronRuleset[] = [];
                if (config.validation.enableSchematronEN16931) {
                    rulesets.push(SchematronRuleset.EN16931);
                }
                if (config.validation.enableSchematronPeppol) {
                    rulesets.push(SchematronRuleset.Peppol);
                }
                if (rulesets.length > 0) {
                    if (docInfo.docType !== 'Invoice' && docInfo.docType !== 'CreditNote') {
                        const infoIssue: ValidationIssue = {
                            severity: IssueSeverity.Information,
                            message: `Schematron not available for ${docInfo.docType} — EN16931/Peppol rules apply to Invoice and CreditNote only.`,
                            source: 'local-schematron',
                            line: 1,
                            column: 0,
                        };
                        allIssues.push(infoIssue);
                        outputChannel.appendLine(`${ts()} [Phive] skipped — not Invoice or CreditNote`);
                    } else {
                        outputChannel.appendLine(`${ts()} [Phive] start`);
                        try {
                            const schematronResult = await validateSchematronWithMetadata(content, rulesets, artifactsPath, extensionPath, phiveJarsDir);
                            const schIssues = schematronResult.issues;
                            allIssues.push(...schIssues);
                            ruleResults = schematronResult.ruleResults;
                            detectedProfile = schematronResult.detectedProfile;
                            logIssueSummary(outputChannel, `${ts()} [Phive]`, schIssues);
                        } catch (err: any) {
                            outputChannel.appendLine(`${ts()} [Phive] error: ` + (err?.message ?? String(err)));
                        }
                    }
                }

                // Helger (optional)
                if (config.validation.enableHelger) {
                    outputChannel.appendLine(`${ts()} [Helger] start`);
                    try {
                        const helgerIssues = await validateHelger(content, docInfo, config);
                        allIssues.push(...helgerIssues);
                        logIssueSummary(outputChannel, `${ts()} [Helger]`, helgerIssues);
                    } catch (err: any) {
                        outputChannel.appendLine(`${ts()} [Helger] error: ` + (err?.message ?? String(err)));
                    }
                }

                // Summary
                const errors   = allIssues.filter(i => i.severity === IssueSeverity.Error).length;
                const warnings = allIssues.filter(i => i.severity === IssueSeverity.Warning).length;
                outputChannel.appendLine(`${ts()} [Validate] done — ${errors} error(s), ${warnings} warning(s)`);

                // Clear before reporting
                local.delete(document.uri);
                helger.delete(document.uri);

                reportDiagnostics(local, helger, document.uri, allIssues, new Map());

                if (allIssues.length === 0) {
                    vscode.window.showInformationMessage('No issues found');
                } else {
                    vscode.window.showInformationMessage(`${allIssues.length} issues found`);
                }

                // Open/reveal panel with results — pre-fill Transform tab, switch to Results tab
                PanelManager.createOrShow(context.extensionUri, context);
                PanelManager.postMessage({ type: 'FILE_SELECTED', role: 'xml', fsPath: document.uri.fsPath, fileName: path.basename(document.uri.fsPath) });
                const panelSums = buildIssueSummaries(allIssues);
                const counts = countIssueSummaries(panelSums);
                const validationTimestamp = Date.now();
                const exportAvailable = hasPhiveHtmlExportableRuleResults(ruleResults);
                PanelManager.postMessage({
                    type: 'VALIDATION_RESULT',
                    issues: panelSums,
                    detectedProfile,
                    ruleResults,
                    exportAvailable,
                    ...counts,
                });
                if (exportAvailable) {
                    setLastValidationExport({
                        timestamp: validationTimestamp,
                        xmlPath: document.uri.fsPath,
                        detectedProfile,
                        validatedXmlContent: content,
                    });
                } else {
                    clearLastValidationExport();
                }
                const history = await pushHistoryEntry(context, {
                    timestamp: validationTimestamp,
                    xmlPath: document.uri.fsPath,
                    detectedProfile,
                    issueCount: panelSums.length,
                    ...counts,
                });
                PanelManager.postMessage({ type: 'VALIDATION_HISTORY', history });
                PanelManager.postMessage({ type: 'SWITCH_TAB', tab: 'results' });
            },
        );
    };
}

// ---------------------------------------------------------------------------
// createValidateXsdOnlyCommand — XSD validation only
// ---------------------------------------------------------------------------

export function createValidateXsdOnlyCommand(
    context: vscode.ExtensionContext,
    local: vscode.DiagnosticCollection,
    helger: vscode.DiagnosticCollection,
    outputChannel: vscode.OutputChannel,
): () => Promise<void> {
    return async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage('No active editor — open a UBL XML document first.');
            return;
        }

        const document = editor.document;
        const content = document.getText();
        const artifactsPath = path.join(context.extensionPath, 'validation-artifacts');
        const extensionPath = context.extensionPath;

        const docInfo = detectUblDocumentFromContent(content, artifactsPath);
        if (docInfo === null) {
            vscode.window.showInformationMessage('Not a recognized UBL document — skipping validation');
            clearLastValidationExport();
            local.delete(document.uri);
            helger.delete(document.uri);
            return;
        }

        outputChannel.appendLine(`[Validate XSD] ${document.uri.fsPath}`);

        await vscode.window.withProgress(
            { location: ProgressLocation.Notification, title: 'Validating XSD...' },
            async () => {
                const allIssues = await validateXsd(content, docInfo, artifactsPath, extensionPath);
                logIssueSummary(outputChannel, 'XSD', allIssues);

                local.delete(document.uri);
                helger.delete(document.uri);

                reportDiagnostics(local, helger, document.uri, allIssues, new Map());

                if (allIssues.length === 0) {
                    vscode.window.showInformationMessage('No issues found');
                } else {
                    vscode.window.showInformationMessage(`${allIssues.length} issues found`);
                }

                PanelManager.createOrShow(context.extensionUri, context);
                PanelManager.postMessage({ type: 'FILE_SELECTED', role: 'xml', fsPath: document.uri.fsPath, fileName: path.basename(document.uri.fsPath) });
                const panelSums = buildIssueSummaries(allIssues);
                const counts = countIssueSummaries(panelSums);
                const validationTimestamp = Date.now();
                PanelManager.postMessage({ type: 'VALIDATION_RESULT', issues: panelSums, detectedProfile: undefined, ruleResults: [], exportAvailable: false, ...counts });
                clearLastValidationExport();
                const history = await pushHistoryEntry(context, {
                    timestamp: validationTimestamp,
                    xmlPath: document.uri.fsPath,
                    issueCount: panelSums.length,
                    ...counts,
                });
                PanelManager.postMessage({ type: 'VALIDATION_HISTORY', history });
                PanelManager.postMessage({ type: 'SWITCH_TAB', tab: 'results' });
            },
        );
    };
}

// ---------------------------------------------------------------------------
// createValidateBusinessRulesOnlyCommand — Schematron validation only
// ---------------------------------------------------------------------------

export function createValidateBusinessRulesOnlyCommand(
    context: vscode.ExtensionContext,
    local: vscode.DiagnosticCollection,
    helger: vscode.DiagnosticCollection,
    outputChannel: vscode.OutputChannel,
): () => Promise<void> {
    return async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage('No active editor — open a UBL XML document first.');
            return;
        }

        const document = editor.document;
        const content = document.getText();
        const artifactsPath = path.join(context.extensionPath, 'validation-artifacts');
        const extensionPath = context.extensionPath;

        const docInfo = detectUblDocumentFromContent(content, artifactsPath);
        if (docInfo === null) {
            vscode.window.showInformationMessage('Not a recognized UBL document — skipping validation');
            clearLastValidationExport();
            local.delete(document.uri);
            helger.delete(document.uri);
            return;
        }

        const config = getConfig();
        const rulesets: SchematronRuleset[] = [];
        if (config.validation.enableSchematronEN16931) {
            rulesets.push(SchematronRuleset.EN16931);
        }
        if (config.validation.enableSchematronPeppol) {
            rulesets.push(SchematronRuleset.Peppol);
        }

        if (rulesets.length === 0) {
            vscode.window.showInformationMessage('No Schematron ruleset is enabled — enable EN16931 or Peppol in settings.');
            return;
        }

        outputChannel.appendLine(`[Validate Schematron] ${document.uri.fsPath}`);

        await vscode.window.withProgress(
            { location: ProgressLocation.Notification, title: 'Validating Schematron...' },
            async () => {
                const allIssues: ValidationIssue[] = [];
                let ruleResults: PhiveRunnerRuleResult[] = [];
                let detectedProfile: string | undefined;

                if (docInfo.docType !== 'Invoice' && docInfo.docType !== 'CreditNote') {
                    const infoIssue: ValidationIssue = {
                        severity: IssueSeverity.Information,
                        message: `Schematron not available for ${docInfo.docType} — EN16931/Peppol rules apply to Invoice and CreditNote only.`,
                        source: 'local-schematron',
                        line: 1,
                        column: 0,
                    };
                    allIssues.push(infoIssue);
                    outputChannel.appendLine(`[Schematron] Skipped — not Invoice or CreditNote`);
                } else {
                    try {
                        const phiveJarsDir = getActiveJarsDir(extensionPath, context.globalStorageUri.fsPath);
                        outputChannel.appendLine(`${ts()} [Phive] start`);
                        const schematronResult = await validateSchematronWithMetadata(content, rulesets, artifactsPath, extensionPath, phiveJarsDir);
                        const schIssues = schematronResult.issues;
                        allIssues.push(...schIssues);
                        ruleResults = schematronResult.ruleResults;
                        detectedProfile = schematronResult.detectedProfile;
                        logIssueSummary(outputChannel, `${ts()} [Phive]`, schIssues);
                    } catch (err: any) {
                        outputChannel.appendLine(`${ts()} [Phive] error: ` + (err?.message ?? String(err)));
                    }
                }

                local.delete(document.uri);
                helger.delete(document.uri);

                reportDiagnostics(local, helger, document.uri, allIssues, new Map());

                if (allIssues.length === 0) {
                    vscode.window.showInformationMessage('No issues found');
                } else {
                    vscode.window.showInformationMessage(`${allIssues.length} issues found`);
                }

                PanelManager.createOrShow(context.extensionUri, context);
                PanelManager.postMessage({ type: 'FILE_SELECTED', role: 'xml', fsPath: document.uri.fsPath, fileName: path.basename(document.uri.fsPath) });
                const panelSums = buildIssueSummaries(allIssues);
                const counts = countIssueSummaries(panelSums);
                const validationTimestamp = Date.now();
                const exportAvailable = hasPhiveHtmlExportableRuleResults(ruleResults);
                PanelManager.postMessage({ type: 'VALIDATION_RESULT', issues: panelSums, detectedProfile, ruleResults, exportAvailable, ...counts });
                if (exportAvailable) {
                    setLastValidationExport({
                        timestamp: validationTimestamp,
                        xmlPath: document.uri.fsPath,
                        detectedProfile,
                        validatedXmlContent: content,
                    });
                } else {
                    clearLastValidationExport();
                }
                const history = await pushHistoryEntry(context, {
                    timestamp: validationTimestamp,
                    xmlPath: document.uri.fsPath,
                    detectedProfile,
                    issueCount: panelSums.length,
                    ...counts,
                });
                PanelManager.postMessage({ type: 'VALIDATION_HISTORY', history });
                PanelManager.postMessage({ type: 'SWITCH_TAB', tab: 'results' });
            },
        );
    };
}
