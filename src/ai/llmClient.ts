import * as https from 'https';
import { AiProvider, ConversationMessage } from './types';

export interface LlmCallOptions {
    provider: AiProvider;
    model: string;
    apiKey: string;
    messages: ConversationMessage[];
}

export interface LlmResponse {
    content: string;
    inputTokens: number;
    outputTokens: number;
}

export async function callLlm(options: LlmCallOptions): Promise<LlmResponse> {
    const { provider, model, apiKey, messages } = options;

    switch (provider) {
        case 'anthropic':
            return callAnthropic(apiKey, model || 'claude-sonnet-4-20250514', messages);
        case 'openai':
            return callOpenAiCompatible(apiKey, model || 'gpt-4o', messages, 'api.openai.com', '/v1/chat/completions');
        case 'gemini':
            return callOpenAiCompatible(apiKey, model || 'gemini-2.0-flash', messages, 'generativelanguage.googleapis.com', '/v1beta/openai/chat/completions');
        case 'groq':
            return callOpenAiCompatible(apiKey, model || 'llama-3.3-70b-versatile', messages, 'api.groq.com', '/openai/v1/chat/completions');
    }
}

function callAnthropic(apiKey: string, model: string, messages: ConversationMessage[]): Promise<LlmResponse> {
    const systemMessages = messages.filter(m => m.role === 'system');
    const nonSystemMessages = messages.filter(m => m.role !== 'system');

    const body = JSON.stringify({
        model,
        max_tokens: 16384,
        system: systemMessages.map(m => m.content).join('\n\n'),
        messages: nonSystemMessages.map(m => ({ role: m.role, content: m.content })),
    });

    return httpPost({
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
        },
        body,
        parseResponse(data: any): LlmResponse {
            const content = data.content
                ?.filter((b: any) => b.type === 'text')
                .map((b: any) => b.text)
                .join('') ?? '';
            return {
                content,
                inputTokens: data.usage?.input_tokens ?? 0,
                outputTokens: data.usage?.output_tokens ?? 0,
            };
        },
    });
}

function callOpenAiCompatible(
    apiKey: string,
    model: string,
    messages: ConversationMessage[],
    hostname: string,
    path: string
): Promise<LlmResponse> {
    const body = JSON.stringify({
        model,
        messages: messages.map(m => ({ role: m.role, content: m.content })),
        max_tokens: 16384,
    });

    return httpPost({
        hostname,
        path,
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
        },
        body,
        parseResponse(data: any): LlmResponse {
            const content = data.choices?.[0]?.message?.content ?? '';
            return {
                content,
                inputTokens: data.usage?.prompt_tokens ?? 0,
                outputTokens: data.usage?.completion_tokens ?? 0,
            };
        },
    });
}

interface HttpPostOptions {
    hostname: string;
    path: string;
    headers: Record<string, string>;
    body: string;
    parseResponse: (data: any) => LlmResponse;
}

function httpPost(options: HttpPostOptions): Promise<LlmResponse> {
    return new Promise((resolve, reject) => {
        const req = https.request(
            {
                hostname: options.hostname,
                port: 443,
                path: options.path,
                method: 'POST',
                headers: {
                    ...options.headers,
                    'Content-Length': Buffer.byteLength(options.body),
                },
            },
            (res) => {
                const chunks: Buffer[] = [];
                res.on('data', (chunk: Buffer) => chunks.push(chunk));
                res.on('end', () => {
                    const raw = Buffer.concat(chunks).toString('utf8');
                    const statusCode = res.statusCode ?? 0;

                    if (statusCode === 401 || statusCode === 403) {
                        reject(new Error(
                            'Invalid API key. Please update your key via "UBL: Set AI API Key" command.'
                        ));
                        return;
                    }

                    if (statusCode < 200 || statusCode >= 300) {
                        let detail = raw;
                        try {
                            const parsed = JSON.parse(raw);
                            detail = parsed.error?.message || parsed.message || raw;
                        } catch { /* use raw */ }
                        reject(new Error(`API error (${statusCode}): ${detail}`));
                        return;
                    }

                    try {
                        const data = JSON.parse(raw);
                        resolve(options.parseResponse(data));
                    } catch (e: any) {
                        reject(new Error(`Failed to parse API response: ${e.message}`));
                    }
                });
            }
        );

        req.on('error', (e) => reject(new Error(`Network error: ${e.message}`)));
        req.write(options.body);
        req.end();
    });
}
