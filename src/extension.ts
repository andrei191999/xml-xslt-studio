import * as vscode from 'vscode';
import { createTransformCommand } from './commands/transformCommand';
import { createValidateCommand } from './commands/validateCommand';
import { MissingElementCodeActionProvider } from './analysis/codeActionProvider';
import { AiFixCodeActionProvider } from './ai/aiCodeActionProvider';
import { AiFixContentProvider, fixSingleIssue } from './ai/fixAgent';
import { getAiConfig, ensureApiKey, storeApiKey } from './ai/settingsManager';
import { getTracedIssue, getTracedIssues } from './validation/diagnosticsReporter';
import { checkJavaAvailable } from './utils/javaRunner';
import { AiProvider, AiConfig, FixSession } from './ai/types';
import { PipelineOptions } from './pipeline/transformAndValidate';

let diagnosticCollection: vscode.DiagnosticCollection;

// Track last transform options so AI fix can re-run the pipeline
let lastPipelineOptions: PipelineOptions | undefined;
let lastOutputContent: string | undefined;
let lastOutputUri: vscode.Uri | undefined;

export function setLastTransformContext(
    options: PipelineOptions,
    outputContent: string,
    outputUri: vscode.Uri
): void {
    lastPipelineOptions = options;
    lastOutputContent = outputContent;
    lastOutputUri = outputUri;
}

async function promptProviderAndKey(
    secrets: vscode.SecretStorage
): Promise<{ config: AiConfig; apiKey: string } | undefined> {
    const provider = await vscode.window.showQuickPick(
        [
            { label: 'Gemini', description: 'Free — Google Gemini 2.0 Flash', value: 'gemini' as AiProvider },
            { label: 'Groq', description: 'Free — Llama 3.3 70B', value: 'groq' as AiProvider },
            { label: 'Anthropic', description: 'Paid — Claude', value: 'anthropic' as AiProvider },
            { label: 'OpenAI', description: 'Paid — GPT-4o', value: 'openai' as AiProvider },
        ],
        { placeHolder: 'Select AI provider to fix the XSLT stylesheet' }
    );

    if (!provider) {
        return undefined;
    }

    const apiKey = await ensureApiKey(secrets, provider.value);
    if (!apiKey) {
        return undefined;
    }

    const baseConfig = getAiConfig();
    return {
        config: { ...baseConfig, provider: provider.value },
        apiKey,
    };
}

