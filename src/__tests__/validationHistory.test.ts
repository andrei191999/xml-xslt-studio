jest.mock('vscode');

import type * as vscode from 'vscode';

import { getHistory, pushHistoryEntry, VALIDATION_HISTORY_KEY, type HistoryEntry } from '../state/validationHistory';

function makeEntry(timestamp: number, overrides: Partial<HistoryEntry> = {}): HistoryEntry {
    return {
        timestamp,
        xmlPath: `C:/tmp/input-${timestamp}.xml`,
        issueCount: 3,
        errorCount: 1,
        warningCount: 1,
        infoCount: 1,
        ...overrides,
    };
}

function makeContext(initialValue?: unknown): vscode.ExtensionContext {
    let stored = initialValue;

    return {
        workspaceState: {
            get: jest.fn((key: string) => key === VALIDATION_HISTORY_KEY ? stored : undefined),
            update: jest.fn(async (key: string, value: unknown) => {
                if (key === VALIDATION_HISTORY_KEY) {
                    stored = value;
                }
            }),
        },
    } as unknown as vscode.ExtensionContext;
}

describe('validationHistory', () => {
    it('sanitizes persisted entries by rebuilding valid fields and dropping invalid optional values', () => {
        const ctx = makeContext([{
            timestamp: 3000,
            xmlPath: 'C:/tmp/input-3000.xml',
            xsltPath: 123,
            outputUri: 'untitled:Validation Report',
            detectedProfile: { bad: true },
            issueCount: 3,
            errorCount: 1,
            warningCount: 1,
            infoCount: 1,
            extra: 'ignored',
        }]);

        expect(getHistory(ctx)).toEqual([{
            timestamp: 3000,
            xmlPath: 'C:/tmp/input-3000.xml',
            outputUri: 'untitled:Validation Report',
            issueCount: 3,
            errorCount: 1,
            warningCount: 1,
            infoCount: 1,
        }]);
    });

    it('normalizes persisted history on read to newest-first and capped at 10 entries', () => {
        const stored = [
            makeEntry(1000),
            makeEntry(5000),
            makeEntry(3000),
            makeEntry(12000),
            makeEntry(4000),
            makeEntry(11000),
            makeEntry(7000),
            makeEntry(6000),
            makeEntry(10000),
            makeEntry(9000),
            makeEntry(8000),
            makeEntry(2000),
        ];
        const ctx = makeContext(stored);

        expect(getHistory(ctx).map(entry => entry.timestamp)).toEqual([
            12000, 11000, 10000, 9000, 8000, 7000, 6000, 5000, 4000, 3000,
        ]);
    });

    it('drops entries with non-finite or negative required numeric fields', () => {
        const ctx = makeContext([
            makeEntry(1000),
            makeEntry(-1),
            makeEntry(2000, { issueCount: Number.POSITIVE_INFINITY }),
            makeEntry(3000, { errorCount: -1 }),
            makeEntry(4000, { warningCount: Number.NaN }),
            makeEntry(5000, { infoCount: -1 }),
        ]);

        expect(getHistory(ctx)).toEqual([makeEntry(1000)]);
    });

    it('returns history newest-first after pushing a new entry', async () => {
        const older = makeEntry(1000);
        const newest = makeEntry(2000);
        const ctx = makeContext([older]);

        const next = await pushHistoryEntry(ctx, newest);

        expect(next).toEqual([newest, older]);
        expect(getHistory(ctx)).toEqual([newest, older]);
    });

    it('caps history at 10 entries', async () => {
        const existing = Array.from({ length: 10 }, (_, index) => makeEntry(1000 - index));
        const latest = makeEntry(2000);
        const ctx = makeContext(existing);

        const next = await pushHistoryEntry(ctx, latest);

        expect(next).toHaveLength(10);
        expect(next[0]).toEqual(latest);
        expect(next).not.toContainEqual(existing[9]);
    });

    it('pushes onto normalized persisted history before capping', async () => {
        const stale = [
            makeEntry(1000),
            makeEntry(5000),
            makeEntry(3000),
            makeEntry(12000),
            makeEntry(4000),
            makeEntry(11000),
            makeEntry(7000),
            makeEntry(6000),
            makeEntry(10000),
            makeEntry(9000),
            makeEntry(8000),
            makeEntry(2000),
        ];
        const latest = makeEntry(13000);
        const ctx = makeContext(stale);

        const next = await pushHistoryEntry(ctx, latest);

        expect(next.map(entry => entry.timestamp)).toEqual([
            13000, 12000, 11000, 10000, 9000, 8000, 7000, 6000, 5000, 4000,
        ]);
    });

    it('recovers from malformed stored state', () => {
        const ctx = makeContext([
            makeEntry(1000),
            { timestamp: 'bad', xmlPath: 'C:/tmp/bad.xml' },
            null,
            { xmlPath: 'C:/tmp/missing-timestamp.xml', issueCount: 1, errorCount: 0, warningCount: 0, infoCount: 1 },
        ]);

        expect(getHistory(ctx)).toEqual([makeEntry(1000)]);
    });

    it('preserves optional fields on stored entries', async () => {
        const entry = makeEntry(3000, {
            xsltPath: 'C:/tmp/template.xslt',
            outputUri: 'untitled:Validation Report',
            detectedProfile: 'eu.peppol.bis3.ubl.invoice:2025.11.0',
        });
        const ctx = makeContext();

        const next = await pushHistoryEntry(ctx, entry);

        expect(next[0]).toEqual(entry);
        expect(getHistory(ctx)[0]).toEqual(entry);
    });
});
