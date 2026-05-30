import * as vscode from 'vscode';
import type { HostMessage, WebviewMessage, ValidationProfile } from './types';

/**
 * PanelManager — host-side singleton webview panel lifecycle.
 *
 * Single panel instance pattern:
 *  - createOrShow() creates panel on first call, or reveals existing
 *  - dispose() cleans up panel and all registered listeners
 *  - postMessage() queues messages to the webview
 *  - onMessage() registers handlers for webview → host messages
 *
 * No constructor — all static methods.
 */
export class PanelManager {
	private static _panel: vscode.WebviewPanel | undefined;
	private static _disposables: vscode.Disposable[] = [];
	private static _messageHandlers: ((msg: WebviewMessage) => void)[] = [];
	private static _context: vscode.ExtensionContext | undefined;
	private static _ready = false;
	private static _pendingMessages: HostMessage[] = [];

	/**
	 * Create a new panel or reveal the existing one.
	 *
	 * @param extensionUri Extension URI (used to resolve asset paths)
	 * @param context Extension context (for storing disposables)
	 */
	static createOrShow(extensionUri: vscode.Uri, context: vscode.ExtensionContext): void {
		if (this._panel) {
			this._panel.reveal();
			return;
		}
		this._context = context;
		this._ready = false;
		this._pendingMessages = [];

		// Create new webview panel
		this._panel = vscode.window.createWebviewPanel(
			'xmlXsltStudio',
			'XSLT Studio',
			vscode.ViewColumn.Beside,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist')],
			}
		);

		// Set HTML content
		this._panel.webview.html = this._getHtmlContent(this._panel.webview, extensionUri);

		// Wire up message receiving — store disposable so _disposeAll() can clean it up
		this._disposables.push(
			this._panel.webview.onDidReceiveMessage((msg: WebviewMessage) => {
				if (msg.type === 'READY') {
					this._ready = true;
				}
				for (const handler of this._messageHandlers) {
					handler(msg);
				}
				if (msg.type === 'READY') {
					this._flushPendingMessages();
				}
			})
		);

