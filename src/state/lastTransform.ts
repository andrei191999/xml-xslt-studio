import type * as vscode from 'vscode';

/**
 * Persists the state of the most recent transform so that
 * watchCommand and scenarioCommand can re-run it without re-prompting,
 * and so aiCommands can build fix context from the last run.
 */
export interface LastTransformState {
    xmlPath: string;
    xmlContent: string;
    xsltPath: string;
    parameters: Record<string, string>;
    automations?: Record<string, string>;
    outputUri?: vscode.Uri;
    outputDestination: 'newTab' | 'saveFile';
}

let lastTransform: LastTransformState | undefined;

export function getLastTransform(): LastTransformState | undefined {
    return lastTransform;
}

export function setLastTransform(state: LastTransformState): void {
    lastTransform = state;
}
