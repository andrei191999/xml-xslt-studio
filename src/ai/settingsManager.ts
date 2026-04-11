import * as vscode from 'vscode';
import { AiConfig, AiProvider } from './types';

const SECRET_KEY_PREFIX = 'ublValidator.ai.apiKey.';

export function getAiConfig(): AiConfig {
    const cfg = vscode.workspace.getConfiguration('ublValidator.ai');
    return {
        provider: cfg.get<AiProvider>('provider', 'anthropic'),
        model: cfg.get<string>('model', ''),
        maxRetries: cfg.get<number>('maxRetries', 3),
    };
}

export async function storeApiKey(
    secrets: vscode.SecretStorage,
    provider: AiProvider,
    key: string
): Promise<void> {
    await secrets.store(`${SECRET_KEY_PREFIX}${provider}`, key);
}

export async function getApiKey(
    secrets: vscode.SecretStorage,
    provider: AiProvider
): Promise<string | undefined> {
    return secrets.get(`${SECRET_KEY_PREFIX}${provider}`);
}

export async function ensureApiKey(
    secrets: vscode.SecretStorage,
    provider: AiProvider
): Promise<string | undefined> {
    const existing = await getApiKey(secrets, provider);
    if (existing) {
        return existing;
    }

    const providerLabels: Record<AiProvider, { name: string; placeholder: string }> = {
        anthropic: { name: 'Anthropic', placeholder: 'sk-ant-...' },
        openai: { name: 'OpenAI', placeholder: 'sk-...' },
        gemini: { name: 'Google Gemini', placeholder: 'AIza...' },
        groq: { name: 'Groq', placeholder: 'gsk_...' },
    };
    const info = providerLabels[provider];

    const key = await vscode.window.showInputBox({
        title: `Enter ${info.name} API Key`,
        prompt: `Your API key is stored securely in VS Code's secret storage and never saved in plain text.`,
        password: true,
        placeHolder: info.placeholder,
        ignoreFocusOut: true,
    });

    if (!key) {
        return undefined;
    }

    await storeApiKey(secrets, provider, key);
    return key;
}
