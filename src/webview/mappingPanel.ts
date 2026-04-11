import * as vscode from 'vscode';
import { TraceEntry } from '../tracing/xsltTracer';
import { ValidationIssue } from '../validation/types';

interface MappingData {
    sourceXml: string;
    outputXml: string;
    traceEntries: TraceEntry[];
    validationIssues: ValidationIssue[];
}

export class MappingPanel {
    public static readonly viewType = 'xsltMapping';
    private static currentPanel: MappingPanel | undefined;

    private readonly panel: vscode.WebviewPanel;
    private disposables: vscode.Disposable[] = [];

    static createOrShow(
        extensionUri: vscode.Uri,
        data: MappingData
    ): MappingPanel {
        const column = vscode.ViewColumn.Beside;

        if (MappingPanel.currentPanel) {
            MappingPanel.currentPanel.update(data);
            MappingPanel.currentPanel.panel.reveal(column);
            return MappingPanel.currentPanel;
        }

        const panel = vscode.window.createWebviewPanel(
            MappingPanel.viewType,
            'XSLT Source-to-Output Mapping',
            column,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
            }
        );

        MappingPanel.currentPanel = new MappingPanel(panel, data);
        return MappingPanel.currentPanel;
    }

    private constructor(panel: vscode.WebviewPanel, data: MappingData) {
        this.panel = panel;
        this.update(data);

        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    }

    update(data: MappingData): void {
        this.panel.webview.html = this.getHtml(data);
    }

    dispose(): void {
        MappingPanel.currentPanel = undefined;
        this.panel.dispose();
        for (const d of this.disposables) {
            d.dispose();
        }
        this.disposables = [];
    }

    private getHtml(data: MappingData): string {
        const sourceLines = escapeHtml(data.sourceXml).split(/\r?\n/);
        const outputLines = escapeHtml(data.outputXml).split(/\r?\n/);

        // Build error line set for highlighting
        const errorLines = new Set<number>();
        for (const issue of data.validationIssues) {
            if (issue.severity === 0) { // Error
                errorLines.add(issue.line);
            }
        }

        // Build mapping connections from trace entries
        const connections = data.traceEntries.map(entry => ({
            outputLine: entry.outputLine,
            sourceLine: entry.sourceLine,
            pattern: entry.elementName,
        }));

        const sourceHtml = sourceLines.map((line, i) => {
            const lineNum = i + 1;
            return `<div class="line" data-line="${lineNum}"><span class="line-num">${lineNum}</span>${line || '&nbsp;'}</div>`;
        }).join('\n');

        const outputHtml = outputLines.map((line, i) => {
            const lineNum = i + 1;
            const errorClass = errorLines.has(lineNum) ? ' error-line' : '';
            return `<div class="line${errorClass}" data-line="${lineNum}"><span class="line-num">${lineNum}</span>${line || '&nbsp;'}</div>`;
        }).join('\n');

        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
    font-family: var(--vscode-editor-font-family, 'Consolas', monospace);
    font-size: var(--vscode-editor-font-size, 13px);
    background: var(--vscode-editor-background);
    color: var(--vscode-editor-foreground);
    display: flex;
    height: 100vh;
}
.pane {
    flex: 1;
    overflow: auto;
    padding: 8px;
    border-right: 1px solid var(--vscode-panel-border);
}
.pane:last-of-type { border-right: none; }
.pane-header {
    font-weight: bold;
    padding: 4px 8px;
    background: var(--vscode-titleBar-activeBackground);
    color: var(--vscode-titleBar-activeForeground);
    position: sticky;
    top: 0;
    z-index: 10;
}
.line {
    white-space: pre;
    padding: 0 4px;
    line-height: 1.5;
    cursor: pointer;
}
.line:hover {
    background: var(--vscode-list-hoverBackground);
}
.line.highlight {
    background: var(--vscode-editor-findMatchHighlightBackground, rgba(255,200,0,0.3));
}
.line.error-line {
    background: rgba(255, 0, 0, 0.15);
    border-left: 3px solid var(--vscode-editorError-foreground, red);
}
.line-num {
    display: inline-block;
    width: 40px;
    text-align: right;
    margin-right: 12px;
    color: var(--vscode-editorLineNumber-foreground);
    user-select: none;
}
svg.connections {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
    z-index: 5;
}
.container { display: flex; width: 100%; height: 100%; position: relative; }
#svg-overlay {
    position: fixed;
    top: 0;
    left: 50%;
    transform: translateX(-50%);
    width: 40px;
    height: 100%;
    pointer-events: none;
    z-index: 20;
}
svg line.connection {
    stroke: var(--vscode-editorLink-activeForeground, #4fc1ff);
    stroke-width: 1;
    opacity: 0.4;
}
svg line.connection.active {
    stroke-width: 2;
    opacity: 1;
}
</style>
</head>
<body>
<div class="container">
    <div class="pane" id="source-pane">
        <div class="pane-header">Source XML</div>
        <div id="source-content">${sourceHtml}</div>
    </div>
    <svg id="svg-overlay"></svg>
    <div class="pane" id="output-pane">
        <div class="pane-header">Transform Output</div>
        <div id="output-content">${outputHtml}</div>
    </div>
</div>
<script>
const connections = ${JSON.stringify(connections)};

// Click handlers for highlighting mapped regions
document.querySelectorAll('#output-pane .line').forEach(el => {
    el.addEventListener('click', () => {
        clearHighlights();
        const outputLine = parseInt(el.dataset.line);
        // Find the connection for this output line
        let best = null;
        for (const c of connections) {
            if (c.outputLine <= outputLine) {
                best = c;
            }
        }
        if (best) {
            el.classList.add('highlight');
            const sourceLine = document.querySelector('#source-pane .line[data-line="' + best.sourceLine + '"]');
            if (sourceLine) {
                sourceLine.classList.add('highlight');
                sourceLine.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
        }
    });
});

document.querySelectorAll('#source-pane .line').forEach(el => {
    el.addEventListener('click', () => {
        clearHighlights();
        const sourceLine = parseInt(el.dataset.line);
        el.classList.add('highlight');
        // Find output lines mapped from this source line
        for (const c of connections) {
            if (c.sourceLine === sourceLine) {
                const outputEl = document.querySelector('#output-pane .line[data-line="' + c.outputLine + '"]');
                if (outputEl) {
                    outputEl.classList.add('highlight');
                    outputEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }
            }
        }
    });
});

function clearHighlights() {
    document.querySelectorAll('.highlight').forEach(el => el.classList.remove('highlight'));
}
</script>
</body>
</html>`;
    }
}

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
