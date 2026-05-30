import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

import { runPipeline } from '../pipeline/transformAndValidate';
import { reportDiagnostics } from '../validation/diagnosticsReporter';
import { getLastTransform, setLastTransform } from '../state/lastTransform';
import { getConfig } from '../config/settings';
import { PanelManager } from '../webview/panelManager';
import { resolveAutomation } from '../validation/paramAutomation';
import { buildIssueSummaries, countIssueSummaries } from '../webview/issueSummaries';
import {
    clearLastValidationExport,
    hasPhiveHtmlExportableRuleResults,
    setLastValidationExport,
} from '../state/lastValidationExport';
import { pushHistoryEntry } from '../state/validationHistory';
import { openOrUpdateNamedOutputDocument } from '../ui/editorPlacement';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ScenarioEntry {
    name: string;
    xmlPath: string;
    xsltPath: string;
    parameters?: Record<string, string>;
    automations?: Record<string, string>;
    outputDestination?: 'open-in-editor' | 'save-to-file' | 'both';
}

interface ScenariosFile {
    scenarios: ScenarioEntry[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function resolveVariables(p: string, workspaceFolder: string, fileDir: string): string {
    return p
        .replace(/\$\{workspaceFolder\}/g, workspaceFolder)
        .replace(/\$\{fileDir\}/g, fileDir);
}

export function getScenariosFilePath(wsFolder: string): string {
    return path.join(wsFolder, '.vscode', 'xslt-scenarios.json');
}

export function readScenariosDocument(wsFolder: string): ScenariosFile {
    const filePath = getScenariosFilePath(wsFolder);
    if (!fs.existsSync(filePath)) {
        return { scenarios: [] };
    }
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as ScenariosFile;
    return Array.isArray(parsed.scenarios) ? parsed : { scenarios: [] };
}

export function readScenariosFile(wsFolder: string): ScenarioEntry[] {
    try {
        return readScenariosDocument(wsFolder).scenarios;
    } catch {
        return [];
    }
}

export function writeScenariosFile(wsFolder: string, scenarios: ScenarioEntry[]): void {
    const filePath = getScenariosFilePath(wsFolder);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ scenarios }, null, 2), 'utf8');
}

export function upsertScenarioEntry(wsFolder: string, entry: ScenarioEntry): ScenarioEntry[] {
    const parsed = readScenariosDocument(wsFolder);
    const existingIndex = parsed.scenarios.findIndex(scenario => scenario.name === entry.name);
    if (existingIndex >= 0) {
        parsed.scenarios.splice(existingIndex, 1, entry);
    } else {
        parsed.scenarios.push(entry);
    }
    writeScenariosFile(wsFolder, parsed.scenarios);
    return parsed.scenarios;
}

export function deleteScenarioEntry(wsFolder: string, name: string): void {
    const parsed = readScenariosDocument(wsFolder);
    parsed.scenarios = parsed.scenarios.filter(s => s.name !== name);
    writeScenariosFile(wsFolder, parsed.scenarios);
}

export function findScenarioEntry(wsFolder: string, name: string): ScenarioEntry | undefined {
    return readScenariosFile(wsFolder).find(scenario => scenario.name === name);
}

async function resolveScenarioParameters(
    xmlPath: string,
    xmlContent: string,
    parameters: Record<string, string>,
    automations: Record<string, string>,
): Promise<Record<string, string>> {
    const resolved = { ...parameters };
    for (const [name, automation] of Object.entries(automations)) {
        if (!automation || automation === 'manual') {
            continue;
        }
        const value = await resolveAutomation(automation, xmlPath, xmlContent);
        if (value !== '') {
            resolved[name] = value;
        }
    }
    return resolved;
}

// ---------------------------------------------------------------------------
// createRunScenarioCommand
// ---------------------------------------------------------------------------

