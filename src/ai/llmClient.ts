import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import { AiProvider, ConversationMessage } from './types';
import { execAsync } from '../utils/execAsync';

export interface LlmCallOptions {
    provider: AiProvider;
    model: string;
    apiKey: string;             // empty string for 'vertex' (ADC-based, no key needed)
    messages: ConversationMessage[];
    vertexProject?: string;     // required for 'vertex'
    vertexRegion?: string;      // required for 'vertex'
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
        case 'vertex':
            return callAnthropicVertex(
                model || 'claude-sonnet-4-6',
                messages,
                options.vertexProject ?? '',
                options.vertexRegion ?? 'us-east5'
            );
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

async function callAnthropicVertex(
    model: string,
    messages: ConversationMessage[],
    project: string,
    region: string
): Promise<LlmResponse> {
    // Step 1: Get GCP access token via ADC, falling back to gcloud CLI
    let accessToken: string;

    try {
        const adcPath = process.platform === 'win32'
            ? path.join(process.env['APPDATA'] ?? '', 'gcloud', 'application_default_credentials.json')
            : path.join(process.env['HOME'] ?? '', '.config', 'gcloud', 'application_default_credentials.json');

        const adcRaw = fs.readFileSync(adcPath, 'utf8');
        const adc = JSON.parse(adcRaw);

        if (adc.type !== 'authorized_user') {
            throw new Error(`Unsupported ADC type: ${adc.type}`);
        }

        // Token refresh using URL-form-encoded body (NOT JSON)
        const formBody = [
            'grant_type=refresh_token',
            `client_id=${encodeURIComponent(adc.client_id)}`,
            `client_secret=${encodeURIComponent(adc.client_secret)}`,
            `refresh_token=${encodeURIComponent(adc.refresh_token)}`,
        ].join('&');

        const tokenResponse = await new Promise<any>((resolve, reject) => {
            const req = https.request(
                {
                    hostname: 'oauth2.googleapis.com',
                    port: 443,
                    path: '/token',
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'Content-Length': Buffer.byteLength(formBody),
                    },
                },
                (res) => {
                    const chunks: Buffer[] = [];
                    res.on('data', (chunk: Buffer) => chunks.push(chunk));
                    res.on('end', () => {
                        try {
                            const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                                resolve(data);
                            } else {
                                reject(new Error(`Token refresh failed (${res.statusCode}): ${data.error_description || data.error}`));
                            }
                        } catch (e: any) {
                            reject(new Error(`Failed to parse token response: ${e.message}`));
                        }
                    });
                }
            );
            req.on('error', (e) => reject(new Error(`Network error during token refresh: ${e.message}`)));
            req.write(formBody);
            req.end();
        });

        if (!tokenResponse.access_token) {
            throw new Error('No access_token in token refresh response');
        }
        accessToken = tokenResponse.access_token;
    } catch (adcError) {
        // Log ADC failure for debugging — user will see gcloud CLI error if that also fails
        console.error('[xmlXslt vertex] ADC token refresh failed:', adcError instanceof Error ? adcError.message : String(adcError));
        // fall through to gcloud CLI fallback
        // Fallback: use gcloud CLI (execAsync uses execFile — no shell injection risk)
        try {
            const { stdout } = await execAsync('gcloud', ['auth', 'print-access-token']);
            accessToken = stdout.trim();
            if (!accessToken) {
                throw new Error('gcloud returned empty access token');
            }
        } catch (cliError: any) {
            throw new Error(
                `Failed to obtain GCP access token via ADC and gcloud CLI. ` +
                `Run "gcloud auth application-default login" and try again. ` +
                `CLI error: ${cliError.message}`
            );
        }
    }

    // Step 2: Determine endpoint URL
    let baseUrl: string;
    if (region === 'global') {
        baseUrl = 'https://aiplatform.googleapis.com/v1';
    } else if (region === 'us') {
        baseUrl = 'https://aiplatform.us.rep.googleapis.com/v1';
    } else {
        baseUrl = `https://${region}-aiplatform.googleapis.com/v1`;
    }
    const hostname = new URL(baseUrl).hostname;
    const urlPath = `/v1/projects/${project}/locations/${region}/publishers/anthropic/models/${model}:rawPredict`;

    // Step 3: Build request body (Anthropic Messages API format for Vertex)
    // NOTE: 'model' is NOT included in the body — it is encoded in the URL
    // NOTE: 'anthropic_version' goes in the body (underscore), NOT as a header
    const systemMessages = messages.filter(m => m.role === 'system');
    const nonSystemMessages = messages.filter(m => m.role !== 'system');

    const body = JSON.stringify({
        anthropic_version: 'vertex-2023-10-16',
        max_tokens: 16384,
        system: systemMessages.map(m => m.content).join('\n\n'),
        messages: nonSystemMessages.map(m => ({ role: m.role, content: m.content })),
    });

    // Step 4: POST using httpPost helper
    return httpPost({
        hostname,
        path: urlPath,
        headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
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
