/**
 * Message types for communication between the VS Code extension host and the
 * webview panel. This file has NO vscode imports — it must be importable from
 * both the extension-side (Node) bundle and the webview-side browser bundle.
 *
 * Discriminated unions: use the `type` field to narrow in switch/if blocks.
 *
 * HostMessage   — extension host  → webview
 * WebviewMessage — webview        → extension host
 */

// ---------------------------------------------------------------------------
// Shared value types (no vscode dependency)
// ---------------------------------------------------------------------------

/** The set of validation profile keys used across the UI and validation pipeline. */
export const VALIDATION_PROFILES = ['auto', 'en16931', 'peppol-invoice', 'peppol-creditnote', 'xsd-only'] as const;
export type ValidationProfile = typeof VALIDATION_PROFILES[number];

/** Serialisable summary of one validation issue (no vscode.Uri / Location). */
export interface ValidationIssueSummary {
    severity: 'error' | 'warning' | 'info';
    message: string;
    ruleId?: string;
    source: 'local-xsd' | 'local-schematron' | 'helger';
    line: number;
    column: number;
    xsltLine?: number;
    xsltPath?: string;
    outputUri?: string;
}

/** Serialisable summary of one PHIVE rule result row shown in the Results pane. */
export interface ValidationRuleResultSummary {
    ruleId: string;
    description: string;
    status: 'passed' | 'failed' | 'skipped';
    passed: boolean;
    source: 'xsd' | 'schematron' | 'phive';
}

/** Display-only validation history row shown in the Results pane. */
export interface ValidationHistoryEntryMessage {
    timestamp: number;
    xmlPath: string;
    xsltPath?: string;
    outputUri?: string;
    detectedProfile?: string;
    issueCount: number;
    errorCount: number;
    warningCount: number;
    infoCount: number;
}

/** One XSLT parameter with its current value and chosen automation mode. */
export interface ParamEntry {
    name: string;
    /** Last resolved or user-typed value — shown in the panel input. */
    value: string;
    /**
     * Automation mode key:
     *   'manual'    — user types value each run
     *   'uuid'      — auto-generates a UUID v4
     *   'today'     — ISO date YYYY-MM-DD at run time
     *   'timestamp' — ISO-8601 datetime at run time
     *   'filename'  — basename+ext of the XML file
     *   'basename'  — basename without extension
     *   'xpath(...)'— evaluate an XPath 1.0 expression against the XML
     *   any other string is treated as a literal value
     */
    automation: string;
}

/** Minimal scenario descriptor (no resolved paths needed in the panel). */
export interface ScenarioSummary {
    name: string;
    xmlPath: string;
    xsltPath: string;
}

// ---------------------------------------------------------------------------
// Host → Webview messages
// ---------------------------------------------------------------------------

/** Sent after every validation run (or re-validate). */
export interface ValidationResultMessage {
    type: 'VALIDATION_RESULT';
    errorCount: number;
    warningCount: number;
    infoCount: number;
    /** Full issue list for the detail view (capped at reasonable length by host). */
    issues: ValidationIssueSummary[];
    /** DDD-detected Peppol profile VESID, e.g. "eu.peppol.bis3:invoice:2025.11.0" */
    detectedProfile?: string;
    ruleResults: ValidationRuleResultSummary[];
    exportAvailable?: boolean;
}

/** Sent after validation runs and on panel ready so the Results pane can show recent runs. */
export interface ValidationHistoryMessage {
    type: 'VALIDATION_HISTORY';
    history: ValidationHistoryEntryMessage[];
}

export interface PhiveStackSummaryMessage {
    stackId: string;
    primaryRulesVersion: string;
    source: string;
    installedAt: string;
    healthVerifiedAt: string | null;
    directVersions: {
        ddd: string;
        phive: string;
        rules: string;
    };
}

export interface PhiveCandidateSummaryMessage {
    stackId: string;
    source: string;
    directVersions: {
        ddd: string;
        phive: string;
        rules: string;
    };
    minimumExtensionVersion: string;
    minimumJavaMajor: number;
    publishedAt: string;
}

/** Sent on activation and after a phive update check/install. */
export interface PhiveStatusMessage {
    type: 'PHIVE_STATUS';
    activeVersion: string;
    activeStack: PhiveStackSummaryMessage;
    availableStack?: PhiveCandidateSummaryMessage;
    previousStack?: PhiveStackSummaryMessage | null;
    updateState: 'update-available' | 'up-to-date' | 'no-compatible-update' | 'empty-feed' | 'check-failed';
    updateAvailable: boolean;
    latestVersion?: string;
    latestPublishedAt?: string;
    lastCheckedAt?: string;
    canRollback: boolean;
    errorMessage?: string;
}