export function activate(context: vscode.ExtensionContext) {
    console.log('XSLT Transformer extension is now active');

    diagnosticCollection = vscode.languages.createDiagnosticCollection('ubl-validation');
    context.subscriptions.push(diagnosticCollection);

    context.subscriptions.push(
        vscode.commands.registerCommand('xml-xslt-studio.transform', createTransformCommand(context))
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(
            'xml-xslt-studio.validateUbl',
            createValidateCommand(context, 'full')
        )
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(
            'xml-xslt-studio.validateUblXsd',
            createValidateCommand(context, 'xsd-only')
        )
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(
            'xml-xslt-studio.validateUblBusinessRules',
            createValidateCommand(context, 'business-rules-only')
        )
    );

    // Code action provider for missing element Quick Fix suggestions
    context.subscriptions.push(
        vscode.languages.registerCodeActionsProvider(
            { language: 'xml', scheme: '*' },
            new MissingElementCodeActionProvider(),
            { providedCodeActionKinds: MissingElementCodeActionProvider.providedCodeActionKinds }
        )
    );

    // AI Fix code action provider
    context.subscriptions.push(
        vscode.languages.registerCodeActionsProvider(
            { language: 'xml', scheme: '*' },
            new AiFixCodeActionProvider(),
            { providedCodeActionKinds: AiFixCodeActionProvider.providedCodeActionKinds }
        )
    );

    // Register TextDocumentContentProvider for ai-fix: diff scheme
    const aiFixContentProvider = new AiFixContentProvider();
    context.subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider('ai-fix', aiFixContentProvider)
    );

    // Command: Fix single error with AI (from code action)
    context.subscriptions.push(
        vscode.commands.registerCommand(
            'xml-xslt-studio.aiFixSingle',
            async (diagnostic: vscode.Diagnostic) => {
                if (!lastPipelineOptions || !lastOutputContent || !lastOutputUri) {
                    vscode.window.showWarningMessage(
                        'No transform context available. Run an XSLT transform first, then use AI fix on the validation errors.'
                    );
                    return;
                }

                const tracedIssue = getTracedIssue(lastOutputUri, diagnostic);
                if (!tracedIssue) {
                    vscode.window.showWarningMessage(
                        'Cannot find trace data for this diagnostic. Run a transform with tracing enabled first.'
                    );
                    return;
                }

                const result = await promptProviderAndKey(context.secrets);
                if (!result) {
                    return;
                }

                await vscode.window.withProgress(
                    {
                        location: vscode.ProgressLocation.Notification,
                        title: 'AI Fix: Analyzing error...',
                        cancellable: false,
                    },
                    async () => {
                        await fixSingleIssue(
                            tracedIssue,
                            lastOutputContent!,
                            lastPipelineOptions!.sourceXml,
                            result.config,
                            result.apiKey,
                            lastPipelineOptions!
                        );
                    }
                );
            }
        )
    );

    // Command: Fix all errors with AI
    context.subscriptions.push(
        vscode.commands.registerCommand(
            'xml-xslt-studio.aiFixAll',
            async () => {
                if (!lastPipelineOptions || !lastOutputContent || !lastOutputUri) {
                    vscode.window.showWarningMessage(
                        'No transform context available. Run an XSLT transform first.'
                    );
                    return;
                }

                const tracedIssues = getTracedIssues(lastOutputUri);
                if (!tracedIssues || tracedIssues.length === 0) {
                    vscode.window.showInformationMessage('No validation errors to fix.');
                    return;
                }

                // Filter to only issues with XSLT source traces
                const fixable = tracedIssues.filter(i => i.xsltSourceFile);
                if (fixable.length === 0) {
                    vscode.window.showWarningMessage(
                        'No errors with XSLT source traces found. AI fix requires tracing data from a transform.'
                    );
                    return;
                }

                const result = await promptProviderAndKey(context.secrets);
                if (!result) {
                    return;
                }

                await vscode.window.withProgress(
                    {
                        location: vscode.ProgressLocation.Notification,
                        title: 'AI Fix: Processing errors...',
                        cancellable: true,
                    },
                    async (progress, token) => {
                        let fixed = 0;
                        for (let i = 0; i < fixable.length; i++) {
                            if (token.isCancellationRequested) {
                                break;
                            }

                            progress.report({
                                message: `Error ${i + 1}/${fixable.length}: ${fixable[i].ruleId || fixable[i].message.substring(0, 40)}...`,
                                increment: (1 / fixable.length) * 100,
                            });

                            const session: FixSession = { issue: fixable[i], attempts: [] };
                            const resolved = await fixSingleIssue(
                                fixable[i],
                                lastOutputContent!,
                                lastPipelineOptions!.sourceXml,
                                result.config,
                                result.apiKey,
                                lastPipelineOptions!,
                                session
                            );

                            if (resolved) {
                                fixed++;
                            }
                        }

                        vscode.window.showInformationMessage(
                            `AI Fix complete: ${fixed}/${fixable.length} errors resolved.`
                        );
                    }
                );
            }
        )
    );

    // Command: Set AI API key
    context.subscriptions.push(
        vscode.commands.registerCommand(
            'xml-xslt-studio.aiSetApiKey',
            async () => {
                const provider = await vscode.window.showQuickPick(
                    [
                        { label: 'Gemini', description: 'Free — Google Gemini', value: 'gemini' as AiProvider },
                        { label: 'Groq', description: 'Free — Groq Cloud', value: 'groq' as AiProvider },
                        { label: 'Anthropic', description: 'Paid — Anthropic', value: 'anthropic' as AiProvider },
                        { label: 'OpenAI', description: 'Paid — OpenAI', value: 'openai' as AiProvider },
                    ],
                    { placeHolder: 'Select AI provider' }
                );

                if (!provider) {
                    return;
                }

                const key = await vscode.window.showInputBox({
                    title: `Enter ${provider.label} API Key`,
                    prompt: 'Your API key is stored securely in VS Code\'s secret storage.',
                    password: true,
                    placeHolder: provider.value === 'anthropic' ? 'sk-ant-...' : 'sk-...',
                    ignoreFocusOut: true,
                });

                if (!key) {
                    return;
                }

                await storeApiKey(context.secrets, provider.value, key);
                vscode.window.showInformationMessage(`${provider.label} API key saved successfully.`);
            }
        )
    );

    // Non-blocking Java availability check on activation
    checkJavaAvailable().then(available => {
        if (!available) {
            vscode.window.showWarningMessage(
                'Java is not installed or not in PATH. XSLT transformation and Schematron validation require Java. ' +
                '[Install Java](https://adoptium.net/)',
                'Dismiss'
            );
        }
    });
}

export function getDiagnosticCollection(): vscode.DiagnosticCollection {
    return diagnosticCollection;
}

export function deactivate() {}