export function createRunScenarioCommand(
    context: vscode.ExtensionContext,
    local: vscode.DiagnosticCollection,
    helger: vscode.DiagnosticCollection,
): (preselectedName?: string) => Promise<void> {
    return async (preselectedName?: string) => {
        const wsFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!wsFolder) {
            vscode.window.showErrorMessage('No workspace folder open.');
            return;
        }

        const scenariosFilePath = getScenariosFilePath(wsFolder);
        if (!fs.existsSync(scenariosFilePath)) {
            vscode.window.showInformationMessage(
                "No scenarios saved yet. Use 'XSLT: Save Scenario' to save one.",
            );
            return;
        }

        let parsed: ScenariosFile;
        try {
            parsed = readScenariosDocument(wsFolder);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage('Invalid xslt-scenarios.json: ' + msg);
            return;
        }

        if (!Array.isArray(parsed.scenarios) || parsed.scenarios.length === 0) {
            vscode.window.showInformationMessage(
                "No scenarios saved yet. Use 'XSLT: Save Scenario' to save one.",
            );
            return;
        }

        let chosen: string | undefined;
        if (preselectedName) {
            chosen = parsed.scenarios.find(scenario => scenario.name === preselectedName)?.name;
            if (!chosen) {
                vscode.window.showErrorMessage(`Scenario "${preselectedName}" not found.`);
                return;
            }
        } else {
            chosen = await vscode.window.showQuickPick(
                parsed.scenarios.map(scenario => scenario.name),
                { placeHolder: 'Select a scenario to run' },
            );
            if (!chosen) {
                return;
            }
        }

        const scenario = parsed.scenarios.find(entry => entry.name === chosen);
        if (!scenario) {
            return;
        }

        const xmlAfterWorkspace = scenario.xmlPath.replace(/\$\{workspaceFolder\}/g, wsFolder);
        const resolvedXmlPath = resolveVariables(xmlAfterWorkspace, wsFolder, path.dirname(xmlAfterWorkspace));

        const xsltAfterWorkspace = scenario.xsltPath.replace(/\$\{workspaceFolder\}/g, wsFolder);
        const resolvedXsltPath = resolveVariables(xsltAfterWorkspace, wsFolder, path.dirname(xsltAfterWorkspace));

        let xmlContent: string;
        try {
            xmlContent = fs.readFileSync(resolvedXmlPath, 'utf8');
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage('Cannot read XML file: ' + msg);
            return;
        }

        const config = getConfig();
        const artifactsPath = path.join(context.extensionPath, 'validation-artifacts');

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: `Running scenario: ${scenario.name}`,
                cancellable: true,
            },
            async (progress, token) => {
                try {
                    const resolvedParameters = await resolveScenarioParameters(
                        resolvedXmlPath,
                        xmlContent,
                        scenario.parameters ?? {},
                        scenario.automations ?? {},
                    );
                    const result = await runPipeline({
                        xmlContent,
                        xsltPath: resolvedXsltPath,
                        extensionPath: context.extensionPath,
                        artifactsPath,
                        globalStorageFsPath: context.globalStorageUri.fsPath,
                        parameters: resolvedParameters,
                        config,
                        cancellationToken: token,
                        onProgress: (message) => progress.report({ message }),
                    });

                    const panelCol = PanelManager.getPanelViewColumn() ?? vscode.window.activeTextEditor?.viewColumn;
                    const doc = await openOrUpdateNamedOutputDocument(result.output, result.outputLanguage, panelCol, {
                        outputDestination: config.transform.outputDestination,
                        defaultOutputExtension: config.transform.defaultOutputExtension,
                        sourceXmlPath: resolvedXmlPath,
                        sourceXsltPath: resolvedXsltPath,
                    });
                    if (!doc) { return; }

                    reportDiagnostics(local, helger, doc.uri, result.issues, result.traceMap);

                    setLastTransform({
                        xmlPath: resolvedXmlPath,
                        xmlContent,
                        xsltPath: resolvedXsltPath,
                        parameters: resolvedParameters,
                        automations: scenario.automations ?? {},
                        outputUri: doc.uri,
                        outputDestination: config.transform.outputDestination,
                    });

                    const issueSummaries = buildIssueSummaries(result.issues, {
                        traceMap: result.traceMap,
                        outputUri: doc.uri,
                    });
                    const counts = countIssueSummaries(issueSummaries);
                    const validationTimestamp = Date.now();
                    const exportAvailable = hasPhiveHtmlExportableRuleResults(result.ruleResults);
                    PanelManager.postMessage({
                        type: 'VALIDATION_RESULT',
                        issues: issueSummaries,
                        detectedProfile: result.detectedProfile,
                        ruleResults: result.ruleResults,
                        exportAvailable,
                        ...counts,
                    });
                    if (exportAvailable) {
                        setLastValidationExport({
                            timestamp: validationTimestamp,
                            xmlPath: resolvedXmlPath,
                            xsltPath: resolvedXsltPath,
                            detectedProfile: result.detectedProfile,
                            validatedXmlContent: result.output,
                        });
                    } else {
                        clearLastValidationExport();
                    }
                    const history = await pushHistoryEntry(context, {
                        timestamp: validationTimestamp,
                        xmlPath: resolvedXmlPath,
                        xsltPath: resolvedXsltPath,
                        outputUri: doc.uri.toString(),
                        detectedProfile: result.detectedProfile,
                        issueCount: issueSummaries.length,
                        ...counts,
                    });
                    PanelManager.postMessage({ type: 'VALIDATION_HISTORY', history });
                    PanelManager.postMessage({
                        type: 'SCENARIO_RUN_RESULT',
                        scenarioName: scenario.name,
                        success: true,
                        ...counts,
                    });
                    PanelManager.postMessage({ type: 'SWITCH_TAB', tab: 'results' });
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    vscode.window.showErrorMessage('Scenario failed: ' + msg);
                    PanelManager.postMessage({
                        type: 'SCENARIO_RUN_RESULT',
                        scenarioName: scenario.name,
                        success: false,
                        errorMessage: msg,
                        errorCount: 0,
                        warningCount: 0,
                        infoCount: 0,
                    });
                }
            },
        );
    };
}

