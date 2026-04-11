import * as path from 'path';
import * as vscode from 'vscode';
import { findConfigFile, loadConfig, pickProfile, resolveProfilePaths, ProjectProfile } from '../config/projectConfig';
import { transformAndValidate, TransformResult } from '../pipeline/transformAndValidate';
import { reportDiagnostics } from '../validation/diagnosticsReporter';
import { getDiagnosticCollection } from '../extension';
import { ValidationScope } from '../validation/types';

const DEBOUNCE_MS = 500;

export class WatchManager {
    private watcher: vscode.FileSystemWatcher | null = null;
    private statusBarItem: vscode.StatusBarItem;
    private debounceTimer: NodeJS.Timeout | null = null;
    private running = false;
    private extensionContext: vscode.ExtensionContext;

    // Resolved watch config
    private sourceXml = '';
    private xsltStylesheet = '';
    private validationScope: ValidationScope = 'full';
    private artifactsPath = '';

    constructor(context: vscode.ExtensionContext) {
        this.extensionContext = context;
        this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
        this.statusBarItem.command = 'xml-xslt-studio.stopWatch';
        context.subscriptions.push(this.statusBarItem);
        this.artifactsPath = path.join(context.extensionPath, 'validation-artifacts');
    }

    get isWatching(): boolean {
        return this.watcher !== null;
    }

    async start(): Promise<void> {
        if (this.watcher) {
            vscode.window.showInformationMessage('Watch mode is already active.');
            return;
        }

        // Resolve config
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
                this.sourceXml = resolved.sourceXml;
                this.xsltStylesheet = resolved.xsltStylesheet;
                this.validationScope = profile.validationScope || 'full';
            } catch (error: any) {
                vscode.window.showErrorMessage(`Error loading config: ${error.message}`);
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
            this.sourceXml = xmlFiles[0].fsPath;

            const xslFiles = await vscode.window.showOpenDialog({
                canSelectMany: false,
                openLabel: 'Select XSL/XSLT Stylesheet',
                filters: { 'XSL Files': ['xsl', 'xslt'], 'All Files': ['*'] },
            });
            if (!xslFiles || xslFiles.length === 0) {
                return;
            }
            this.xsltStylesheet = xslFiles[0].fsPath;
        }

        // Watch XSLT files
        this.watcher = vscode.workspace.createFileSystemWatcher('**/*.{xsl,xslt}');
        this.watcher.onDidChange(() => this.onFileChanged());
        this.watcher.onDidCreate(() => this.onFileChanged());

        this.statusBarItem.text = '$(eye) XSLT Watch: Active';
        this.statusBarItem.tooltip = 'Click to stop watch mode';
        this.statusBarItem.show();

        vscode.window.showInformationMessage('XSLT Watch mode started. Save an XSLT file to trigger transform + validate.');

        // Run once immediately
        await this.runPipeline();
    }

    stop(): void {
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = null;
        }
        if (this.watcher) {
            this.watcher.dispose();
            this.watcher = null;
        }
        this.statusBarItem.hide();
        vscode.window.showInformationMessage('XSLT Watch mode stopped.');
    }

    dispose(): void {
        this.stop();
        this.statusBarItem.dispose();
    }

    private onFileChanged(): void {
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }
        this.debounceTimer = setTimeout(() => {
            this.runPipeline();
        }, DEBOUNCE_MS);
    }

    private async runPipeline(): Promise<void> {
        if (this.running) {
            return;
        }
        this.running = true;
        this.statusBarItem.text = '$(sync~spin) XSLT Watch: Running...';

        try {
            const result = await transformAndValidate({
                sourceXml: this.sourceXml,
                xsltStylesheet: this.xsltStylesheet,
                artifactsPath: this.artifactsPath,
                extensionPath: this.extensionContext.extensionPath,
                validationScope: this.validationScope,
            });

            const diagnosticCollection = getDiagnosticCollection();

            if (result.isUbl && result.validationResult) {
                // Create a URI for the XSLT file to attach diagnostics
                const xsltUri = vscode.Uri.file(this.xsltStylesheet);
                reportDiagnostics(diagnosticCollection, xsltUri, result.validationResult.issues);

                const errorCount = result.validationResult.issues.filter(
                    i => i.severity === vscode.DiagnosticSeverity.Error
                ).length;
                const warnCount = result.validationResult.issues.filter(
                    i => i.severity === vscode.DiagnosticSeverity.Warning
                ).length;

                if (errorCount === 0 && warnCount === 0) {
                    this.statusBarItem.text = '$(check) XSLT Watch: Passed';
                } else {
                    this.statusBarItem.text = `$(alert) XSLT Watch: ${errorCount}E ${warnCount}W`;
                }
            } else {
                this.statusBarItem.text = '$(eye) XSLT Watch: Active (non-UBL)';
            }
        } catch (error: any) {
            this.statusBarItem.text = '$(error) XSLT Watch: Error';
            vscode.window.showErrorMessage(`Watch pipeline error: ${error.message}`);
        } finally {
            this.running = false;
        }
    }
}