/** Sent when scenarios file changes or panel first opens. */
export interface ScenarioListMessage {
    type: 'SCENARIO_LIST';
    scenarios: ScenarioSummary[];
}

/**
 * Sent when a new XSLT is selected (or when the panel first opens with a
 * known last-transform state) so the param list can be populated.
 */
export interface ProfileListMessage {
    type: 'PROFILE_LIST';
    /** Absolute path of the XSLT — used as key for profile storage. */
    xsltPath: string;
    /** Saved profile names for this XSLT (may be empty). */
    profiles: string[];
    allProfiles?: Array<{ xsltPath: string; profileNames: string[] }>;
    /** If set, the dropdown auto-selects this profile after rendering (used after save). */
    savedProfileName?: string;
}

/**
 * Sent whenever the detected parameter set changes (new XSLT, or after the
 * host resolves automation values pre-flight so the panel can show previews).
 */
export interface ParamsChangedMessage {
    type: 'PARAMS_CHANGED';
    xsltPath: string;
    xmlPath: string;
    params: ParamEntry[];
}

/** Sent to webview after a scenario run completes. */
export interface ScenarioRunResultMessage {
    type: 'SCENARIO_RUN_RESULT';
    scenarioName: string;
    success: boolean;
    errorMessage?: string;
    errorCount: number;
    warningCount: number;
    infoCount: number;
}

/** Sent when file selection state changes (lock/unlock XML or XSLT). */
export interface LockStateMessage {
    type: 'LOCK_STATE';
    xml: boolean;
    xsl: boolean;
    params: boolean;
}

/** Sent when a validation profile is detected from XML or XSLT metadata. */
export interface ValidationProfileDetectedMessage {
    type: 'VALIDATION_PROFILE_DETECTED';
    profile: ValidationProfile | null;
    source: 'xml' | 'xsl' | null;
}

/** Sent when the user selects a file (XML or XSLT) from the file picker. */
export interface FileSelectedMessage {
    type: 'FILE_SELECTED';
    role: 'xml' | 'xsl';
    fsPath: string;
    fileName: string;
}

/** Sent by host to switch the webview to a specific tab. */
export interface SwitchTabMessage {
    type: 'SWITCH_TAB';
    tab: 'transform' | 'results';
}

/** Sent on panel open so the webview checkboxes reflect the saved validation state. */
export interface ValidationConfigStateMessage {
    type: 'VALIDATION_CONFIG_STATE';
    enabled: boolean;
    helger: boolean;
    profile: ValidationProfile;
}

export type HostMessage =
    | ValidationResultMessage
    | ValidationHistoryMessage
    | PhiveStatusMessage
    | ScenarioListMessage
    | ProfileListMessage
    | ParamsChangedMessage
    | ScenarioRunResultMessage
    | LockStateMessage
    | ValidationProfileDetectedMessage
    | FileSelectedMessage
    | SwitchTabMessage
    | ValidationConfigStateMessage;

// ---------------------------------------------------------------------------
// Webview → Host messages
// ---------------------------------------------------------------------------

/**
 * User clicked [Transform] in the panel.
 * The host uses the xmlPath / xsltPath from panel state if present, else falls back
 * to last stored state; params override any previously resolved values.
 */
export interface TransformRequestMessage {
    type: 'TRANSFORM_REQUEST';
    /** Final param values after automation resolution in the panel (may be partial). */
    params: Record<string, string>;
    /** Automation mode for each param — host will re-resolve xpath/uuid/etc. if needed. */
    automations: Record<string, string>;
    /** Panel-provided paths (new design). Host uses these if present, else falls back to lastTransform. */
    xmlPath?: string;
    xsltPath?: string;
    validationProfile?: ValidationProfile;
    validationEnabled?: boolean;
}

/** User clicked [Re-validate] — host re-runs validation on the last output.
 *  If xmlPath is provided, validate that XML file directly (no transform). */
export interface ValidateRequestMessage {
    type: 'VALIDATE_REQUEST';
    /** If set: validate this XML file directly. If absent: re-validate last transform output. */
    xmlPath?: string;
}

/** User clicked [Save Profile] — host persists params under the given name. */
export interface ParamsSaveMessage {
    type: 'PARAMS_SAVE';
    profileName: string;
    /** Absolute path of the XSLT — used as storage key. */
    xsltPath: string;
    params: Record<string, string>;
    automations: Record<string, string>;
}

