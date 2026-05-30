import type * as vscode from 'vscode';

export const VALIDATION_HISTORY_KEY = 'xmlXslt.validationHistory';
const MAX_HISTORY = 10;

export interface HistoryEntry {
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

function isFiniteNonNegativeNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function sanitizeEntry(entry: unknown): HistoryEntry | null {
    if (typeof entry !== 'object' || entry === null) {
        return null;
    }

    const candidate = entry as Record<string, unknown>;
    if (!isFiniteNonNegativeNumber(candidate.timestamp)
        || typeof candidate.xmlPath !== 'string'
        || !isFiniteNonNegativeNumber(candidate.issueCount)
        || !isFiniteNonNegativeNumber(candidate.errorCount)
        || !isFiniteNonNegativeNumber(candidate.warningCount)
        || !isFiniteNonNegativeNumber(candidate.infoCount)) {
        return null;
    }

    const sanitized: HistoryEntry = {
        timestamp: candidate.timestamp,
        xmlPath: candidate.xmlPath,
        issueCount: candidate.issueCount,
        errorCount: candidate.errorCount,
        warningCount: candidate.warningCount,
        infoCount: candidate.infoCount,
    };

    if (typeof candidate.xsltPath === 'string') {
        sanitized.xsltPath = candidate.xsltPath;
    }
    if (typeof candidate.outputUri === 'string') {
        sanitized.outputUri = candidate.outputUri;
    }
    if (typeof candidate.detectedProfile === 'string') {
        sanitized.detectedProfile = candidate.detectedProfile;
    }

    return sanitized;
}

function sanitizeHistory(value: unknown): HistoryEntry[] {
    if (!Array.isArray(value)) {
        return [];
    }

    return value
        .map(sanitizeEntry)
        .filter((entry): entry is HistoryEntry => entry !== null);
}

function normalizeHistory(entries: HistoryEntry[]): HistoryEntry[] {
    return [...entries]
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, MAX_HISTORY);
}

export function getHistory(ctx: vscode.ExtensionContext): HistoryEntry[] {
    return normalizeHistory(sanitizeHistory(ctx.workspaceState.get(VALIDATION_HISTORY_KEY)));
}

export async function pushHistoryEntry(ctx: vscode.ExtensionContext, entry: HistoryEntry): Promise<HistoryEntry[]> {
    const next = normalizeHistory([entry, ...getHistory(ctx)]);
    await ctx.workspaceState.update(VALIDATION_HISTORY_KEY, next);
    return next;
}
