import * as vscode from 'vscode';
import { TracedIssue } from '../tracing/errorTraceMapper';

export type AiProvider = 'anthropic' | 'openai' | 'gemini' | 'groq';

export interface AiConfig {
    provider: AiProvider;
    model: string;
    maxRetries: number;
}

export interface FixContext {
    error: {
        source: string;
        ruleId?: string;
        message: string;
        line: number;
    };
    xsltFilePath: string;
    xsltContent: string;
    relevantTemplate: string;
    inputXmlContent: string;
    outputXmlSnippet: string;
}

export interface FixProposal {
    originalContent: string;
    proposedContent: string;
    explanation: string;
}

export interface ConversationMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

export interface FixAttempt {
    proposal: FixProposal;
    succeeded: boolean;
    newErrors?: string[];
}

export interface FixSession {
    issue: TracedIssue;
    attempts: FixAttempt[];
}
