import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as vscode from 'vscode';
import * as child_process from 'child_process';

import { PhiveUpdateManager, resolveRecordedCheckStatus } from './validation/PhiveUpdateManager';
import { getConfig } from './config/settings';
import { createTransformCommand } from './commands/transformCommand';
import { createValidateDocumentCommand, createValidateXsdOnlyCommand, createValidateBusinessRulesOnlyCommand } from './commands/validateCommand';
import {
    createRunScenarioCommand,
    createSaveScenarioCommand,
    createManageScenariosCommand,
    readScenariosFile,
    findScenarioEntry,
    upsertScenarioEntry,
    deleteScenarioEntry,
    type ScenarioEntry,
} from './commands/scenarioCommand';
import { createWatchToggleCommand, registerWatchListener } from './commands/watchCommand';
import { createFixAllErrorsCommand, createSetApiKeyCommand, createFixThisErrorCommand } from './commands/aiCommands';
import { AiFixCodeActionProvider } from './ai/aiCodeActionProvider';
import { phiveDaemon, getActiveJarsDir, runPhiveRunnerHtml, PhiveRunnerHtmlError, type PhiveRunnerRuleResult } from './utils/javaRunner';
import { PanelManager } from './webview/panelManager';
import { resolveAutomation } from './validation/paramAutomation';
import { runPipeline } from './pipeline/transformAndValidate';
import { reportDiagnostics, reportXsltDiagnostics } from './validation/diagnosticsReporter';
import { getLastTransform, setLastTransform } from './state/lastTransform';
import { IssueSeverity, SchematronRuleset, ValidationIssue } from './validation/types';
import type { WebviewMessage, ParamEntry } from './webview/types';
import { detectUblDocumentFromContent, detectCustomizationId } from './validation/documentDetector';
import { validateXsd } from './validation/xsdValidator';
import { validateSchematronWithMetadata } from './validation/schematronValidator';
import { validateHelger } from './validation/helgerValidator';
import { ParamProfileManager } from './ui/paramProfiles';
import { pickFile } from './ui/filePicker';
import { buildIssueSummaries, countIssueSummaries } from './webview/issueSummaries';
import {
    findOpenTextDocument,
    openOrUpdateNamedOutputDocument,
    showDocumentInTargetColumn,
} from './ui/editorPlacement';
import { extractParamNames } from './utils/xsltParamUtils';
import type { PhiveStackCandidate, PhiveStackManifest } from './validation/phiveStackRuntime';
import { getHistory, pushHistoryEntry, type HistoryEntry } from './state/validationHistory';
import { makeReportPath } from './reports/htmlReportPath';
import { writeTempFile } from './utils/tempFile';
import {
    clearLastValidationExport,
    getLastValidationExport,
    hasPhiveHtmlExportableRuleResults,
    setLastValidationExport,
} from './state/lastValidationExport';

