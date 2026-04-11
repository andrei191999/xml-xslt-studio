import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { findConfigFile, loadConfig, pickProfile, resolveProfilePaths } from '../config/projectConfig';
import { transformAndValidate } from '../pipeline/transformAndValidate';
import { MappingPanel } from '../webview/mappingPanel';

export function createShowMappingCommand(
    context: vscode.ExtensionContext
): () => Promise<void> {
    return async () => {
        const artifactsPath = path.join(context.extensionPath, 'validation-artifacts');

        let sourceXml: string;
        let xsltStylesheet: string;

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
            } catch (error: any) {
                vscode.window.showErrorMessage(`Error loading .ublproject.json: ${error.message}`);
                return;
            }
        } else {
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
            title: 'Building source-to-output mapping...',
            cancellable: false,
        }, async (progress) => {
            try {
                progress.report({ message: 'Running instrumented transform...' });

                const result = await transformAndValidate({
                    sourceXml,
                    xsltStylesheet,
                    artifactsPath,
                    extensionPath: context.extensionPath,
                    enableTracing: true,
                    onProgress: (msg) => progress.report({ message: msg }),
                });

                const sourceContent = fs.readFileSync(sourceXml, 'utf8');

                MappingPanel.createOrShow(context.extensionUri, {
                    sourceXml: sourceContent,
                    outputXml: result.output,
                    traceEntries: result.traceEntries || [],
                    validationIssues: result.validationResult?.issues || [],
                });
            } catch (error: any) {
                vscode.window.showErrorMessage(`Mapping view failed: ${error.message}`);
                console.error('Mapping Error:', error);
            }
        });
    };
}