// ---------------------------------------------------------------------------
// createSaveScenarioCommand
// ---------------------------------------------------------------------------

export function createSaveScenarioCommand(): () => Promise<void> {
    return async () => {
        const last = getLastTransform();
        if (!last) {
            vscode.window.showErrorMessage('Run a transform first before saving a scenario.');
            return;
        }

        const wsFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!wsFolder) {
            vscode.window.showErrorMessage('No workspace folder open.');
            return;
        }

        const name = await vscode.window.showInputBox({
            prompt: 'Scenario name',
            placeHolder: 'e.g. Invoice → HTML',
        });
        if (!name) {
            return;
        }

        let scenarios = readScenariosFile(wsFolder);
        const existingIndex = scenarios.findIndex(scenario => scenario.name === name);
        if (existingIndex !== -1) {
            const answer = await vscode.window.showWarningMessage(
                `Scenario "${name}" already exists. Overwrite?`,
                'Overwrite',
                'Cancel',
            );
            if (answer !== 'Overwrite') {
                return;
            }
        }

        scenarios = upsertScenarioEntry(wsFolder, {
            name,
            xmlPath: last.xmlPath,
            xsltPath: last.xsltPath,
            parameters: last.parameters,
            automations: last.automations ?? {},
        });

        PanelManager.postMessage({
            type: 'SCENARIO_LIST',
            scenarios,
        });
        vscode.window.showInformationMessage(`Scenario "${name}" saved.`);
    };
}

// ---------------------------------------------------------------------------
// createManageScenariosCommand
// ---------------------------------------------------------------------------

export function createManageScenariosCommand(): () => Promise<void> {
    return async () => {
        const wsFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!wsFolder) {
            vscode.window.showErrorMessage('No workspace folder open.');
            return;
        }

        const scenariosFilePath = getScenariosFilePath(wsFolder);
        const uri = vscode.Uri.file(scenariosFilePath);

        if (!fs.existsSync(scenariosFilePath)) {
            writeScenariosFile(wsFolder, []);
        }

        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc);
    };
}