export function activate(context: vscode.ExtensionContext): void {
    // --- Shared resources ---
    const local  = vscode.languages.createDiagnosticCollection('xmlXslt.local');
    const helger = vscode.languages.createDiagnosticCollection('xmlXslt.helger');
    const xslt   = vscode.languages.createDiagnosticCollection('xmlXslt.xslt');
    const outputChannel = vscode.window.createOutputChannel('XSLT Studio');

    const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBar.show();

    // --- Watch mode status bar (separate from issue count to avoid clobbering) ---
    const watchStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 98);
    watchStatusBar.show();

    // --- Peppol version status bar (shows active phive-rules-peppol version) ---
    const phiveConfig = getConfig().phive;
    const phiveManager = new PhiveUpdateManager(
        context.globalStorageUri.fsPath,
        context.extensionPath,
        async (jarsDir) => {
            await phiveDaemon.restart(context.extensionPath, jarsDir);
        },
        {
            currentExtensionVersion: String(context.extension.packageJSON.version ?? '0.0.0'),
            feedUrl: phiveConfig.feedUrl,
            checkIntervalMs: phiveConfig.checkIntervalDays * 24 * 60 * 60 * 1000,
        },
    );
    const phiveStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
    phiveStatusBar.command = 'xmlXslt.checkPhiveUpdate';
    phiveStatusBar.tooltip = 'Curated PHIVE runtime stack — click to check for updates';
    phiveStatusBar.show();

    function toStackSummary(stack: PhiveStackManifest | null | undefined) {
        if (!stack) {
            return null;
        }
        return {
            stackId: stack.stackId,
            primaryRulesVersion: stack.primaryRulesVersion,
            source: stack.source,
            installedAt: stack.installedAt,
            healthVerifiedAt: stack.healthVerifiedAt,
            directVersions: stack.directVersions,
        };
    }

    function refreshPhiveStatusBar(candidate?: PhiveStackCandidate): void {
        const active = phiveManager.getStackStatus().activeStack;
        phiveStatusBar.text = candidate && active.stackId !== candidate.stackId
            ? `Peppol ${active.primaryRulesVersion} ↑`
            : `Peppol ${active.primaryRulesVersion}`;
        phiveStatusBar.tooltip =
            `Curated PHIVE stack · rules ${active.primaryRulesVersion} · ddd ${active.directVersions.ddd} · phive ${active.directVersions.phive}`;
    }

    function postPhiveStatus(
        updateState?: 'update-available' | 'up-to-date' | 'no-compatible-update' | 'empty-feed' | 'check-failed',
        candidate?: PhiveStackCandidate,
        errorMessage?: string,
    ): void {
        const status = phiveManager.getStackStatus();
        const lastCheck = phiveManager.getLastCheckInfo();
        const recordedStatus = resolveRecordedCheckStatus(lastCheck, status.activeStack.stackId);
        const resolvedUpdateState = updateState ?? recordedStatus?.updateState ?? 'up-to-date';
        const effectiveCandidate = resolvedUpdateState === 'check-failed'
            ? undefined
            : (candidate ?? (updateState ? undefined : recordedStatus?.candidate));
        const effectiveErrorMessage = resolvedUpdateState === 'check-failed'
            ? (errorMessage ?? recordedStatus?.errorMessage)
            : undefined;
        PanelManager.postMessage({
            type: 'PHIVE_STATUS',
            activeVersion: status.activeStack.primaryRulesVersion,
            activeStack: toStackSummary(status.activeStack)!,
            availableStack: effectiveCandidate ? {
                stackId: effectiveCandidate.stackId,
                source: effectiveCandidate.source,
                directVersions: effectiveCandidate.directVersions,
                minimumExtensionVersion: effectiveCandidate.minimumExtensionVersion,
                minimumJavaMajor: effectiveCandidate.minimumJavaMajor,
                publishedAt: effectiveCandidate.publishedAt,
            } : undefined,
            previousStack: toStackSummary(status.previousStack),
            updateState: resolvedUpdateState,
            updateAvailable: Boolean(
                resolvedUpdateState === 'update-available'
                && effectiveCandidate
                && status.activeStack.stackId !== effectiveCandidate.stackId,
            ),
            latestVersion: effectiveCandidate?.directVersions.rules,
            latestPublishedAt: effectiveCandidate?.publishedAt,
            lastCheckedAt: lastCheck?.checkedAt,
            canRollback: phiveManager.canRollback(),
            errorMessage: effectiveErrorMessage,
        });
    }

    refreshPhiveStatusBar();

    context.subscriptions.push(local, helger, xslt, outputChannel, statusBar, phiveStatusBar, watchStatusBar);

    // --- Java availability check (one-time, non-blocking) ---
    // Uses execFile (not exec) so there is no shell — the args are passed directly to the OS.
    child_process.execFile('java', ['-version'], (_err, _stdout, stderr) => {
        if (_err) {
            outputChannel.appendLine('[XSLT Studio] Java not found: ' + _err.message);
            vscode.window.showWarningMessage(
                'XSLT Studio: Java 8+ is required for XSLT transforms and XSD validation. ' +
                'Please install a JRE and ensure it is on your PATH.',
                'Dismiss'
            );
        } else {
            // java -version writes to stderr by design
            outputChannel.appendLine('[XSLT Studio] Java found: ' + stderr.trim());
        }
    });

    // --- Phive daemon (persistent JVM — pre-warms registry for fast validation) ---
    phiveDaemon.start(context.extensionPath, getActiveJarsDir(context.extensionPath, context.globalStorageUri.fsPath));

    // --- Peppol update check (silent, respects 7-day cooldown) ---
    if (getConfig().phive.checkForUpdates && phiveManager.shouldCheckNow()) {
        phiveManager.checkForUpdates().then((result) => {
            phiveManager.recordSuccessfulCheck(result.candidate);
            const active = phiveManager.getStackStatus().activeStack;
            if (result.status === 'update-available' && result.candidate) {
                refreshPhiveStatusBar(result.candidate);
                vscode.window.showInformationMessage(
                    `Curated PHIVE stack update available: rules ${active.primaryRulesVersion} → ${result.candidate.directVersions.rules}.`,
                    'Dismiss'
                );
            } else {
                refreshPhiveStatusBar();
            }
            postPhiveStatus(result.status, result.candidate);
        }).catch((error) => {
            phiveManager.recordFailedCheck(error);
            refreshPhiveStatusBar();
            postPhiveStatus('check-failed', undefined, error instanceof Error ? error.message : String(error));
        });
    }

    // --- Param profile manager (workspaceState-backed CRUD) ---
    const profileManager = new ParamProfileManager(context.workspaceState);

    function getPanelReferenceColumn(): vscode.ViewColumn | undefined {
        return PanelManager.getPanelViewColumn() ?? vscode.window.activeTextEditor?.viewColumn;
    }

    // Param-name cache: avoids re-reading the XSLT file on every panel message.
    // Keyed on xsltPath; invalidated when the file's mtime changes.
    const _paramNameCache = new Map<string, { mtime: number; names: string[] }>();

    function buildParamEntries(
        xsltPath: string,
        xmlPath: string,
        values: Record<string, string> = {},
        automations: Record<string, string> = {},
    ): ParamEntry[] {
        const mtime = (() => { try { return fs.statSync(xsltPath).mtimeMs; } catch { return 0; } })();
        const cached = _paramNameCache.get(xsltPath);
        const paramNames = (cached && cached.mtime === mtime)
            ? cached.names
            : (() => {
                const xslText = (() => { try { return fs.readFileSync(xsltPath, 'utf8'); } catch { return ''; } })();
                const names = xslText ? extractParamNames(xslText) : [];
                _paramNameCache.set(xsltPath, { mtime, names });
                return names;
            })();
        if (paramNames.length > 0) {
            return paramNames.map(name => ({
                name,
                value: values[name] ?? '',
                automation: automations[name] ?? 'manual',
            }));
        }
        const names = Array.from(new Set([
            ...Object.keys(values),
            ...Object.keys(automations),
        ]));
        return names.map(name => ({
            name,
            value: values[name] ?? '',
            automation: automations[name] ?? 'manual',
        }));
    }

    function postProfileList(xsltPath: string, savedProfileName?: string): void {
        PanelManager.postMessage({
            type: 'PROFILE_LIST',
            xsltPath,
            profiles: profileManager.listProfiles(xsltPath),
            allProfiles: profileManager.listAllProfiles().map(group => ({
                xsltPath: group.xsltPath,
                profileNames: group.profiles.map(profile => profile.name),
            })),
            savedProfileName,
        });
    }

    function postValidationHistory(entries: HistoryEntry[] = getHistory(context)): void {
        PanelManager.postMessage({
            type: 'VALIDATION_HISTORY',
            history: entries,
        });
    }

    async function recordValidationHistory(entry: HistoryEntry): Promise<void> {
        postValidationHistory(await pushHistoryEntry(context, entry));
    }

    function buildHistoryEntry(args: {
        timestamp: number;
        xmlPath: string;
        xsltPath?: string;
        outputUri?: vscode.Uri;
        detectedProfile?: string;
        errorCount: number;
        warningCount: number;
        infoCount: number;
        issueCount: number;
    }): HistoryEntry {
        return {
            timestamp: args.timestamp,
            xmlPath: args.xmlPath,
            xsltPath: args.xsltPath,
            outputUri: args.outputUri?.toString(),
            detectedProfile: args.detectedProfile,
            issueCount: args.issueCount,
            errorCount: args.errorCount,
            warningCount: args.warningCount,
            infoCount: args.infoCount,
        };
    }

    // --- WebView Panel message handler ---
    PanelManager.onMessage(async (msg: WebviewMessage) => {
        switch (msg.type) {
            case 'TRANSFORM_REQUEST': {
                const last     = getLastTransform();
                const xmlPath  = msg.xmlPath  ?? last?.xmlPath;
                const xsltPath = msg.xsltPath ?? last?.xsltPath;
                const xmlContent = xmlPath
                    ? (() => { try { return fs.readFileSync(xmlPath, 'utf8'); } catch { return ''; } })()
                    : last?.xmlContent ?? '';

                if (!xmlPath || !xsltPath || !xmlContent) {
                    vscode.window.showInformationMessage('Select XML and XSL files in the panel first.');
                    break;
                }
                const resolvedParams: Record<string, string> = { ...msg.params };
                for (const [name, automation] of Object.entries(msg.automations)) {
                    if (automation !== 'manual') {
                        try {
                            const resolved = await resolveAutomation(
                                automation, xmlPath, xmlContent,
                                (w) => outputChannel.appendLine('[ParamAutomation] ' + w)
                            );
                            if (resolved !== '') { resolvedParams[name] = resolved; }
                        } catch (err) {
                            outputChannel.appendLine('[ParamAutomation] Error: ' + String(err));
                        }
                    }
                }
                const baseConfig = getConfig();
                const panelVc = PanelManager.getValidationConfig(context);
                // Build effective config: override helger and validation-enabled from panel state
                const config = {
                    ...baseConfig,
                    validation: {
                        ...baseConfig.validation,
                        enableHelger: panelVc.helger,
                        ...(msg.validationEnabled === false ? {
                            enableSchematronEN16931: false,
                            enableSchematronPeppol: false,
                            enableHelger: false,
                        } : {}),
                    },
                };
                const artifactsPath = path.join(context.extensionPath, 'validation-artifacts');
                xslt.clear();
                outputChannel.appendLine('\n─────────────────────────────────────────────────');
                await vscode.window.withProgress(
                    { location: vscode.ProgressLocation.Notification, title: 'XSLT Transform', cancellable: true },
                    async (progress, token) => {
                        try {
                            const result = await runPipeline({
                                xmlContent: xmlContent, xsltPath: xsltPath,
                                extensionPath: context.extensionPath, artifactsPath,
                                globalStorageFsPath: context.globalStorageUri.fsPath,
                                parameters: resolvedParams, config,
                                cancellationToken: token, outputChannel,
                                onProgress: (m, inc) => { if (m) { try { progress.report({ message: m, increment: inc }); } catch { /* ignore */ } } },
                            });

                            const panelCol = getPanelReferenceColumn();
                            const outputDoc = await openOrUpdateNamedOutputDocument(
                                result.output,
                                result.outputLanguage,
                                panelCol,
                                {
                                    outputDestination: baseConfig.transform.outputDestination,
                                    defaultOutputExtension: baseConfig.transform.defaultOutputExtension,
                                    sourceXmlPath: xmlPath,
                                    sourceXsltPath: xsltPath,
                                },
                            );
                            if (!outputDoc) { return; }
                            const outputUri = outputDoc.uri;

                            // Persist so VALIDATE_REQUEST and AI fix commands can find it
                            setLastTransform({
                                xmlPath: xmlPath!, xsltPath: xsltPath!,
                                xmlContent, parameters: resolvedParams,
                                automations: msg.automations,
                                outputUri, outputDestination: baseConfig.transform.outputDestination,
                            });

                            reportDiagnostics(local, helger, outputUri, result.issues, result.traceMap);
                            reportXsltDiagnostics(xslt, xsltPath!, result.issues, result.traceMap);

                            const issueSummaries = buildIssueSummaries(result.issues, {
                                traceMap: result.traceMap,
                                outputUri,
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
                                    xmlPath,
                                    xsltPath,
                                    detectedProfile: result.detectedProfile,
                                    validatedXmlContent: result.output,
                                });
                            } else {
                                clearLastValidationExport();
                            }
                            await recordValidationHistory(buildHistoryEntry({
                                timestamp: validationTimestamp,
                                xmlPath,
                                xsltPath,
                                outputUri,
                                detectedProfile: result.detectedProfile,
                                issueCount: issueSummaries.length,
                                ...counts,
                            }));
                            // Sync validation config + profile detection back to panel
                            const vcAfter = PanelManager.getValidationConfig(context);
                            PanelManager.postMessage({ type: 'VALIDATION_CONFIG_STATE', ...vcAfter });
                            if (xmlPath && xsltPath) {
                                const det = detectCustomizationId(xmlPath, xsltPath);
                                PanelManager.postMessage({ type: 'VALIDATION_PROFILE_DETECTED', profile: det.profile, source: det.source });
                            }
                            statusBar.text = result.issues.length > 0
                                ? `$(warning) ${result.issues.length} issues` : `$(check) No issues`;
                        } catch (err) {
                            const m = err instanceof Error ? err.message : String(err);
                            outputChannel.appendLine('[Transform] ERROR: ' + m);
                            if (!/cancelled/i.test(m)) { vscode.window.showErrorMessage(`XSLT Transform failed: ${m}`); }
                        }
                    }
                );
                break;
            }
            case 'VALIDATE_REQUEST': {
                const valArtifacts = path.join(context.extensionPath, 'validation-artifacts');
                const valConfig = getConfig();
                const panelVc2 = PanelManager.getValidationConfig(context);
                const phiveJarsDir = getActiveJarsDir(context.extensionPath, context.globalStorageUri.fsPath);

                // Helper: run XSD + Schematron + Helger on a content string, post results to panel
                const runValidation = async (
                    valContent: string,
                    diagnosticUri: vscode.Uri,
                    snapshot: {
                        timestamp: number;
                        xmlPath: string;
                        xsltPath?: string;
                    },
                ): Promise<void> => {
                    const docInfo = detectUblDocumentFromContent(valContent, valArtifacts);
                    if (!docInfo) {
                        PanelManager.postMessage({
                            type: 'VALIDATION_RESULT',
                            errorCount: 0, warningCount: 0, infoCount: 1,
                            issues: [{ severity: 'info', message: 'Not a recognized UBL document', source: 'local-xsd', line: 1, column: 0 }],
                            detectedProfile: undefined,
                            ruleResults: [],
                            exportAvailable: false,
                        });
                        clearLastValidationExport();
                        await recordValidationHistory(buildHistoryEntry({
                            timestamp: snapshot.timestamp,
                            xmlPath: snapshot.xmlPath,
                            xsltPath: snapshot.xsltPath,
                            issueCount: 1,
                            errorCount: 0,
                            warningCount: 0,
                            infoCount: 1,
                        }));
                        return;
                    }
                    const allIssues: ValidationIssue[] = [];
                    let ruleResults: PhiveRunnerRuleResult[] = [];
                    let detectedProfile: string | undefined;
                    allIssues.push(...await validateXsd(valContent, docInfo, valArtifacts, context.extensionPath));
                    const rulesets: SchematronRuleset[] = [];
                    if (valConfig.validation.enableSchematronEN16931) { rulesets.push(SchematronRuleset.EN16931); }
                    if (valConfig.validation.enableSchematronPeppol)  { rulesets.push(SchematronRuleset.Peppol); }
                    if (rulesets.length > 0 && (docInfo.docType === 'Invoice' || docInfo.docType === 'CreditNote')) {
                        try {
                            const schematronResult = await validateSchematronWithMetadata(valContent, rulesets, valArtifacts, context.extensionPath, phiveJarsDir);
                            allIssues.push(...schematronResult.issues);
                            ruleResults = schematronResult.ruleResults;
                            detectedProfile = schematronResult.detectedProfile;
                        } catch { /* ignore */ }
                    }
                    if (panelVc2.helger) {
                        try { allIssues.push(...await validateHelger(valContent, docInfo, valConfig)); } catch { /* ignore */ }
                    }
                    const issueSummaries = buildIssueSummaries(allIssues, {
                        outputUri: msg.xmlPath ? undefined : diagnosticUri,
                    });
                    const counts = countIssueSummaries(issueSummaries);
                    const exportAvailable = hasPhiveHtmlExportableRuleResults(ruleResults);
                    PanelManager.postMessage({
                        type: 'VALIDATION_RESULT',
                        issues: issueSummaries,
                        detectedProfile,
                        ruleResults,
                        exportAvailable,
                        ...counts,
                    });
                    if (exportAvailable) {
                        setLastValidationExport({
                            timestamp: snapshot.timestamp,
                            xmlPath: snapshot.xmlPath,
                            xsltPath: snapshot.xsltPath,
                            detectedProfile,
                            validatedXmlContent: valContent,
                        });
                    } else {
                        clearLastValidationExport();
                    }
                    await recordValidationHistory(buildHistoryEntry({
                        timestamp: snapshot.timestamp,
                        xmlPath: snapshot.xmlPath,
                        xsltPath: snapshot.xsltPath,
                        outputUri: msg.xmlPath ? undefined : diagnosticUri,
                        detectedProfile,
                        issueCount: issueSummaries.length,
                        ...counts,
                    }));
                    reportDiagnostics(local, helger, diagnosticUri, allIssues, new Map());
                };

                if (msg.xmlPath) {
                    // Validate XML file directly (no transform) — "Validate" btn with only XML selected
                    let xmlContent: string;
                    try { xmlContent = fs.readFileSync(msg.xmlPath, 'utf8'); } catch { break; }
                    const validationTimestamp = Date.now();
                    await vscode.window.withProgress(
                        { location: vscode.ProgressLocation.Notification, title: 'Validating...' },
                        () => runValidation(xmlContent, vscode.Uri.file(msg.xmlPath!), {
                            timestamp: validationTimestamp,
                            xmlPath: msg.xmlPath!,
                        })
                    );
                    PanelManager.postMessage({ type: 'SWITCH_TAB', tab: 'results' });
                } else {
                    // Re-validate last transform output (reads in-memory unsaved content)
                    const last = getLastTransform();
                    if (!last?.outputUri) {
                        vscode.window.showInformationMessage('Run a Transform first, then Re-validate.');
                        break;
                    }
                    const outputDoc = vscode.workspace.textDocuments.find(
                        d => d.uri.toString() === last.outputUri!.toString()
                    );
                    if (!outputDoc) { break; }
                    const validationTimestamp = Date.now();
                    await vscode.window.withProgress(
                        { location: vscode.ProgressLocation.Notification, title: 'Validating...' },
                        () => runValidation(outputDoc.getText(), outputDoc.uri, {
                            timestamp: validationTimestamp,
                            xmlPath: last.xmlPath,
                            xsltPath: last.xsltPath,
                        })
                    );
                }
                break;
            }
            case 'PHIVE_CHECK_UPDATE':
                vscode.commands.executeCommand('xmlXslt.checkPhiveUpdate');
                break;
            case 'PHIVE_ROLLBACK':
                vscode.commands.executeCommand('xmlXslt.rollbackPhiveUpdate');
                break;
            case 'HELGER_TOGGLE':
                await vscode.workspace.getConfiguration('xmlXslt').update(
                    'validation.enableHelger', msg.enabled, vscode.ConfigurationTarget.Workspace
                );
                break;
            case 'SCENARIO_RUN':
                vscode.commands.executeCommand('xmlXslt.runScenario', msg.scenarioName);
                break;
            case 'PARAMS_SAVE': {
                await profileManager.saveProfile(msg.xsltPath, msg.profileName, msg.params, msg.automations);
                postProfileList(msg.xsltPath);
                break;
            }
            case 'PROFILE_LOAD': {
                const profile = profileManager.loadProfile(msg.xsltPath, msg.profileName);
                if (profile) {
                    const currentFiles = PanelManager.getPanelFiles(context);
                    const locksState = PanelManager.getLocks(context);
                    if (currentFiles.xslPath && currentFiles.xslPath !== msg.xsltPath && locksState.xsl) {
                        vscode.window.showInformationMessage('Unlock the current XSL file before loading a profile from another stylesheet.');
                        break;
                    }
                    if (currentFiles.xslPath !== msg.xsltPath) {
                        const nextFiles = { xmlPath: currentFiles.xmlPath, xslPath: msg.xsltPath };
                        await PanelManager.setPanelFiles(context, nextFiles);
                        PanelManager.postMessage({
                            type: 'FILE_SELECTED',
                            role: 'xsl',
                            fsPath: msg.xsltPath,
                            fileName: path.basename(msg.xsltPath),
                        });
                        try {
                            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(msg.xsltPath));
                            await showDocumentInTargetColumn(doc, doc.uri, getPanelReferenceColumn(), { preview: true });
                        } catch { /* ignore missing file */ }
                    }
                    const mergedParams = buildParamEntries(
                        msg.xsltPath,
                        currentFiles.xmlPath || getLastTransform()?.xmlPath || '',
                        profile.params,
                        profile.automations,
                    );
                    PanelManager.postMessage({
                        type: 'PARAMS_CHANGED',
                        xsltPath: msg.xsltPath,
                        xmlPath: currentFiles.xmlPath || getLastTransform()?.xmlPath || '',
                        params: mergedParams,
                    });
                    postProfileList(msg.xsltPath, msg.profileName);
                    const filesAfterLoad = PanelManager.getPanelFiles(context);
                    if (filesAfterLoad.xmlPath && filesAfterLoad.xslPath) {
                        const det = detectCustomizationId(filesAfterLoad.xmlPath, filesAfterLoad.xslPath);
                        PanelManager.postMessage({ type: 'VALIDATION_PROFILE_DETECTED', profile: det.profile, source: det.source });
                    }
                }
                break;
            }
            case 'PROFILE_DELETE': {
                await profileManager.deleteProfile(msg.xsltPath, msg.profileName);
                postProfileList(msg.xsltPath);
                break;
            }
            case 'SCENARIO_DELETE_REQUEST': {
                const wsf = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                if (!wsf || !msg.scenarioName) { break; }
                deleteScenarioEntry(wsf, msg.scenarioName);
                const scenarios = readScenariosFile(wsf).map(s => ({ name: s.name, xmlPath: s.xmlPath, xsltPath: s.xsltPath }));
                PanelManager.postMessage({ type: 'SCENARIO_LIST', scenarios });
                break;
            }
            case 'MANAGE_PROFILES_REQUEST': {
                const allProfiles = profileManager.listAllProfiles();
                const items: vscode.QuickPickItem[] = [];
                for (const group of allProfiles) {
                    for (const profile of group.profiles) {
                        items.push({ label: profile.name, description: path.basename(group.xsltPath), detail: group.xsltPath });
                    }
                }
                if (items.length === 0) { vscode.window.showInformationMessage('No profiles saved.'); break; }
                const selected = await vscode.window.showQuickPick(items, { canPickMany: true, placeHolder: 'Select profiles to delete — space to select, Enter to confirm' });
                if (!selected || selected.length === 0) { break; }
                for (const item of selected) {
                    await profileManager.deleteProfile(item.detail!, item.label);
                }
                const panelFiles = PanelManager.getPanelFiles(context);
                postProfileList(panelFiles.xslPath ?? '');
                break;
            }
            case 'MANAGE_SCENARIOS_REQUEST': {
                const wsf2 = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                if (!wsf2) { break; }
                const allScenarios = readScenariosFile(wsf2);
                if (allScenarios.length === 0) { vscode.window.showInformationMessage('No scenarios saved.'); break; }
                const scenarioItems: vscode.QuickPickItem[] = allScenarios.map(s => ({
                    label: s.name,
                    description: `${path.basename(s.xmlPath)} \u2192 ${path.basename(s.xsltPath)}`,
                }));
                const selectedScenarios = await vscode.window.showQuickPick(scenarioItems, { canPickMany: true, placeHolder: 'Select scenarios to delete — space to select, Enter to confirm' });
                if (!selectedScenarios || selectedScenarios.length === 0) { break; }
                for (const item of selectedScenarios) {
                    deleteScenarioEntry(wsf2, item.label);
                }
                const updatedScenarios = readScenariosFile(wsf2).map(s => ({ name: s.name, xmlPath: s.xmlPath, xsltPath: s.xsltPath }));
                PanelManager.postMessage({ type: 'SCENARIO_LIST', scenarios: updatedScenarios });
                break;
            }
            case 'FILE_PICK_REQUEST': {
                const cl = PanelManager.getLocks(context);
                if (msg.role === 'xml' ? cl.xml : cl.xsl) { break; }
                const result = await pickFile(msg.role === 'xml' ? 'xml' : 'xslt', context);
                if (!result) { break; }
                const cur = PanelManager.getPanelFiles(context);
                const updated = msg.role === 'xml'
                    ? { xmlPath: result.fsPath, xslPath: cur.xslPath }
                    : { xmlPath: cur.xmlPath,   xslPath: result.fsPath };
                await PanelManager.setPanelFiles(context, updated);
                PanelManager.postMessage({ type: 'FILE_SELECTED', role: msg.role, fsPath: result.fsPath, fileName: path.basename(result.fsPath) });
                if (msg.role === 'xsl') {
                    PanelManager.postMessage({
                        type: 'PARAMS_CHANGED', xsltPath: result.fsPath, xmlPath: updated.xmlPath,
                        params: buildParamEntries(result.fsPath, updated.xmlPath),
                    });
                    postProfileList(result.fsPath);
                }
                if (updated.xmlPath && updated.xslPath) {
                    const det = detectCustomizationId(updated.xmlPath, updated.xslPath);
                    PanelManager.postMessage({ type: 'VALIDATION_PROFILE_DETECTED', profile: det.profile, source: det.source });
                }
                break;
            }

            case 'LOCK_CHANGED':
                await PanelManager.setLocks(context, { xml: msg.xml, xsl: msg.xsl, params: msg.params });
                break;

            case 'VALIDATION_CONFIG_CHANGED':
                await PanelManager.setValidationConfig(context, { enabled: msg.enabled, helger: msg.helger, profile: msg.profile });
                await vscode.workspace.getConfiguration('xmlXslt').update(
                    'validation.enableHelger', msg.helger, vscode.ConfigurationTarget.Workspace
                );
                break;

            case 'SAVE_PROFILE_REQUEST': {
                const files = PanelManager.getPanelFiles(context);
                if (!files.xslPath) { vscode.window.showWarningMessage('Select an XSL file first.'); break; }
                const name = await vscode.window.showInputBox({ prompt: 'Profile name', placeHolder: 'e.g. default' });
                if (!name) { break; }
                await profileManager.saveProfile(files.xslPath, name, msg.params, msg.automations);
                postProfileList(files.xslPath, name);
                vscode.window.showInformationMessage(`Profile "${name}" saved.`);
                break;
            }

            case 'SAVE_SCENARIO_REQUEST': {
                const files = PanelManager.getPanelFiles(context);
                if (!files.xmlPath || !files.xslPath) {
                    vscode.window.showWarningMessage('Select both XML and XSL files first.'); break;
                }
                const name = await vscode.window.showInputBox({ prompt: 'Scenario name', placeHolder: 'e.g. invoice-test' });
                if (!name) { break; }
                const wsFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                if (!wsFolder) { break; }
                const existingScenario = findScenarioEntry(wsFolder, name);
                if (existingScenario) {
                    const answer = await vscode.window.showWarningMessage(
                        `Scenario "${name}" already exists. Overwrite?`,
                        'Overwrite',
                        'Cancel',
                    );
                    if (answer !== 'Overwrite') { break; }
                }
                let scenarios: ScenarioEntry[];
                try {
                    scenarios = upsertScenarioEntry(wsFolder, {
                        name,
                        xmlPath: files.xmlPath,
                        xsltPath: files.xslPath,
                        parameters: msg.params ?? {},
                        automations: msg.automations ?? {},
                    });
                } catch (err) {
                    vscode.window.showErrorMessage(`Could not save scenario: ${err instanceof Error ? err.message : String(err)}`);
                    break;
                }
                PanelManager.postMessage({ type: 'SCENARIO_LIST', scenarios });
                vscode.window.showInformationMessage(`Scenario "${name}" saved.`);
                break;
            }

            case 'SCENARIO_LOAD_REQUEST': {
                const wsf = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                if (!wsf) { break; }
                const sc = findScenarioEntry(wsf, msg.scenarioName);
                if (!sc) { break; }
                const cl2 = PanelManager.getLocks(context);
                if (cl2.xml) {
                    const ans = await vscode.window.showInformationMessage("XML is locked \u2014 apply scenario's XML path anyway?", 'Yes', 'No');
                    if (ans !== 'Yes') { break; }
                }
                if (cl2.xsl) {
                    const ans = await vscode.window.showInformationMessage("XSL is locked \u2014 apply scenario's XSL path anyway?", 'Yes', 'No');
                    if (ans !== 'Yes') { break; }
                }
                await PanelManager.setPanelFiles(context, { xmlPath: sc.xmlPath, xslPath: sc.xsltPath });
                PanelManager.postMessage({ type: 'FILE_SELECTED', role: 'xml', fsPath: sc.xmlPath, fileName: path.basename(sc.xmlPath) });
                PanelManager.postMessage({ type: 'FILE_SELECTED', role: 'xsl', fsPath: sc.xsltPath, fileName: path.basename(sc.xsltPath) });
                PanelManager.postMessage({
                    type: 'PARAMS_CHANGED', xsltPath: sc.xsltPath, xmlPath: sc.xmlPath,
                    params: buildParamEntries(sc.xsltPath, sc.xmlPath, sc.parameters, sc.automations),
                });
                postProfileList(sc.xsltPath);
                if (sc.xmlPath && sc.xsltPath) {
                    const det = detectCustomizationId(sc.xmlPath, sc.xsltPath);
                    PanelManager.postMessage({ type: 'VALIDATION_PROFILE_DETECTED', profile: det.profile, source: det.source });
                }
                break;
            }

            case 'FILE_CLEARED': {
                const curFiles = PanelManager.getPanelFiles(context);
                await PanelManager.setPanelFiles(context, msg.role === 'xml'
                    ? { xmlPath: '', xslPath: curFiles.xslPath }
                    : { xmlPath: curFiles.xmlPath, xslPath: '' });
                break;
            }

            case 'NAVIGATE_TO_LINE': {
                try {
                    const panelCol = getPanelReferenceColumn();
                    if (msg.target === 'xslt') {
                        if (!msg.xsltPath || !msg.xsltLine) { break; }
                        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(msg.xsltPath));
                        const pos = new vscode.Position(Math.max(0, msg.xsltLine - 1), 0);
                        await showDocumentInTargetColumn(
                            doc,
                            doc.uri,
                            panelCol,
                            { selection: new vscode.Range(pos, pos), preview: false },
                        );
                        break;
                    }
                    if (!msg.outputUri && !msg.xmlPath) { break; }
                    let targetUri = msg.outputUri ? vscode.Uri.parse(msg.outputUri) : vscode.Uri.file(msg.xmlPath);
                    if (msg.outputUri && targetUri.scheme === 'untitled' && !findOpenTextDocument(targetUri)) {
                        vscode.window.showInformationMessage('The transform output tab is no longer open.');
                        break;
                    }
                    const doc = await vscode.workspace.openTextDocument(targetUri);
                    const pos = new vscode.Position(Math.max(0, msg.line - 1), 0);
                    await showDocumentInTargetColumn(
                        doc,
                        targetUri,
                        panelCol,
                        { selection: new vscode.Range(pos, pos), preview: false },
                    );
                } catch { /* file not found */ }
                break;
            }

            case 'READY':
                // Webview JS is loaded and listening — safe to send initial state now.
                sendPanelInitialState();
                break;

            case 'EXPORT_REPORT': {
                const snapshot = getLastValidationExport();
                if (!snapshot) {
                    vscode.window.showInformationMessage('Run a validation first, then export the HTML report.');
                    break;
                }

                const tempXml = writeTempFile(snapshot.validatedXmlContent, '.xml');
                try {
                    const phiveJarsDir = getActiveJarsDir(context.extensionPath, context.globalStorageUri.fsPath);
                    const html = await runPhiveRunnerHtml({
                        extensionPath: context.extensionPath,
                        xmlFilePath: tempXml.filePath,
                        phiveJarsDir,
                    });
                    const reportPath = makeReportPath(os.tmpdir(), snapshot.timestamp);
                    fs.writeFileSync(reportPath, html, 'utf8');
                    await vscode.env.openExternal(vscode.Uri.file(reportPath));
                } catch (error) {
                    const runnerOutputError = error instanceof PhiveRunnerHtmlError
                        ? error.runnerOutput?.error
                        : undefined;
                    const baseMessage = error instanceof Error ? error.message : String(error);
                    const detail = runnerOutputError ? ` PHIVE error: ${runnerOutputError}` : '';
                    vscode.window.showErrorMessage(`Could not export PHIVE HTML report: ${baseMessage}${detail}`);
                } finally {
                    tempXml.cleanup();
                }
                break;
            }

            default: break;
        }
    });

    // Send initial state to panel when opened
    async function sendPanelInitialState(): Promise<void> {
        const sl = PanelManager.getLocks(context);
        PanelManager.postMessage({ type: 'LOCK_STATE', ...sl });

        // Send saved validation config so checkboxes reflect actual state (not hardcoded defaults)
        const vc = PanelManager.getValidationConfig(context);
        PanelManager.postMessage({ type: 'VALIDATION_CONFIG_STATE', ...vc });

        let sf = PanelManager.getPanelFiles(context);
        // Clear unlocked paths so auto-detect always runs from current open tabs.
        // Locked files persist across panel opens; unlocked ones re-detect every time.
        if (!sl.xml) { sf = { xmlPath: '', xslPath: sf.xslPath }; }
        if (!sl.xsl) { sf = { xmlPath: sf.xmlPath, xslPath: '' }; }

        // Auto-detect from open tabs when paths are empty
        if (!sf.xmlPath || !sf.xslPath) {
            const openXml: string[] = [];
            const openXsl: string[] = [];
            for (const group of vscode.window.tabGroups.all) {
                for (const tab of group.tabs) {
                    if (tab.input instanceof vscode.TabInputText) {
                        const fp = tab.input.uri.fsPath;
                        if (fp.endsWith('.xml') && !openXml.includes(fp)) { openXml.push(fp); }
                        if ((fp.endsWith('.xsl') || fp.endsWith('.xslt')) && !openXsl.includes(fp)) { openXsl.push(fp); }
                    }
                }
            }
            // Auto-fill if exactly one candidate; show QuickPick when multiple are open
            if (!sf.xmlPath && openXml.length === 1) {
                sf = { xmlPath: openXml[0], xslPath: sf.xslPath };
                PanelManager.setPanelFiles(context, sf).catch(() => undefined);
            } else if (!sf.xmlPath && openXml.length > 1) {
                const picked = await vscode.window.showQuickPick(
                    openXml.map(fp => ({ label: path.basename(fp), description: fp })),
                    { placeHolder: 'Select XML input file for XSLT Studio' }
                );
                if (picked) {
                    sf = { xmlPath: picked.description!, xslPath: sf.xslPath };
                    PanelManager.setPanelFiles(context, sf).catch(() => undefined);
                }
            }
            if (!sf.xslPath && openXsl.length === 1) {
                sf = { xmlPath: sf.xmlPath, xslPath: openXsl[0] };
                PanelManager.setPanelFiles(context, sf).catch(() => undefined);
            } else if (!sf.xslPath && openXsl.length > 1) {
                const picked = await vscode.window.showQuickPick(
                    openXsl.map(fp => ({ label: path.basename(fp), description: fp })),
                    { placeHolder: 'Select XSL stylesheet for XSLT Studio' }
                );
                if (picked) {
                    sf = { xmlPath: sf.xmlPath, xslPath: picked.description! };
                    PanelManager.setPanelFiles(context, sf).catch(() => undefined);
                }
            }
        }

        if (sf.xmlPath) {
            PanelManager.postMessage({ type: 'FILE_SELECTED', role: 'xml', fsPath: sf.xmlPath, fileName: path.basename(sf.xmlPath) });
        }
        if (sf.xslPath) {
            PanelManager.postMessage({ type: 'FILE_SELECTED', role: 'xsl', fsPath: sf.xslPath, fileName: path.basename(sf.xslPath) });
            PanelManager.postMessage({
                type: 'PARAMS_CHANGED', xsltPath: sf.xslPath, xmlPath: sf.xmlPath,
                params: buildParamEntries(sf.xslPath, sf.xmlPath),
            });
        }
        postProfileList(sf.xslPath ?? '');
        if (sf.xmlPath && sf.xslPath) {
            const det = detectCustomizationId(sf.xmlPath, sf.xslPath);
            PanelManager.postMessage({ type: 'VALIDATION_PROFILE_DETECTED', profile: det.profile, source: det.source });
        }

        postPhiveStatus();
        postValidationHistory();
        const wsFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (wsFolder) {
            try {
                PanelManager.postMessage({ type: 'SCENARIO_LIST', scenarios: readScenariosFile(wsFolder) });
            } catch { /* malformed file — ignore */ }
        }
        // Fall back to last transform params only if no XSL file is currently set
        if (!sf.xslPath) {
            const last = getLastTransform();
            if (last) {
                PanelManager.postMessage({
                    type: 'PARAMS_CHANGED',
                    xsltPath: last.xsltPath, xmlPath: last.xmlPath,
                    params: buildParamEntries(last.xsltPath, last.xmlPath, last.parameters, last.automations),
                });
            }
        }
    }

    // --- Command registrations ---
    context.subscriptions.push(
        vscode.commands.registerCommand(
            'xmlXslt.openPanel',
            () => {
                const alreadyOpen = PanelManager.isOpen();
                PanelManager.createOrShow(context.extensionUri, context);
                // If the panel was already open (just hidden), the webview JS is still running —
                // send initial state immediately. If this is a fresh panel creation, wait for
                // the READY message from the webview (sent once its listener is registered).
                if (alreadyOpen) { sendPanelInitialState(); }
            }
        ),
        vscode.commands.registerCommand(
            'xmlXslt.transform',
            createTransformCommand(context, local, helger, xslt, statusBar, outputChannel)
        ),
        vscode.commands.registerCommand(
            'xmlXslt.validateDocument',
            createValidateDocumentCommand(context, local, helger, outputChannel)
        ),
        vscode.commands.registerCommand(
            'xmlXslt.validateXsdOnly',
            createValidateXsdOnlyCommand(context, local, helger, outputChannel)
        ),
        vscode.commands.registerCommand(
            'xmlXslt.validateBusinessRulesOnly',
            createValidateBusinessRulesOnlyCommand(context, local, helger, outputChannel)
        ),
        vscode.commands.registerCommand(
            'xmlXslt.runScenario',
            (preselectedName?: string) => createRunScenarioCommand(context, local, helger)(preselectedName)
        ),
        vscode.commands.registerCommand(
            'xmlXslt.saveScenario',
            createSaveScenarioCommand()
        ),
        vscode.commands.registerCommand(
            'xmlXslt.manageScenarios',
            createManageScenariosCommand()
        ),
        vscode.commands.registerCommand(
            'xmlXslt.toggleWatch',
            createWatchToggleCommand(watchStatusBar)
        ),
        vscode.commands.registerCommand(
            'xmlXslt.fixAllErrors',
            createFixAllErrorsCommand(context, local, helger)
        ),
        vscode.commands.registerCommand(
            'xmlXslt.setApiKey',
            createSetApiKeyCommand(context)
        ),
        vscode.commands.registerCommand(
            'xmlXslt.fixThisError',
            createFixThisErrorCommand(context)
        ),
        vscode.commands.registerCommand(
            'xmlXslt.checkPhiveUpdate',
            async () => {
                phiveStatusBar.text = 'Peppol checking\u2026';
                try {
                    const result = await phiveManager.checkForUpdates();
                    phiveManager.recordSuccessfulCheck(result.candidate);
                    const active = phiveManager.getStackStatus().activeStack;
                    if (result.status === 'empty-feed') {
                        refreshPhiveStatusBar();
                        vscode.window.showWarningMessage('No update information available — the curated PHIVE feed is empty.');
                    } else if (result.status === 'up-to-date') {
                        refreshPhiveStatusBar();
                        vscode.window.showInformationMessage(`Curated PHIVE feed is up to date (rules ${active.primaryRulesVersion}).`);
                    } else if (result.status === 'no-compatible-update') {
                        refreshPhiveStatusBar();
                        vscode.window.showInformationMessage(
                            `No compatible curated PHIVE update is available for extension ${result.extensionVersion} on Java ${result.javaMajor}.`,
                        );
                    } else if (result.candidate) {
                        const action = await vscode.window.showInformationMessage(
                            `Install curated PHIVE stack update? rules ${active.primaryRulesVersion} → ${result.candidate.directVersions.rules} ` +
                            `(ddd ${result.candidate.directVersions.ddd}, phive ${result.candidate.directVersions.phive})`,
                            'Install',
                            'Dismiss',
                        );
                        if (action === 'Install') {
                            try {
                                const installed = await vscode.window.withProgress(
                                    { location: vscode.ProgressLocation.Notification, title: 'Updating curated PHIVE stack' },
                                    (progress) => phiveManager.installUpdate(progress, result.candidate),
                                );
                                vscode.window.showInformationMessage(`Curated PHIVE stack updated to rules ${installed.primaryRulesVersion}.`);
                                refreshPhiveStatusBar();
                                postPhiveStatus('up-to-date');
                                return;
                            } catch (installError) {
                                refreshPhiveStatusBar(result.candidate);
                                postPhiveStatus('update-available', result.candidate);
                                vscode.window.showWarningMessage(
                                    `Curated PHIVE stack update failed: ${installError instanceof Error ? installError.message : String(installError)}`,
                                );
                                return;
                            }
                        }
                        refreshPhiveStatusBar(result.candidate);
                    }
                    postPhiveStatus(result.status, result.candidate);
                } catch (err) {
                    refreshPhiveStatusBar();
                    phiveManager.recordFailedCheck(err);
                    postPhiveStatus('check-failed', undefined, err instanceof Error ? err.message : String(err));
                    vscode.window.showWarningMessage(
                        `Could not check the curated PHIVE feed: ${err instanceof Error ? err.message : String(err)}`
                    );
                }
            }
        ),
        vscode.commands.registerCommand(
            'xmlXslt.rollbackPhiveUpdate',
            async () => {
                if (!phiveManager.canRollback()) {
                    vscode.window.showInformationMessage('No previous PHIVE stack is available for rollback.');
                    return;
                }
                try {
                    const restored = await phiveManager.rollbackActiveStack();
                    refreshPhiveStatusBar();
                    postPhiveStatus();
                    vscode.window.showInformationMessage(`Rolled back to PHIVE rules ${restored.primaryRulesVersion}.`);
                } catch (err) {
                    vscode.window.showWarningMessage(
                        `PHIVE rollback failed: ${err instanceof Error ? err.message : String(err)}`
                    );
                }
            }
        ),
    );

    // --- Watch listener (always registered, gated internally by isWatchEnabled flag) ---
    registerWatchListener(context, local, helger, watchStatusBar);

    // --- Code action provider (AI fix on individual diagnostics) ---
    context.subscriptions.push(
        vscode.languages.registerCodeActionsProvider(
            AiFixCodeActionProvider.documentSelector,
            new AiFixCodeActionProvider(),
            { providedCodeActionKinds: AiFixCodeActionProvider.providedCodeActionKinds }
        )
    );
}

export function deactivate(): void {
    phiveDaemon.stop();
    PanelManager.dispose();
    // VS Code disposes all context.subscriptions automatically
}
