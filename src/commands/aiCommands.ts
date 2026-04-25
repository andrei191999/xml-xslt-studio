import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { callLlm } from '../ai/llmClient';
import { ConversationMessage } from '../ai/types';
import { getLastTransform } from '../state/lastTransform';
import { getConfig } from '../config/settings';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function resolveApiKey(
    context: vscode.ExtensionContext,
    provider: string
): Promise<string | undefined> {
    const key = await context.secrets.get(`xmlXslt.ai.apiKey.${provider}`);
    return key;
}

function parseFixResponse(response: string): { proposedContent: string; explanation: string } | null {
    const match = response.match(/<fix(?:\s+explanation="([^"]*)")?>([\s\S]*?)<\/fix>/);  // lazy: stop at first </fix>
    if (!match) {
        return null;
    }
    return {
        explanation: match[1] ?? 'AI-proposed fix',
        proposedContent: match[2].trim(),
    };
}

// ---------------------------------------------------------------------------
// createFixAllErrorsCommand
// ---------------------------------------------------------------------------

export function createFixAllErrorsCommand(
    context: vscode.ExtensionContext,
    local: vscode.DiagnosticCollection,
    helger: vscode.DiagnosticCollection,
): () => Promise<void> {
    return async () => {
        const state = getLastTransform();
        if (!state) {
            vscode.window.showErrorMessage('Run a transform first.');
            return;
        }

        if (!state.outputUri) {
            vscode.window.showErrorMessage('No output URI available. Run a transform first.');
            return;
        }

        // Collect from the transform output URI. Also fall back to the active editor URI
        // so that diagnostics from validate-only commands (which report against the source
        // XML URI, not an untitled output URI) are included when the user runs Fix All after
        // a validate-only run.
        const activeUri = vscode.window.activeTextEditor?.document.uri;
        const outputUriStr = state.outputUri?.toString();
        const localDiags = [
            ...(local.get(state.outputUri) ?? []),
            ...(activeUri && activeUri.toString() !== outputUriStr ? (local.get(activeUri) ?? []) : []),
        ];
        const helgerDiags = [
            ...(helger.get(state.outputUri) ?? []),
            ...(activeUri && activeUri.toString() !== outputUriStr ? (helger.get(activeUri) ?? []) : []),
        ];
        const allDiags = [...localDiags, ...helgerDiags];

        if (allDiags.length === 0) {
            vscode.window.showInformationMessage('No validation errors to fix.');
            return;
        }

        const config = getConfig();

        let apiKey = '';
        if (config.ai.provider !== 'vertex') {
            const key = await resolveApiKey(context, config.ai.provider);
            if (!key) {
                vscode.window.showErrorMessage(
                    `No API key set for ${config.ai.provider}. Use "XSLT: Set AI API Key" command.`
                );
                return;
            }
            apiKey = key;
        }

        let xsltContent: string;
        try {
            xsltContent = fs.readFileSync(state.xsltPath, 'utf8');
        } catch (err: any) {
            vscode.window.showErrorMessage(`Failed to read XSLT file: ${err.message}`);
            return;
        }

        const errorSummary = allDiags.map((d, i) =>
            `${i + 1}. [${d.source ?? 'unknown'}] Line ${d.range.start.line + 1}: ${d.message}`
        ).join('\n');

        const messages: ConversationMessage[] = [
            {
                role: 'system',
                content: 'You are an XSLT repair agent. Fix all the specified validation errors in the XSLT stylesheet. Return the corrected XSLT wrapped in <fix explanation="...">...</fix> tags. Make minimal changes to resolve the errors.',
            },
            {
                role: 'user',
                content: [
                    '## Validation Errors',
                    errorSummary,
                    '',
                    '## Input XML',
                    '```xml',
                    state.xmlContent,
                    '```',
                    '',
                    '## XSLT Stylesheet',
                    '```xml',
                    xsltContent,
                    '```',
                ].join('\n'),
            },
        ];

        const maxRetries = config.ai.maxRetries;
        try {
            const parsed = await vscode.window.withProgress(
                { title: 'AI Fix: analyzing errors...', location: vscode.ProgressLocation.Notification },
                async (progress) => {
                    let lastErr: unknown;
                    for (let attempt = 1; attempt <= maxRetries; attempt++) {
                        try {
                            if (attempt > 1) {
                                progress.report({ message: `Retry ${attempt}/${maxRetries}...` });
                            }
                            const response = await callLlm({
                                provider: config.ai.provider,
                                model: config.ai.model,
                                apiKey,
                                messages,
                                vertexProject: config.ai.vertexProject,
                                vertexRegion: config.ai.vertexRegion,
                            });
                            return parseFixResponse(response.content);
                        } catch (err) {
                            lastErr = err;
                        }
                    }
                    const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
                    throw new Error(msg);
                }
            );

            if (!parsed) {
                vscode.window.showErrorMessage('AI response did not contain a fix.');
                return;
            }

            if (!parsed.proposedContent.trim()) {
                vscode.window.showErrorMessage('AI returned an empty fix — no changes applied.');
                return;
            }

            const xsltUri = vscode.Uri.file(state.xsltPath);
            const xsltDoc = await vscode.workspace.openTextDocument(xsltUri);
            const lastLine = xsltDoc.lineAt(xsltDoc.lineCount - 1);
            const fullRange = new vscode.Range(0, 0, lastLine.lineNumber, lastLine.text.length);
            const edit = new vscode.WorkspaceEdit();
            edit.replace(xsltUri, fullRange, parsed.proposedContent);
            await vscode.workspace.applyEdit(edit);
            await vscode.window.showTextDocument(xsltDoc);
            vscode.window.showInformationMessage(
                `AI fix applied to ${path.basename(state.xsltPath)}: ${parsed.explanation}`
            );
        } catch (err: any) {
            vscode.window.showErrorMessage(`AI fix failed: ${err.message}`);
        }
    };
}

