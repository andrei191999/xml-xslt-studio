import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';

import { pickFile } from '../ui/filePicker';
import { runPipeline } from '../pipeline/transformAndValidate';
import { extractParamNames } from '../utils/xsltParamUtils';
import { reportDiagnostics, reportXsltDiagnostics } from '../validation/diagnosticsReporter';
import { getLastTransform, setLastTransform } from '../state/lastTransform';
import { PanelManager } from '../webview/panelManager';
import { getConfig } from '../config/settings';
import { IssueSeverity } from '../validation/types';
import { openOrUpdateNamedOutputDocument } from '../ui/editorPlacement';
import { buildIssueSummaries, countIssueSummaries } from '../webview/issueSummaries';
import { detectCustomizationId } from '../validation/documentDetector';
import {
    clearLastValidationExport,
    hasPhiveHtmlExportableRuleResults,
    setLastValidationExport,
} from '../state/lastValidationExport';
import { pushHistoryEntry } from '../state/validationHistory';

/**
 * Scan an XSLT file for <xsl:param name="..."> declarations and prompt the
 * user to supply a value for each one found. Returns a Record of name -> value
 * (empty strings are omitted).
 */
async function promptForParameters(xsltPath: string, xsltContent?: string): Promise<Record<string, string>> {
    let xsltText: string;
    if (xsltContent !== undefined) {
        xsltText = xsltContent;
    } else {
        try {
            xsltText = fs.readFileSync(xsltPath, 'utf8');
        } catch {
            return {};
        }
    }

    // Use DOM-based extraction to get only top-level params (excludes template-local ones)
    const allNames = extractParamNames(xsltText);
    // Filter out params with a select= default in their opening tag — no need to prompt
    const params = allNames.filter(name => {
        const re = new RegExp(`<xsl:param\\b[^>]*\\bname="${name}"[^>]*\\bselect\\s*=`);
        return !re.test(xsltText);
    });

    const result: Record<string, string> = {};
    for (const name of params) {
        const value = await vscode.window.showInputBox({
            prompt: `Value for param "${name}"`,
            placeHolder: name,
        });
        if (value !== undefined && value !== '') {
            result[name] = value;
        }
    }
    return result;
}

/**
 * Try to extract the href from an <?xml-stylesheet ... href="..."> PI in the
 * given buffer text. Returns undefined if no such PI is present.
 */
function extractStylesheetHref(xmlText: string): string | undefined {
    const piRegex = /<\?xml-stylesheet\s[^?]*?href="([^"]+)"/;
    const match = piRegex.exec(xmlText);
    return match ? match[1] : undefined;
}

