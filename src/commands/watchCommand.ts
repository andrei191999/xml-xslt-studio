import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

import { runPipeline } from '../pipeline/transformAndValidate';
import { reportDiagnostics } from '../validation/diagnosticsReporter';
import { getLastTransform, setLastTransform } from '../state/lastTransform';
import { getConfig } from '../config/settings';
import { openOrUpdateNamedOutputDocument } from '../ui/editorPlacement';
import { PanelManager } from '../webview/panelManager';
import { buildIssueSummaries, countIssueSummaries } from '../webview/issueSummaries';

let isWatchEnabled = false;
let isRunning = false;

export function createWatchToggleCommand(
    statusBar: vscode.StatusBarItem,
): () => void {
    return () => {
        isWatchEnabled = !isWatchEnabled;
        if (isWatchEnabled) {
            statusBar.text = '$(eye) Watch: ON';
        } else {
            statusBar.text = '$(eye-closed) Watch: OFF';
        }
    };
}

export function registerWatchListener(
    context: vscode.ExtensionContext,
    local: vscode.DiagnosticCollection,
    helger: vscode.DiagnosticCollection,
    statusBar: vscode.StatusBarItem,
): void {
    statusBar.text = '$(eye-closed) Watch: OFF';
    statusBar.command = 'xmlXslt.toggleWatch';

    const extensionPath = context.extensionPath;
    const artifactsPath = path.join(extensionPath, 'validation-artifacts');

    const disposable = vscode.workspace.onDidSaveTextDocument((savedDoc: vscode.TextDocument) => {
        if (!isWatchEnabled) {
            return;
        }

        const state = getLastTransform();
        if (!state) {
            return;
        }

        if (savedDoc.uri.fsPath !== state.xmlPath && savedDoc.uri.fsPath !== state.xsltPath) {
            return;
        }

        if (isRunning) { return; }
        isRunning = true;

        void (async () => {
            try {
                const xmlContent = fs.readFileSync(state.xmlPath, 'utf8');
                const config = getConfig();
                const result = await runPipeline({
                    xmlContent,
                    xsltPath: state.xsltPath,
                    extensionPath,
                    artifactsPath,
                    globalStorageFsPath: context.globalStorageUri.fsPath,
                    parameters: state.parameters,
                    config,
                });
                const panelCol = PanelManager.getPanelViewColumn() ?? vscode.window.activeTextEditor?.viewColumn;
                const outputDoc = await openOrUpdateNamedOutputDocument(result.output, result.outputLanguage, panelCol, {
                    outputDestination: config.transform.outputDestination,
                    defaultOutputExtension: config.transform.defaultOutputExtension,
                    sourceXmlPath: state.xmlPath,
                    sourceXsltPath: state.xsltPath,
                });
                if (!outputDoc) { return; }
                const outputUri = outputDoc.uri;

                reportDiagnostics(local, helger, outputUri, result.issues, result.traceMap);
                const issueSummaries = buildIssueSummaries(result.issues, {
                    traceMap: result.traceMap,
                    outputUri,
                });
                PanelManager.postMessage({
                    type: 'VALIDATION_RESULT',
                    issues: issueSummaries,
                    detectedProfile: result.detectedProfile,
                    ...countIssueSummaries(issueSummaries),
                });
                setLastTransform({ ...state, outputUri, xmlContent });
            } catch (err) {
                console.error('[xmlXslt watch]', err);
            } finally {
                isRunning = false;
            }
        })();
    });

    context.subscriptions.push(disposable);
}