// ---------------------------------------------------------------------------
// createSetApiKeyCommand
// ---------------------------------------------------------------------------

export function createSetApiKeyCommand(
    context: vscode.ExtensionContext,
): () => Promise<void> {
    return async () => {
        const config = getConfig();

        if (config.ai.provider === 'vertex') {
            vscode.window.showInformationMessage(
                'Vertex AI uses Application Default Credentials — no API key required.'
            );
            return;
        }

        const key = await vscode.window.showInputBox({
            prompt: `Enter API key for ${config.ai.provider}`,
            password: true,
            placeHolder: 'sk-...',
        });

        if (!key) {
            return;
        }

        await context.secrets.store(`xmlXslt.ai.apiKey.${config.ai.provider}`, key);
        vscode.window.showInformationMessage(`API key saved for ${config.ai.provider}`);
    };
}

// ---------------------------------------------------------------------------
// createFixThisErrorCommand
// ---------------------------------------------------------------------------

export function createFixThisErrorCommand(
    context: vscode.ExtensionContext,
): (diagnostic: vscode.Diagnostic) => Promise<void> {
    return async (diagnostic: vscode.Diagnostic) => {
        const state = getLastTransform();
        if (!state) {
            vscode.window.showErrorMessage('Run a transform first.');
            return;
        }

        const config = getConfig();

        let apiKey = '';
        if (config.ai.provider !== 'vertex') {
            const key = await resolveApiKey(context, config.ai.provider);
            if (!key) {
                vscode.window.showErrorMessage(
                    `No API key set for ${config.ai.provider}. Use "XSLT: Set AI API Key" command.`
                );
                return;
            }
            apiKey = key;
        }

        let xsltContent: string;
        try {
            xsltContent = fs.readFileSync(state.xsltPath, 'utf8');
        } catch (err: any) {
            vscode.window.showErrorMessage(`Failed to read XSLT file: ${err.message}`);
            return;
        }

        const messages: ConversationMessage[] = [
            {
                role: 'system',
                content: 'You are an XSLT repair agent. Fix the specified validation error in the XSLT stylesheet. Return the corrected XSLT wrapped in <fix explanation="...">...</fix> tags.',
            },
            {
                role: 'user',
                content: [
                    '## Validation Error',
                    `- Source: ${diagnostic.source ?? 'unknown'}`,
                    `- Message: ${diagnostic.message}`,
                    `- Line: ${diagnostic.range.start.line + 1}`,
                    '',
                    '## XSLT Stylesheet',
                    '```xml',
                    xsltContent,
                    '```',
                ].join('\n'),
            },
        ];

        const maxRetries = config.ai.maxRetries;
        try {
            const parsed = await vscode.window.withProgress(
                { title: 'AI Fix: analyzing error...', location: vscode.ProgressLocation.Notification },
                async (progress) => {
                    let lastErr: unknown;
                    for (let attempt = 1; attempt <= maxRetries; attempt++) {
                        try {
                            if (attempt > 1) {
                                progress.report({ message: `Retry ${attempt}/${maxRetries}...` });
                            }
                            const response = await callLlm({
                                provider: config.ai.provider,
                                model: config.ai.model,
                                apiKey,
                                messages,
                                vertexProject: config.ai.vertexProject,
                                vertexRegion: config.ai.vertexRegion,
                            });
                            return parseFixResponse(response.content);
                        } catch (err) {
                            lastErr = err;
                        }
                    }
                    const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
                    throw new Error(msg);
                }
            );

            if (!parsed) {
                vscode.window.showErrorMessage('AI response did not contain a fix.');
                return;
            }

            if (!parsed.proposedContent.trim()) {
                vscode.window.showErrorMessage('AI returned an empty fix — no changes applied.');
                return;
            }

            const xsltUri = vscode.Uri.file(state.xsltPath);
            const xsltDoc = await vscode.workspace.openTextDocument(xsltUri);
            const lastLine = xsltDoc.lineAt(xsltDoc.lineCount - 1);
            const fullRange = new vscode.Range(0, 0, lastLine.lineNumber, lastLine.text.length);
            const edit = new vscode.WorkspaceEdit();
            edit.replace(xsltUri, fullRange, parsed.proposedContent);
            await vscode.workspace.applyEdit(edit);
            await vscode.window.showTextDocument(xsltDoc);
            vscode.window.showInformationMessage(
                `AI fix applied to ${path.basename(state.xsltPath)}: ${parsed.explanation}`
            );
        } catch (err: any) {
            vscode.window.showErrorMessage(`AI fix failed: ${err.message}`);
        }
    };
}