/** User selected a scenario from the dropdown and clicked [Run]. */
export interface ScenarioRunMessage {
    type: 'SCENARIO_RUN';
    scenarioName: string;
}

/** User clicked [Load Profile] — host responds with a PARAMS_CHANGED message. */
export interface ProfileLoadMessage {
    type: 'PROFILE_LOAD';
    xsltPath: string;
    profileName: string;
}

/** User clicked [Delete Profile] in the panel. */
export interface ProfileDeleteMessage {
    type: 'PROFILE_DELETE';
    xsltPath: string;
    profileName: string;
}

/** User clicked [Check for updates] in the Phive section. */
export interface PhiveCheckUpdateMessage {
    type: 'PHIVE_CHECK_UPDATE';
}

export interface PhiveRollbackMessage {
    type: 'PHIVE_ROLLBACK';
}

/** User toggled the Helger validation checkbox. */
export interface HelgerToggleMessage {
    type: 'HELGER_TOGGLE';
    enabled: boolean;
}

/** User changed lock state for XML, XSLT, or parameters. */
export interface LockChangedMessage {
    type: 'LOCK_CHANGED';
    xml: boolean;
    xsl: boolean;
    params: boolean;
}

/** User clicked [Browse] to select an XML or XSLT file. */
export interface FilePickRequestMessage {
    type: 'FILE_PICK_REQUEST';
    role: 'xml' | 'xsl';
}

/** User changed validation configuration (enabled, Helger toggle, or profile). */
export interface ValidationConfigChangedMessage {
    type: 'VALIDATION_CONFIG_CHANGED';
    enabled: boolean;
    helger: boolean;
    profile: ValidationProfile;
}

/** User clicked [Save] to persist the current profile. */
export interface SaveProfileRequestMessage {
    type: 'SAVE_PROFILE_REQUEST';
    params: Record<string, string>;
    automations: Record<string, string>;
}

/** User clicked [Save] to persist the current scenario. */
export interface SaveScenarioRequestMessage {
    type: 'SAVE_SCENARIO_REQUEST';
    params?: Record<string, string>;
    automations?: Record<string, string>;
}

/** User selected a scenario from the dropdown -- host loads it without running. */
export interface ScenarioLoadRequestMessage {
    type: 'SCENARIO_LOAD_REQUEST';
    scenarioName: string;
}

/** User clicked an issue row -- host opens the XML file at that line. */
export interface NavigateToLineMessage {
    type: 'NAVIGATE_TO_LINE';
    line: number;
    xmlPath: string;
    target?: 'xml' | 'xslt';
    outputUri?: string;
    xsltPath?: string;
    xsltLine?: number;
}

/** User clicked × to clear an XML or XSL file selection. */
export interface FileClearedMessage {
    type: 'FILE_CLEARED';
    role: 'xml' | 'xsl';
}

/** User clicked [Delete Scenario] in the panel. */
export interface ScenarioDeleteRequestMessage {
    type: 'SCENARIO_DELETE_REQUEST';
    scenarioName: string;
}

/** User clicked [Manage…] for profiles — host shows multi-select Quick-Pick. */
export interface ManageProfilesRequestMessage {
    type: 'MANAGE_PROFILES_REQUEST';
}

/** User clicked [Manage…] for scenarios — host shows multi-select Quick-Pick. */
export interface ManageScenariosRequestMessage {
    type: 'MANAGE_SCENARIOS_REQUEST';
}

/** Sent by the webview once its message listener is registered and ready to receive host messages. */
export interface ReadyMessage {
    type: 'READY';
}

/** User clicked [Export HTML Report] in the Results pane. */
export interface ExportReportMessage {
    type: 'EXPORT_REPORT';
}

export type WebviewMessage =
    | TransformRequestMessage
    | ValidateRequestMessage
    | ParamsSaveMessage
    | ScenarioRunMessage
    | ProfileLoadMessage
    | ProfileDeleteMessage
    | PhiveCheckUpdateMessage
    | PhiveRollbackMessage
    | HelgerToggleMessage
    | LockChangedMessage
    | FilePickRequestMessage
    | ValidationConfigChangedMessage
    | SaveProfileRequestMessage
    | SaveScenarioRequestMessage
    | ScenarioLoadRequestMessage
    | NavigateToLineMessage
    | FileClearedMessage
    | ScenarioDeleteRequestMessage
    | ManageProfilesRequestMessage
    | ManageScenariosRequestMessage
    | ReadyMessage
    | ExportReportMessage;
