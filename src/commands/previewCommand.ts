import * as path from 'path';
import * as vscode from 'vscode';
import { findConfigFile, loadConfig, pickProfile, resolveProfilePaths } from '../config/projectConfig';
import { transformAndValidate } from '../pipeline/transformAndValidate';
import { reportDiagnostics, showSummaryNotification } from '../validation/diagnosticsReporter';
import { getDiagnosticCollection } from '../extension';

export function createPreviewCommand(
    context: vscode.ExtensionContext
): () => Promise<void> {
    return async () => {
        const artifactsPath = path.join(context.extensionPath, 'validation-artifacts');
        const diagnosticCollection = getDiagnosticCollection();

        let sourceXml: string;
        let xsltStylesheet: string;
        let validationScope: 'full' | 'xsd-only' | 'business-rules-only' = 'full';

        // Try loading from .ublproject.json
        const configPath = findConfigFile();
        if (configPath) {
            try {
                const config = loadConfig(configPath);
                const profile = await pickProfile(config);
                if (!profile) {
                    return;
                }
                const configDir = path.dirname(configPath);
                const resolved = resolveProfilePaths(profile, configDir);
                sourceXml = resolved.sourceXml;
                xsltStylesheet = resolved.xsltStylesheet;
                validationScope = profile.validationScope || 'full';
            } catch (error: any) {
                vscode.window.showErrorMessage(`Error loading .ublproject.json: ${error.message}`);
                return;
            }
        } else {
            // Fall back to file pickers
            const xmlFiles = await vscode.window.showOpenDialog({
                canSelectMany: false,
                openLabel: 'Select XML Input File',
                filters: { 'XML Files': ['xml'], 'All Files': ['*'] },
            });
            if (!xmlFiles || xmlFiles.length === 0) {
                return;
            }
            sourceXml = xmlFiles[0].fsPath;

            const xslFiles = await vscode.window.showOpenDialog({
                canSelectMany: false,
                openLabel: 'Select XSL/XSLT Stylesheet',
                filters: { 'XSL Files': ['xsl', 'xslt'], 'All Files': ['*'] },
            });
            if (!xslFiles || xslFiles.length === 0) {
                return;
            }
            xsltStylesheet = xslFiles[0].fsPath;
        }

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'XSLT Preview + Validate',
            cancellable: false,
        }, async (progress) => {
            try {
                const result = await transformAndValidate({
                    sourceXml,
                    xsltStylesheet,
                    artifactsPath,
                    extensionPath: context.extensionPath,
                    validationScope,
                    onProgress: (msg) => progress.report({ message: msg }),
                });

                // Show output in editor
                const doc = await vscode.workspace.openTextDocument({
                    content: result.output,
                    language: 'xml',
                });
                await vscode.window.showTextDocument(doc, { preview: true });

                if (result.isUbl && result.validationResult) {
                    // Report diagnostics on the output document
                    reportDiagnostics(diagnosticCollection, doc.uri, result.validationResult.issues);
                    showSummaryNotification(result.validationResult);
                } else {
                    vscode.window.showInformationMessage(
                        'Transform complete. Output is not UBL - validation skipped.'
                    );
                }
            } catch (error: any) {
                vscode.window.showErrorMessage(`Preview failed: ${error.message}`);
                console.error('Preview Error:', error);
            }
        });
    };
}
