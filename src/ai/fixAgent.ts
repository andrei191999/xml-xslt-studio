import * as vscode from 'vscode';
import * as fs from 'fs';
import { TracedIssue } from '../tracing/errorTraceMapper';
import { AiConfig, FixProposal, FixSession } from './types';
import { buildFixContext, buildMessages } from './contextBuilder';
import { callLlm } from './llmClient';
import { transformAndValidate, PipelineOptions } from '../pipeline/transformAndValidate';

// Content provider for the AI fix diff view
const fixContents = new Map<string, string>();

export class AiFixContentProvider implements vscode.TextDocumentContentProvider {
    private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
    readonly onDidChangeTextDocument = this._onDidChange.event;

    provideTextDocumentContent(uri: vscode.Uri): string {
        return fixContents.get(uri.toString()) ?? '';
    }

    update(uri: vscode.Uri, content: string): void {
        fixContents.set(uri.toString(), content);
        this._onDidChange.fire(uri);
    }
}

export async function fixSingleIssue(
    issue: TracedIssue,
    outputContent: string,
    inputXmlPath: string,
    config: AiConfig,
    apiKey: string,
    pipelineOptions: PipelineOptions,
    session?: FixSession
): Promise<boolean> {
    if (!issue.xsltSourceFile) {
        vscode.window.showWarningMessage(
            'Cannot fix this error: no XSLT source trace available. Run a transform first.'
        );
        return false;
    }

    if (!session) {
        session = { issue, attempts: [] };
    }

    const originalXslt = fs.readFileSync(issue.xsltSourceFile, 'utf8');

    for (let attempt = 0; attempt < config.maxRetries; attempt++) {
        // Build context and call LLM
        const context = buildFixContext(issue, outputContent, inputXmlPath);
        const messages = buildMessages(context, session);

        let response: string;
        try {
            const result = await callLlm({
                provider: config.provider,
                model: config.model,
                apiKey,
                messages,
            });
            response = result.content;
        } catch (err: any) {
            vscode.window.showErrorMessage(`AI request failed: ${err.message}`);
            return false;
        }

        // Parse the fix response
        const proposal = parseFixResponse(response, originalXslt);
        if (!proposal) {
            vscode.window.showErrorMessage(
                'AI response did not contain a valid fix. The response must include <fix>...</fix> tags.'
            );
            return false;
        }

        // Show diff and ask for confirmation
        const accepted = await showDiffAndConfirm(
            issue.xsltSourceFile,
            originalXslt,
            proposal
        );

        if (!accepted) {
            // User rejected — stop
            return false;
        }

        // Apply and verify
        const verification = await applyAndVerify(
            issue,
            proposal,
            originalXslt,
            pipelineOptions
        );

        if (verification.resolved) {
            vscode.window.showInformationMessage(
                `Fix applied successfully. Error "${issue.ruleId || issue.message.substring(0, 50)}" resolved.`
            );
            return true;
        }

        // Fix didn't work — revert and record attempt
        fs.writeFileSync(issue.xsltSourceFile, originalXslt, 'utf8');

        session.attempts.push({
            proposal,
            succeeded: false,
            newErrors: verification.remainingErrors,
        });

        if (attempt < config.maxRetries - 1) {
            const retry = await vscode.window.showWarningMessage(
                `Fix did not resolve the error (${verification.remainingErrors?.length ?? 0} errors remain). ` +
                `Retry ${attempt + 2}/${config.maxRetries}?`,
                'Retry', 'Cancel'
            );
            if (retry !== 'Retry') {
                return false;
            }
        }
    }

    vscode.window.showWarningMessage(
        `Could not resolve the error after ${config.maxRetries} attempts.`
    );
    return false;
}

export function parseFixResponse(response: string, originalXslt: string): FixProposal | null {
    // Match <fix explanation="...">...</fix> — the content is the full XSLT
    const match = response.match(/<fix\s+explanation="([^"]*)">([\s\S]*?)<\/fix>/);
    if (!match) {
        // Try without explanation attribute
        const simpleMatch = response.match(/<fix(?:\s[^>]*)?>([\s\S]*?)<\/fix>/);
        if (!simpleMatch) {
            return null;
        }
        const proposedContent = simpleMatch[1].trim();
        if (!isValidXslt(proposedContent)) {
            return null;
        }
        return {
            originalContent: originalXslt,
            proposedContent,
            explanation: 'AI-proposed fix',
        };
    }

    const explanation = match[1];
    const proposedContent = match[2].trim();

    if (!isValidXslt(proposedContent)) {
        return null;
    }

    return {
        originalContent: originalXslt,
        proposedContent,
        explanation,
    };
}

function isValidXslt(content: string): boolean {
    // Basic structural validation
    return content.includes('<xsl:stylesheet') || content.includes('<xsl:transform');
}

async function showDiffAndConfirm(
    xsltFilePath: string,
    originalContent: string,
    proposal: FixProposal
): Promise<boolean> {
    // Use virtual documents for the diff view
    const originalUri = vscode.Uri.parse(`ai-fix:original/${encodeURIComponent(xsltFilePath)}`);
    const proposedUri = vscode.Uri.parse(`ai-fix:proposed/${encodeURIComponent(xsltFilePath)}`);

    fixContents.set(originalUri.toString(), originalContent);
    fixContents.set(proposedUri.toString(), proposal.proposedContent);

    const fileName = xsltFilePath.split(/[\\/]/).pop() ?? 'stylesheet.xsl';

    await vscode.commands.executeCommand(
        'vscode.diff',
        originalUri,
        proposedUri,
        `AI Fix: ${fileName} — ${proposal.explanation}`,
        { preview: true }
    );

    const choice = await vscode.window.showInformationMessage(
        `AI Fix: ${proposal.explanation}`,
        { modal: false },
        'Accept', 'Reject'
    );

    // Close the diff editor
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');

    // Clean up virtual doc contents
    fixContents.delete(originalUri.toString());
    fixContents.delete(proposedUri.toString());

    return choice === 'Accept';
}

interface VerificationResult {
    resolved: boolean;
    remainingErrors?: string[];
}

async function applyAndVerify(
    issue: TracedIssue,
    proposal: FixProposal,
    originalXslt: string,
    pipelineOptions: PipelineOptions
): Promise<VerificationResult> {
    const xsltFilePath = issue.xsltSourceFile!;

    // Write the proposed fix
    fs.writeFileSync(xsltFilePath, proposal.proposedContent, 'utf8');

    try {
        // Re-run the pipeline
        const result = await transformAndValidate({
            ...pipelineOptions,
            xsltStylesheet: xsltFilePath,
            enableTracing: true,
        });

        if (!result.validationResult) {
            // Not UBL output anymore — that's a problem
            return {
                resolved: false,
                remainingErrors: ['Output is no longer recognized as UBL document'],
            };
        }

        const remainingIssues = result.validationResult.issues;

        // Check if the original error is resolved
        const originalStillPresent = remainingIssues.some(i => {
            if (issue.ruleId && i.ruleId) {
                return i.ruleId === issue.ruleId;
            }
            return i.message === issue.message;
        });

        if (!originalStillPresent) {
            return { resolved: true };
        }

        return {
            resolved: false,
            remainingErrors: remainingIssues.map(i =>
                `[${i.source}${i.ruleId ? '/' + i.ruleId : ''}] ${i.message}`
            ),
        };
    } catch (err: any) {
        // Transform or validation failed — revert
        return {
            resolved: false,
            remainingErrors: [`Pipeline error: ${err.message}`],
        };
    }
}