export function createTransformCommand(
    context: vscode.ExtensionContext,
    local: vscode.DiagnosticCollection,
    helger: vscode.DiagnosticCollection,
    xslt: vscode.DiagnosticCollection,
    statusBar: vscode.StatusBarItem,
    outputChannel: vscode.OutputChannel,
): () => Promise<void> {
    return async () => {
        // Always use the original QuickPick file-selection flow.
        // After transform completes, the panel is opened/revealed with results.

        const editor = vscode.window.activeTextEditor;
        const activeDoc = editor?.document;
        const activePath = activeDoc?.uri.fsPath;

        const isXml = activePath
            ? activePath.endsWith('.xml')
            : false;
        const isXslt = activePath
            ? activePath.endsWith('.xsl') || activePath.endsWith('.xslt')
            : false;

        let xmlPath: string;
        let xsltPath: string;

        if (isXml) {
            // Active file is XML -- derive XSLT path (ask user, pre-populate from PI)
            xmlPath = activePath!;
            const xmlContent = activeDoc!.getText();

            // Check for <?xml-stylesheet?> PI
            let preselectedXslt: string | undefined;
            const href = extractStylesheetHref(xmlContent);
            if (href) {
                preselectedXslt = path.resolve(path.dirname(xmlPath), href);
            }

            const xsltPick = await pickFile('xslt', context, preselectedXslt);
            if (!xsltPick) {
                return;
            }
            xsltPath = xsltPick.fsPath;

        } else if (isXslt) {
            // Active file is XSLT -- ask user to pick XML
            xsltPath = activePath!;

            const xmlPick = await pickFile('xml', context);
            if (!xmlPick) {
                return;
            }
            xmlPath = xmlPick.fsPath;

        } else {
            // No relevant active file -- pick XML first, then XSLT
            const xmlPick = await pickFile('xml', context);
            if (!xmlPick) {
                return;
            }
            xmlPath = xmlPick.fsPath;

            const xsltPick = await pickFile('xslt', context);
            if (!xsltPick) {
                return;
            }
            xsltPath = xsltPick.fsPath;
        }

        // Read XML content from disk (may differ from what is open in editor if
        // it was picked via the file picker rather than taken from the active doc)
        let xmlContent: string;
        if (isXml && activeDoc && activeDoc.uri.fsPath === xmlPath) {
            xmlContent = activeDoc.getText();
        } else {
            try {
                xmlContent = fs.readFileSync(xmlPath, 'utf8');
            } catch (err) {
                vscode.window.showErrorMessage(
                    `Failed to read XML file: ${err instanceof Error ? err.message : String(err)}`
                );
                return;
            }
        }

        // Read XSLT once — reused by both promptForParameters and detectCustomizationId
        const xsltContent = (() => { try { return fs.readFileSync(xsltPath, 'utf8'); } catch { return ''; } })();

        // Prompt for XSLT parameters
        const parameters = await promptForParameters(xsltPath, xsltContent);

        const config = getConfig();
        const artifactsPath = path.join(context.extensionPath, 'validation-artifacts');

        // Clear stale XSLT-source squiggles before each run
        xslt.clear();

        let outputUri: vscode.Uri | undefined;

        outputChannel.appendLine('');
        outputChannel.appendLine('─────────────────────────────────────────────────');

        try {
            const result = await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: 'XSLT Transform',
                    cancellable: true,
                },
                async (progress, cancellationToken) => {
                    return runPipeline({
                        xmlContent,
                        xsltPath,
                        extensionPath: context.extensionPath,
                        artifactsPath,
                        globalStorageFsPath: context.globalStorageUri.fsPath,
                        parameters,
                        config,
                        cancellationToken,
                        outputChannel,
                        onProgress: (message, increment) => {
                            // Wrap in try/catch: VS Code notification progress throws
                            // "message must be set" on disposed handles in recent versions.
                            if (message) {
                                try { progress.report({ message, increment }); } catch { /* ignore */ }
                            }
                            outputChannel.appendLine('[Transform] ' + message);
                        },
                        onTransformComplete: async (output, language) => {
                            const panelCol = PanelManager.getPanelViewColumn() ?? editor?.viewColumn;
                            const doc = await openOrUpdateNamedOutputDocument(output, language, panelCol, {
                                outputDestination: config.transform.outputDestination,
                                defaultOutputExtension: config.transform.defaultOutputExtension,
                                sourceXmlPath: xmlPath,
                                sourceXsltPath: xsltPath,
                            });
                            if (!doc) { return; }
                            outputUri = doc.uri;
                        },
                    });
                },
            );

            // outputUri is set by onTransformComplete before runPipeline resolved
            if (!outputUri) {
                // Fallback: onTransformComplete was not called (e.g. Saxon errored before it)
                const panelCol = PanelManager.getPanelViewColumn() ?? editor?.viewColumn;
                const doc = await openOrUpdateNamedOutputDocument(result.output, result.outputLanguage, panelCol, {
                    outputDestination: config.transform.outputDestination,
                    defaultOutputExtension: config.transform.defaultOutputExtension,
                    sourceXmlPath: xmlPath,
                    sourceXsltPath: xsltPath,
                });
                if (!doc) { return; }
                outputUri = doc.uri;
            }

            // Report diagnostics on output doc and XSLT source
            reportDiagnostics(local, helger, outputUri, result.issues, result.traceMap);
            reportXsltDiagnostics(xslt, xsltPath, result.issues, result.traceMap);

            // Write per-issue detail lines (plain text — OutputChannel does not render ANSI)
            const SOURCE_TAG: Record<string, string> = {
                'local-xsd':        '[XSD]',
                'local-schematron': '[SCH]',
                'helger':           '[Helger]',
            };
            const SEV_LABEL: Record<number, string> = {
                [IssueSeverity.Error]:       'ERROR',
                [IssueSeverity.Warning]:     'WARN',
                [IssueSeverity.Information]: 'INFO',
            };
            for (const issue of result.issues) {
                const srcTag   = SOURCE_TAG[issue.source] ?? `[${issue.source}]`;
                const sevLabel = SEV_LABEL[issue.severity] ?? 'INFO';
                // Schematron messages already embed [RULE_ID] at the start — guard against double-prefix
                const rulePrefix = (issue.ruleId && !issue.message.startsWith('[')) ? `[${issue.ruleId}] ` : '';
                outputChannel.appendLine(
                    `${srcTag} ${sevLabel}: ${rulePrefix}line ${issue.line}: ${issue.message}`
                );
            }

            if (result.issues.length > 0) {
                statusBar.text = `$(warning) ${result.issues.length} issues`;
            } else {
                statusBar.text = `$(check) No issues`;
            }

            // Open/reveal panel with results — pre-fill Transform tab, switch to Results tab
            PanelManager.createOrShow(context.extensionUri, context);
            await PanelManager.setPanelFiles(context, { xmlPath, xslPath: xsltPath });
            PanelManager.postMessage({ type: 'FILE_SELECTED', role: 'xml', fsPath: xmlPath, fileName: path.basename(xmlPath) });
            PanelManager.postMessage({ type: 'FILE_SELECTED', role: 'xsl', fsPath: xsltPath, fileName: path.basename(xsltPath) });
            PanelManager.postMessage({
                type: 'PARAMS_CHANGED', xsltPath, xmlPath,
                params: Object.entries(parameters).map(([name, value]) => ({ name, value, automation: 'manual' })),
            });
            const panelSums = buildIssueSummaries(result.issues, {
                traceMap: result.traceMap,
                outputUri,
            });
            const counts = countIssueSummaries(panelSums);
            const validationTimestamp = Date.now();
            const exportAvailable = hasPhiveHtmlExportableRuleResults(result.ruleResults);
            PanelManager.postMessage({
                type: 'VALIDATION_RESULT',
                issues: panelSums,
                detectedProfile: result.detectedProfile,
                ruleResults: result.ruleResults,
                exportAvailable,
                ...counts,
            });
            if (exportAvailable) {
                setLastValidationExport({
                    timestamp: validationTimestamp,
                    xmlPath,
                    xsltPath,
                    detectedProfile: result.detectedProfile,
                    validatedXmlContent: result.output,
                });
            } else {
                clearLastValidationExport();
            }
            const history = await pushHistoryEntry(context, {
                timestamp: validationTimestamp,
                xmlPath,
                xsltPath,
                outputUri: outputUri!.toString(),
                detectedProfile: result.detectedProfile,
                issueCount: panelSums.length,
                ...counts,
            });
            PanelManager.postMessage({ type: 'VALIDATION_HISTORY', history });
            const det = detectCustomizationId(xmlPath, xsltPath, xsltContent);
            PanelManager.postMessage({ type: 'VALIDATION_PROFILE_DETECTED', profile: det.profile, source: det.source });
            PanelManager.postMessage({ type: 'SWITCH_TAB', tab: 'results' });

        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            outputChannel.appendLine('[Transform] ERROR: ' + message);
            if (/cancelled/i.test(message)) {
                // User cancelled -- swallow silently
                return;
            }
            vscode.window.showErrorMessage(`XSLT Transform failed: ${message}`);
            return;
        }

        // Persist last transform state for AI fix and watch commands
        setLastTransform({
            xmlPath,
            xmlContent,
            xsltPath,
            parameters,
            automations: Object.fromEntries(
                Object.keys(parameters).map(name => [name, 'manual'])
            ),
            outputUri,
            outputDestination: config.transform.outputDestination,
        });
    };
}