		// Cleanup on panel disposal — clear disposables but keep _messageHandlers
		// so they survive panel close and are still active when panel is re-opened
		this._panel.onDidDispose(() => {
			this._panel = undefined;
			this._disposeListeners();
		});
	}

	/**
	 * Dispose the panel and all registered listeners.
	 */
	static dispose(): void {
		if (this._panel) {
			this._panel.dispose();
			this._panel = undefined;
		}
		this._disposeAll();
	}

	/**
	 * Send a message from the host to the webview.
	 * No-op if panel is not open.
	 *
	 * @param msg Message to send
	 */
	static postMessage(msg: HostMessage): void {
		if (!this._panel) {
			return;
		}
		if (!this._ready) {
			this._pendingMessages.push(msg);
			return;
		}
		this._panel.webview.postMessage(msg);
	}

	/**
	 * Register a handler for webview → host messages.
	 * Handlers are called in order for each received message.
	 *
	 * @param handler Message handler
	 */
	static onMessage(handler: (msg: WebviewMessage) => void): void {
		this._messageHandlers.push(handler);
	}

	static isVisible(): boolean {
		return this._panel !== undefined && this._panel.visible;
	}

	/** Returns true if the panel instance exists (even if currently hidden). */
	static isOpen(): boolean {
		return this._panel !== undefined;
	}

	static getPanelViewColumn(): vscode.ViewColumn | undefined {
		return this._panel?.viewColumn;
	}

	static getLocks(ctx: vscode.ExtensionContext): { xml: boolean; xsl: boolean; params: boolean } {
		return ctx.workspaceState.get('xmlXslt.panelLocks', { xml: false, xsl: false, params: false });
	}
	static async setLocks(ctx: vscode.ExtensionContext, v: { xml: boolean; xsl: boolean; params: boolean }): Promise<void> {
		await ctx.workspaceState.update('xmlXslt.panelLocks', v);
	}
	static getPanelFiles(ctx: vscode.ExtensionContext): { xmlPath: string; xslPath: string } {
		return ctx.workspaceState.get('xmlXslt.panelFiles', { xmlPath: '', xslPath: '' });
	}
	static async setPanelFiles(ctx: vscode.ExtensionContext, v: { xmlPath: string; xslPath: string }): Promise<void> {
		await ctx.workspaceState.update('xmlXslt.panelFiles', v);
	}
	static getValidationConfig(ctx: vscode.ExtensionContext): { enabled: boolean; helger: boolean; profile: ValidationProfile } {
		return ctx.workspaceState.get('xmlXslt.validationConfig', { enabled: true, helger: false, profile: 'auto' as ValidationProfile });
	}
	static async setValidationConfig(ctx: vscode.ExtensionContext, v: { enabled: boolean; helger: boolean; profile: ValidationProfile }): Promise<void> {
		await ctx.workspaceState.update('xmlXslt.validationConfig', v);
	}

	/**
	 * Generate HTML skeleton for the webview.
	 * Uses a nonce for CSP script-src, and resolves dist/webview.js asset URI.
	 *
	 * @param webview Webview instance (for asWebviewUri)
	 * @param extensionUri Extension URI (for asset resolution)
	 * @returns HTML string
	 */
	private static _getHtmlContent(webview: vscode.Webview, extensionUri: vscode.Uri): string {
		// Generate CSP nonce (crypto not imported at module level)
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const nonce = require('crypto').randomBytes(16).toString('hex');

		// Resolve webview.js URI
		const webviewJsUri = webview.asWebviewUri(
			vscode.Uri.joinPath(extensionUri, 'dist', 'webview.js')
		);

		return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline';"/>
<style>
*{box-sizing:border-box;}
body{font-family:var(--vscode-font-family,sans-serif);font-size:var(--vscode-font-size,13px);
     color:var(--vscode-foreground);background:var(--vscode-editor-background);margin:0;padding:0;
     display:flex;flex-direction:column;height:100vh;overflow:hidden;}
.tab-bar{display:grid;grid-template-columns:1fr 1fr;border-bottom:1px solid var(--vscode-panel-border);flex-shrink:0;}
.tab{padding:10px 0;cursor:pointer;font-size:13px;font-weight:600;text-align:center;
     color:var(--vscode-descriptionForeground);border-bottom:2px solid transparent;user-select:none;position:relative;}
.tab.active{color:var(--vscode-button-foreground);background:var(--vscode-button-background);
            border-bottom:4px solid var(--vscode-focusBorder,#007fd4);}
.tab-badge{background:var(--vscode-badge-background,#007acc);color:var(--vscode-badge-foreground,#fff);
           border-radius:9px;padding:0 5px;font-size:10px;font-weight:700;margin-left:4px;display:none;}
.tab-pane{flex:1;overflow-y:auto;padding:10px 14px;}
.section-label{font-size:10px;text-transform:uppercase;letter-spacing:.08em;
               color:var(--vscode-descriptionForeground);margin:12px 0 4px;font-weight:600;}
.card{background:var(--vscode-editor-background);border:1px solid var(--vscode-panel-border);
      border-radius:3px;padding:8px 10px;margin:4px 0;}
.row-between{display:flex;justify-content:space-between;align-items:center;gap:8px;}
.row{display:flex;gap:6px;align-items:center;flex-wrap:wrap;}
button{background:var(--vscode-button-background);color:var(--vscode-button-foreground);
       border:none;padding:5px 12px;cursor:pointer;border-radius:2px;
       font-size:var(--vscode-font-size,13px);}
button:hover{background:var(--vscode-button-hoverBackground);}
button.secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);}
button.secondary:hover{background:var(--vscode-button-secondaryHoverBackground);}
button.icon{background:none;border:none;padding:2px 5px;cursor:pointer;font-size:14px;color:var(--vscode-foreground);}
select,input[type="text"]{background:var(--vscode-input-background);color:var(--vscode-input-foreground);
                           border:1px solid var(--vscode-input-border,transparent);
                           padding:3px 6px;font-size:var(--vscode-font-size,13px);}
.file-row{display:flex;align-items:center;gap:6px;margin:4px 0;}
.file-link{flex:1;cursor:pointer;color:var(--vscode-textLink-foreground,#3794ff);
           white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:12px;}
.file-link.empty{color:var(--vscode-descriptionForeground);font-style:italic;}
.lock-btn{background:none;border:none;cursor:pointer;padding:2px;font-size:14px;line-height:1;}
.file-hint{font-size:10px;color:var(--vscode-descriptionForeground);margin-left:2px;}
.hint{font-size:11px;color:var(--vscode-descriptionForeground);margin:3px 0;}
.hint.amber{color:var(--vscode-editorWarning-foreground,#cca700);}
.collapsible-header{display:flex;align-items:center;gap:6px;cursor:pointer;
                    padding:5px 0;user-select:none;border-bottom:1px solid var(--vscode-panel-border);}
.collapsible-header:hover{color:var(--vscode-focusBorder,#007fd4);}
.collapsible-body{padding:6px 0;}
.param-table{width:100%;font-size:11px;}
.param-header,.param-row{display:grid;grid-template-columns:140px 130px 1fr;gap:4px;align-items:center;padding:2px 0;}
.param-header{font-weight:600;color:var(--vscode-descriptionForeground);border-bottom:1px solid var(--vscode-panel-border);}
.param-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.param-automation,.param-input{width:100%;font-size:11px;}
.param-value-cell{overflow:hidden;}
.ps-card{background:var(--vscode-editor-background);border:1px solid var(--vscode-panel-border);
         border-radius:3px;padding:8px 10px;margin:6px 0;}
.ps-card-row{display:flex;gap:6px;align-items:center;margin:4px 0;}
.ps-card-row select{flex:1;min-width:0;}
.icon-btn{background:none;border:none;cursor:pointer;padding:2px 4px;font-size:14px;line-height:1;}
.btn-save-outlined{background:none;border:2px solid var(--vscode-testing-iconPassed,#73c991);color:var(--vscode-testing-iconPassed,#73c991);cursor:pointer;padding:4px 10px;font-size:11px;font-weight:600;border-radius:4px;white-space:nowrap;}
.btn-save-outlined:hover{background:var(--vscode-testing-iconPassed,#73c991);color:#1e1e1e;}
.btn-manage-outlined{background:none;border:2px solid var(--vscode-editorInfo-foreground,#3794ff);color:var(--vscode-editorInfo-foreground,#3794ff);cursor:pointer;padding:4px 10px;font-size:11px;font-weight:600;border-radius:4px;white-space:nowrap;}
.btn-manage-outlined:hover{background:var(--vscode-editorInfo-foreground,#3794ff);color:#1e1e1e;}
.btn-danger-outlined{background:none;border:2px solid var(--vscode-errorForeground,#f48771);color:var(--vscode-errorForeground,#f48771);cursor:pointer;padding:4px 10px;font-size:11px;font-weight:600;border-radius:4px;white-space:nowrap;}
.btn-danger-outlined:hover{background:var(--vscode-errorForeground,#f48771);color:#1e1e1e;}
.btn-danger-outlined:disabled,.btn-save-outlined:disabled,.btn-manage-outlined:disabled{opacity:0.35;cursor:not-allowed;}
.summary-row{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;}
.results-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end;}
.results-helger-toggle{display:flex;align-items:center;gap:4px;font-size:11px;cursor:pointer;}
.btn-revalidate-inline{font-size:11px;padding:3px 10px;border-radius:4px;border:1px solid var(--vscode-focusBorder,#007fd4);background:transparent;color:var(--vscode-textLink-foreground,#3794ff);}
.btn-revalidate-inline:hover{background:var(--vscode-button-secondaryHoverBackground);color:var(--vscode-foreground);}
.badges{display:flex;gap:6px;align-items:center;}
.badge-span{border-radius:10px;padding:2px 8px;font-size:11px;font-weight:600;}
#badge-errors{background:var(--vscode-inputValidation-errorBackground,#f48771);color:#fff;}
#badge-warnings{background:var(--vscode-inputValidation-warningBackground,#cca700);color:#fff;}
#badge-info{background:var(--vscode-inputValidation-infoBackground,#007acc);color:#fff;}
#last-run-meta{font-size:10px;color:var(--vscode-descriptionForeground);margin:2px 0 8px;}
.issue-table{width:100%;font-size:11px;}
.issue-header{display:grid;grid-template-columns:16px 80px 44px 44px 70px;gap:4px;align-items:center;padding:2px 0;
              font-weight:600;color:var(--vscode-descriptionForeground);border-bottom:1px solid var(--vscode-panel-border);}
.issue-entry{border-bottom:1px solid var(--vscode-panel-border);}
.issue-entry-header{display:grid;grid-template-columns:16px 80px 44px 44px 70px;gap:4px;align-items:center;padding:3px 0;cursor:pointer;}
.issue-entry-header:hover{background:var(--vscode-list-hoverBackground);}
.issue-entry.sev-error .icon-error,.icon-error{color:var(--vscode-testing-iconFailed,#f48771);}
.issue-entry.sev-warning .icon-warning,.icon-warning{color:var(--vscode-editorWarning-foreground,#cca700);}
.icon-info{color:var(--vscode-editorInfo-foreground,#3794ff);}
.issue-muted{color:var(--vscode-descriptionForeground);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.issue-code{font-size:9px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.issue-line-link{background:none;border:none;padding:0;cursor:pointer;color:var(--vscode-textLink-foreground,#3794ff);text-decoration:none;}
.issue-line-link:hover{text-decoration:underline;}
.issue-entry-msg{padding:2px 0 4px 20px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
                 font-size:11px;color:var(--vscode-descriptionForeground);cursor:pointer;}
.issue-entry-msg.expanded{white-space:normal;word-break:break-word;}
.results-section{margin-top:10px;}
.results-details{margin-top:10px;border-top:1px solid var(--vscode-panel-border);padding-top:8px;}
.results-details summary{cursor:pointer;font-size:11px;font-weight:700;color:var(--vscode-foreground);letter-spacing:0;}
.results-details summary:hover{color:var(--vscode-textLink-foreground,#3794ff);}
.results-details[open] summary{margin-bottom:8px;}
.results-actions{display:flex;justify-content:flex-start;margin:10px 0 4px;}
.btn-export-report{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--vscode-button-background);background:var(--vscode-button-background);color:var(--vscode-button-foreground);border-radius:6px;padding:6px 12px;font-size:12px;font-weight:700;box-shadow:0 0 0 1px color-mix(in srgb,var(--vscode-focusBorder,#007fd4) 35%,transparent);}
.btn-export-report:hover{background:var(--vscode-button-hoverBackground);border-color:var(--vscode-focusBorder,#007fd4);}
.mini-table{width:100%;font-size:11px;}
.mini-header,.mini-row{display:grid;gap:6px;align-items:start;}
.mini-header{padding:0 6px 5px;font-weight:700;color:var(--vscode-descriptionForeground);border-bottom:1px solid var(--vscode-panel-border);}
.mini-row{padding:6px;border-left:2px solid transparent;border-bottom:1px solid var(--vscode-panel-border);}
.mini-row:hover{background:var(--vscode-list-hoverBackground);border-left-color:var(--vscode-focusBorder,#007fd4);}
.rule-header,.rule-row{grid-template-columns:68px 70px minmax(88px,1fr) minmax(120px,1.6fr);}
.history-header,.history-row{grid-template-columns:92px 86px minmax(150px,1fr);}
.rule-text,.history-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.rule-text-wrap,.history-text-wrap{white-space:normal;word-break:break-word;}
.rule-source{font-weight:700;color:var(--vscode-symbolIcon-moduleForeground,var(--vscode-textLink-foreground,#3794ff));}
.rule-id{font-family:var(--vscode-editor-font-family,monospace);font-size:10px;color:var(--vscode-foreground);}
.rule-description{color:var(--vscode-descriptionForeground);}
.status-chip{display:inline-flex;align-items:center;justify-content:center;min-width:54px;border-radius:999px;padding:1px 7px;font-size:10px;font-weight:700;line-height:16px;white-space:nowrap;border:1px solid currentColor;}
.status-pass{color:var(--vscode-testing-iconPassed,#73c991);background:color-mix(in srgb,var(--vscode-testing-iconPassed,#73c991) 14%,transparent);}
.status-fail{color:var(--vscode-testing-iconFailed,#f48771);background:color-mix(in srgb,var(--vscode-testing-iconFailed,#f48771) 14%,transparent);}
.status-skip{color:var(--vscode-descriptionForeground);background:var(--vscode-editorWidget-background,var(--vscode-editor-background));}
.history-stack{display:flex;flex-direction:column;gap:2px;min-width:0;}
.history-line{display:grid;grid-template-columns:52px minmax(0,1fr);gap:5px;min-width:0;}
.counts-stack .history-line{grid-template-columns:64px minmax(0,1fr);gap:10px;}
.history-label{color:var(--vscode-descriptionForeground);font-size:10px;font-weight:700;text-transform:uppercase;}
.history-value{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--vscode-foreground);}
.history-value-line{display:block;}
.history-doc .history-value{white-space:normal;word-break:break-word;}
.count-total .history-value{color:var(--vscode-foreground);font-weight:700;}
.count-error .history-value{color:var(--vscode-testing-iconFailed,#f48771);font-weight:700;}
.count-warning .history-value{color:var(--vscode-editorWarning-foreground,#cca700);font-weight:700;}
.count-info .history-value{color:var(--vscode-editorInfo-foreground,#3794ff);font-weight:700;}
.peppol-footer{flex-shrink:0;border-top:1px solid var(--vscode-panel-border);
               padding:6px 14px;display:flex;flex-direction:column;align-items:stretch;gap:6px;font-size:11px;}
.peppol-summary{display:flex;align-items:center;gap:8px;}
.phive-details{border-top:1px solid var(--vscode-panel-border);padding-top:6px;}
.phive-details summary{cursor:pointer;color:var(--vscode-textLink-foreground,#3794ff);}
.phive-stack-grid{display:grid;grid-template-columns:auto 1fr;gap:6px 10px;margin-top:6px;font-size:10px;}
.phive-stack-cell{display:flex;flex-direction:column;gap:2px;}
.phive-stack-title{font-weight:600;color:var(--vscode-foreground);}
.phive-stack-meta{color:var(--vscode-descriptionForeground);}
.phive-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:6px;}
.dot{width:8px;height:8px;border-radius:50%;display:inline-block;flex-shrink:0;}
.dot-green{background:var(--vscode-testing-iconPassed,#73c991);}
.dot-amber{background:var(--vscode-editorWarning-foreground,#cca700);}
.btn-action-wrap{display:flex;justify-content:center;margin:14px 0 10px;}
.btn-action{min-width:160px;padding:10px 28px;border-radius:6px;font-size:14px;border:2px solid var(--vscode-focusBorder,#007fd4);}
</style>
</head>
<body>

<!-- Tab bar -->
<div class="tab-bar">
  <div class="tab active" id="tab-transform">Transform</div>
  <div class="tab" id="tab-results">
    Results<span class="tab-badge" id="tab-error-badge"></span>
  </div>
</div>

<!-- Transform pane -->
<div class="tab-pane" id="pane-transform">

  <div class="section-label">XML Input</div>
  <div class="card">
    <div class="file-row">
      <span class="file-link empty" id="xml-filename">Click to select XML file\u2026</span>
      <button class="icon" id="clear-xml-btn" title="Clear XML" style="display:none;font-size:16px;line-height:1;padding:1px 4px;">\u00D7</button>
      <button class="lock-btn" id="lock-xml-btn" title="Lock XML file">\uD83D\uDD13</button>
    </div>
    <div class="file-hint" id="xml-hint"></div>
  </div>

  <div class="section-label">XSLT Stylesheet</div>
  <div class="card">
    <div class="file-row">
      <span class="file-link empty" id="xsl-filename">Click to select XSL file\u2026</span>
      <button class="icon" id="clear-xsl-btn" title="Clear XSL" style="display:none;font-size:16px;line-height:1;padding:1px 4px;">\u00D7</button>
      <button class="lock-btn" id="lock-xsl-btn" title="Lock XSL file">\uD83D\uDD13</button>
    </div>
    <div class="file-hint" id="xsl-hint"></div>
  </div>

  <div class="section-label">Validation</div>
  <div class="card">
    <div class="row-between">
      <label style="display:flex;align-items:center;gap:5px;cursor:pointer;">
        <input type="checkbox" id="val-enabled" checked/>
        Enable validation
      </label>
      <label style="display:flex;align-items:center;gap:5px;cursor:pointer;">
        <input type="checkbox" id="val-helger"/>
        Helger (online)
      </label>
    </div>
    <div class="row" style="margin-top:6px;">
      <label style="font-size:11px;color:var(--vscode-descriptionForeground);">Profile:</label>
      <select id="val-profile" style="flex:1;">
        <option value="auto">Auto-detect</option>
        <option value="en16931">EN 16931</option>
        <option value="peppol-invoice">Peppol Invoice</option>
        <option value="peppol-creditnote">Peppol Credit Note</option>
        <option value="xsd-only">XSD only</option>
      </select>
    </div>
    <div class="hint" id="val-hint">Select files to detect profile</div>
  </div>

  <!-- Primary action button -->
  <div class="btn-action-wrap">
    <button id="btn-action" class="btn-action" disabled>Select files first</button>
  </div>

  <!-- Parameters collapsible -->
  <div class="collapsible-header" id="params-header">
    <span id="params-arrow">\u25BC</span>
    <span style="font-size:10px;text-transform:uppercase;letter-spacing:.08em;font-weight:600;">Parameters</span>
    <span id="params-summary" style="font-size:11px;color:var(--vscode-descriptionForeground);margin-left:4px;">no params</span>
    <button class="secondary" id="btn-clear-params" style="margin-left:auto;font-size:11px;padding:2px 7px;">Clear all</button>
    <button class="lock-btn" id="lock-params-btn" title="Lock parameters">\uD83D\uDD13</button>
  </div>
  <div class="collapsible-body" id="params-body">
    <div id="params-table-container"><div class="hint" style="padding:6px;">No parameters in this stylesheet.</div></div>
  </div>

  <!-- Profile / Scenario collapsible -->
  <div class="collapsible-header" id="ps-header">
    <span id="ps-arrow">\u25BC</span>
    <span style="font-size:10px;text-transform:uppercase;letter-spacing:.08em;font-weight:600;">Profile / Scenario</span>
    <span id="ps-summary" style="font-size:11px;color:var(--vscode-descriptionForeground);margin-left:4px;"></span>
  </div>
  <div class="collapsible-body" id="ps-body">
    <div class="ps-card">
      <div style="font-size:11px;font-weight:600;margin-bottom:6px;">Parameter Profile</div>
      <div class="ps-card-row">
        <select id="profile-select">
          <option value="">\u2014 none \u2014</option>
        </select>
        <button class="btn-save-outlined" id="btn-save-profile">Save</button>
        <button class="btn-danger-outlined" id="btn-delete-profile">Delete</button>
        <button class="btn-manage-outlined" id="btn-manage-profiles">Manage</button>
      </div>
      <div class="hint" style="margin-top:4px;">Save/load XSLT parameter values and automations for this stylesheet. Profiles are stored per stylesheet path.</div>
    </div>
    <div class="ps-card">
      <div style="font-size:11px;font-weight:600;margin-bottom:6px;">Scenario</div>
      <div class="ps-card-row">
        <select id="scenario-select">
          <option value="">\u2014 none \u2014</option>
        </select>
        <button class="btn-save-outlined" id="btn-save-scenario">Save</button>
        <button class="btn-danger-outlined" id="btn-delete-scenario">Delete</button>
        <button class="btn-manage-outlined" id="btn-manage-scenarios">Manage</button>
      </div>
      <div class="hint" style="margin-top:4px;">Scenarios remember an XML + XSL file pair. Stored in <code>.vscode/xslt-scenarios.json</code>.</div>
    </div>
  </div>


</div><!-- /pane-transform -->

<!-- Results pane -->
<div class="tab-pane" id="pane-results" style="display:none;">
  <div class="summary-row">
    <div class="badges">
      <span class="badge-span" id="badge-errors">\u2715 0 Errors</span>
      <span class="badge-span" id="badge-warnings">\u26A0 0 Warnings</span>
      <span class="badge-span" id="badge-info">\u2139 0 Info</span>
    </div>
    <div class="results-toolbar">
      <button id="btn-revalidate" class="btn-revalidate-inline" style="display:none;">Re-validate</button>
      <label class="results-helger-toggle">
        <input type="checkbox" id="results-helger"/>
        Helger
      </label>
    </div>
  </div>
  <div id="last-run-meta"></div>
  <div class="section-label">Issues</div>
  <div id="issue-table-container"><div class="hint" style="padding:6px;">No issues.</div></div>
  <div class="hint" style="margin-top:4px;">Click a row to jump to line in XML editor.</div>
  <div class="results-actions" id="results-actions" style="display:none;">
    <button id="btn-export-report" class="btn-export-report" style="display:none;">Export HTML Report</button>
  </div>
  <details class="results-details" id="rules-details" style="display:none;">
    <summary>Active Rules</summary>
    <div id="rules-table-container"><div class="hint" style="padding:6px;">No rule details.</div></div>
  </details>
  <details class="results-details" id="history-details">
    <summary>Validation History</summary>
    <div id="history-table-container"><div class="hint" style="padding:6px;">No validation history yet.</div></div>
  </details>
</div><!-- /pane-results -->

<!-- Peppol footer (always visible) -->
<div class="peppol-footer">
  <div class="peppol-summary">
    <span class="dot dot-green" id="phive-dot"></span>
    <span>Peppol rules <strong id="phive-version">\u2014</strong></span>
    <span id="phive-update-text" style="color:var(--vscode-descriptionForeground);">Checking\u2026</span>
    <span id="phive-last-date" style="font-size:10px;color:var(--vscode-descriptionForeground);"></span>
    <button class="secondary" id="btn-check-phive" style="margin-left:auto;font-size:11px;padding:2px 8px;">Check</button>
    <a href="https://github.com/andrei191999/xml-xslt-studio/issues/new" class="secondary" title="Report a bug or request a feature" style="font-size:11px;padding:2px 8px;text-decoration:none;">&#x1F41B; Report Bug</a>
  </div>
  <details class="phive-details">
    <summary>Stack details</summary>
    <div class="phive-stack-grid">
      <span>Active</span>
      <span class="phive-stack-cell">
        <span class="phive-stack-title" id="phive-active-stack">\u2014</span>
        <span class="phive-stack-meta" id="phive-active-stack-meta"></span>
      </span>
      <span>Candidate</span>
      <span class="phive-stack-cell">
        <span class="phive-stack-title" id="phive-available-stack">\u2014</span>
        <span class="phive-stack-meta" id="phive-available-stack-meta"></span>
      </span>
      <span>Previous</span>
      <span class="phive-stack-cell">
        <span class="phive-stack-title" id="phive-previous-stack">\u2014</span>
        <span class="phive-stack-meta" id="phive-previous-stack-meta"></span>
      </span>
      <span>Last checked</span><span id="phive-last-checked">\u2014</span>
    </div>
    <div class="phive-actions">
      <button class="secondary" id="btn-rollback-phive" style="font-size:11px;padding:2px 8px;display:none;">Rollback</button>
    </div>
  </details>
</div>

<script nonce="${nonce}" src="${webviewJsUri}"></script>
</body>
</html>`;
	}

	/**
	 * Dispose VS Code Disposable listeners (e.g. onDidReceiveMessage).
	 * Does NOT clear _messageHandlers — those survive panel close so they're
	 * still active when the panel is re-opened.
	 */
	private static _disposeListeners(): void {
		for (const disposable of this._disposables) {
			disposable.dispose();
		}
		this._disposables = [];
		this._ready = false;
		this._pendingMessages = [];
	}

	private static _flushPendingMessages(): void {
		if (!this._panel || !this._ready || this._pendingMessages.length === 0) {
			return;
		}
		const queued = this._pendingMessages;
		this._pendingMessages = [];
		for (const msg of queued) {
			this._panel.webview.postMessage(msg);
		}
	}

	/**
	 * Full teardown — dispose listeners and clear all handlers.
	 * Called only on explicit PanelManager.dispose() (e.g. extension deactivation).
	 */
	private static _disposeAll(): void {
		this._disposeListeners();
		this._messageHandlers = [];
	}
}
