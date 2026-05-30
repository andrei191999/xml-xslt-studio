jest.mock('vscode');

import * as vscode from 'vscode';

import { PanelManager } from '../webview/panelManager';
import type { HostMessage } from '../webview/types';

function makePanel() {
    let onMessage: ((msg: unknown) => void) | undefined;
    let onDispose: (() => void) | undefined;
    const postMessage = jest.fn();

    const panel = {
        visible: true,
        viewColumn: vscode.ViewColumn.Beside,
        reveal: jest.fn(),
        dispose: jest.fn(() => { onDispose?.(); }),
        onDidDispose: jest.fn((handler: () => void) => {
            onDispose = handler;
            return { dispose: jest.fn() };
        }),
        webview: {
            html: '',
            asWebviewUri: jest.fn((uri: vscode.Uri) => uri),
            postMessage,
            onDidReceiveMessage: jest.fn((handler: (msg: unknown) => void) => {
                onMessage = handler;
                return { dispose: jest.fn() };
            }),
        },
    };

    return {
        panel,
        postMessage,
        receive: (msg: unknown) => onMessage?.(msg),
    };
}

describe('PanelManager', () => {
    beforeEach(() => {
        PanelManager.dispose();
        jest.clearAllMocks();
    });

    afterEach(() => {
        PanelManager.dispose();
    });

    it('buffers host messages for a fresh panel until READY arrives, then flushes them in order', () => {
        const created = makePanel();
        (vscode.window.createWebviewPanel as jest.Mock).mockReturnValue(created.panel);

        const handled: unknown[] = [];
        PanelManager.onMessage((msg) => {
            handled.push(msg);
        });

        PanelManager.createOrShow(vscode.Uri.file('C:/ext'), {} as vscode.ExtensionContext);

        const first: HostMessage = {
            type: 'VALIDATION_RESULT',
            errorCount: 1,
            warningCount: 0,
            infoCount: 0,
            issues: [],
            ruleResults: [],
        };
        const second: HostMessage = {
            type: 'VALIDATION_HISTORY',
            history: [],
        };

        PanelManager.postMessage(first);
        PanelManager.postMessage(second);

        expect(created.postMessage).not.toHaveBeenCalled();

        created.receive({ type: 'READY' });

        expect(handled).toEqual([{ type: 'READY' }]);
        expect(created.postMessage).toHaveBeenNthCalledWith(1, first);
        expect(created.postMessage).toHaveBeenNthCalledWith(2, second);
    });

    it('drops queued messages when a panel is disposed before READY and does not leak them into a later panel', () => {
        const firstPanel = makePanel();
        const secondPanel = makePanel();
        (vscode.window.createWebviewPanel as jest.Mock)
            .mockReturnValueOnce(firstPanel.panel)
            .mockReturnValueOnce(secondPanel.panel);

        PanelManager.createOrShow(vscode.Uri.file('C:/ext'), {} as vscode.ExtensionContext);
        PanelManager.postMessage({
            type: 'VALIDATION_RESULT',
            errorCount: 0,
            warningCount: 0,
            infoCount: 1,
            issues: [],
            ruleResults: [],
            exportAvailable: false,
        });

        expect(firstPanel.postMessage).not.toHaveBeenCalled();

        PanelManager.dispose();

        PanelManager.createOrShow(vscode.Uri.file('C:/ext'), {} as vscode.ExtensionContext);
        secondPanel.receive({ type: 'READY' });

        expect(secondPanel.postMessage).not.toHaveBeenCalled();
    });

    it('renders results markup with separate export actions and display-only details sections', () => {
        const created = makePanel();
        (vscode.window.createWebviewPanel as jest.Mock).mockReturnValue(created.panel);

        PanelManager.createOrShow(vscode.Uri.file('C:/ext'), {} as vscode.ExtensionContext);

        expect(created.panel.webview.html).toContain('id="results-actions"');
        expect(created.panel.webview.html).toContain('id="btn-export-report" class="btn-export-report"');
        expect(created.panel.webview.html.indexOf('id="btn-revalidate"')).toBeLessThan(
            created.panel.webview.html.indexOf('id="results-helger"'),
        );
        expect(created.panel.webview.html).toContain('<details class="results-details" id="rules-details"');
        expect(created.panel.webview.html).toContain('<summary>Active Rules</summary>');
        expect(created.panel.webview.html).toContain('<details class="results-details" id="history-details">');
        expect(created.panel.webview.html).toContain('<summary>Validation History</summary>');
        expect(created.panel.webview.html).toContain('id="history-table-container"');
        expect(created.panel.webview.html).not.toContain('id="history-details" open');
        expect(created.panel.webview.html).not.toContain('data-history-action');
        expect(created.panel.webview.html).not.toContain('history-rerun');
    });
});
