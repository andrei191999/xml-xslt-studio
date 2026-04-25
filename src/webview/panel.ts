import type {
    HostMessage, WebviewMessage, ParamEntry, ValidationIssueSummary, ScenarioSummary, ValidationProfile,
} from './types';

declare function acquireVsCodeApi(): { postMessage(msg: WebviewMessage): void };
const vscode = acquireVsCodeApi();

let xmlFsPath = '';
let xslFsPath = '';
let locks = { xml: false, xsl: false, params: false };
let params: ParamEntry[] = [];
let scenarios: ScenarioSummary[] = [];
let activeScenarioName = '';
let validationConfig: { enabled: boolean; helger: boolean; profile: ValidationProfile } = { enabled: true, helger: false, profile: 'auto' };
let hasValidationResult = false;

const AUTOMATION_OPTIONS: [string, string][] = [
    ['manual', 'Manual'], ['uuid', 'UUID'], ['today', 'Today (date)'],
    ['timestamp', 'Timestamp'], ['filename', 'Filename'], ['basename', 'Basename'],
    ['xpath(...)', 'XPath'], ['literal', 'Literal'],
];

function el<T extends HTMLElement>(id: string): T { return document.getElementById(id) as T; }

function clearChildren(node: HTMLElement): void {
    while (node.firstChild) { node.removeChild(node.firstChild); }
}

function makeSpan(cls: string, text: string, styleAttr?: string): HTMLSpanElement {
    const s = document.createElement('span');
    s.className = cls;
    s.textContent = text;
    if (styleAttr) { s.setAttribute('style', styleAttr); }
    return s;
}

function basename(fsPath: string): string {
    const parts = fsPath.split(/[\\/]/).filter(Boolean);
    return parts[parts.length - 1] ?? fsPath;
}

function profileOptionValue(xsltPath: string, profileName: string): string {
    return `${xsltPath}||${profileName}`;
}

function parseProfileOptionValue(value: string): { xsltPath: string; profileName: string } {
    const sep = value.indexOf('||');
    if (sep === -1) {
        return { xsltPath: xslFsPath, profileName: value };
    }
    return {
        xsltPath: value.slice(0, sep),
        profileName: value.slice(sep + 2),
    };
}

function abbreviatePath(fsPath: string): string {
    const parts = fsPath.split(/[\\/]/).filter(Boolean);
    if (parts.length <= 2) {
        return fsPath;
    }
    return `.../${parts.slice(-2).join('/')}`;
}

function tailPath(fsPath: string, segments: number): string {
    const parts = fsPath.split(/[\\/]/).filter(Boolean);
    if (parts.length <= segments) {
        return fsPath;
    }
    return `.../${parts.slice(-segments).join('/')}`;
}

// ----------------------------------------------------------------------------
// Tab and collapsible section logic
// ----------------------------------------------------------------------------

function switchTab(tab: 'transform' | 'results'): void {
    el('pane-transform').style.display = tab === 'transform' ? '' : 'none';
    el('pane-results').style.display   = tab === 'results'   ? '' : 'none';
    el('tab-transform').classList.toggle('active', tab === 'transform');
    el('tab-results').classList.toggle('active', tab === 'results');
}

function toggleSection(id: 'params' | 'ps'): void {
    const body  = el(`${id}-body`);
    const arrow = el(`${id}-arrow`);
    const open  = body.style.display !== 'none';
    body.style.display = open ? 'none' : '';
    arrow.textContent  = open ? '\u25B6' : '\u25BC';  // right-triangle / down-triangle
}

// ----------------------------------------------------------------------------
// File picker and lock controls
// ----------------------------------------------------------------------------

function requestFilePick(role: 'xml' | 'xsl'): void {
    if (role === 'xml' ? locks.xml : locks.xsl) { return; }
    vscode.postMessage({ type: 'FILE_PICK_REQUEST', role });
}

function applyFileSelected(role: 'xml' | 'xsl', fsPath: string, fileName: string): void {
    if (role === 'xml') { xmlFsPath = fsPath; } else { xslFsPath = fsPath; }
    const link = el(`${role}-filename`);
    link.textContent = fileName;
    link.classList.remove('empty');
    const locked = role === 'xml' ? locks.xml : locks.xsl;
    el(`clear-${role}-btn`).style.display = locked ? 'none' : '';
    updateActionBtn();
}

function clearFile(role: 'xml' | 'xsl'): void {
    if (role === 'xml') { xmlFsPath = ''; } else { xslFsPath = ''; }
    const link = el(`${role}-filename`);
    link.textContent = role === 'xml' ? 'Click to select XML file\u2026' : 'Click to select XSL file\u2026';
    link.classList.add('empty');
    el(`clear-${role}-btn`).style.display = 'none';
    if (role === 'xsl') { renderParams([]); }
    updateActionBtn();
    vscode.postMessage({ type: 'FILE_CLEARED', role });
}

function updateActionBtn(): void {
    const btn = el<HTMLButtonElement>('btn-action');
    if (xmlFsPath && xslFsPath) {
        btn.textContent = 'Transform'; btn.disabled = false;
    } else if (xmlFsPath) {
        btn.textContent = 'Validate'; btn.disabled = false;
    } else {
        btn.textContent = 'Select files first'; btn.disabled = true;
    }
}

function toggleLock(role: 'xml' | 'xsl'): void {
    if (role === 'xml') { locks.xml = !locks.xml; } else { locks.xsl = !locks.xsl; }
    applyLockUi();
    vscode.postMessage({ type: 'LOCK_CHANGED', ...locks });
}

function onParamsLockChange(): void {
    locks.params = !locks.params;
    if (locks.params) { locks.xsl = true; }  // locking params auto-locks XSL
    applyLockUi();
    vscode.postMessage({ type: 'LOCK_CHANGED', ...locks });
}

function applyLockUi(): void {
    for (const role of ['xml', 'xsl'] as const) {
        const locked = role === 'xml' ? locks.xml : locks.xsl;
        el(`lock-${role}-btn`).textContent = locked ? '\uD83D\uDD12' : '\uD83D\uDD13';  // lock/unlock emoji
        const link = el(`${role}-filename`);
        link.style.cursor  = locked ? 'default' : 'pointer';
        link.style.opacity = locked ? '0.5' : '';
        // Hide × when locked; show only when a file is selected and unlocked
        const hasFile = role === 'xml' ? !!xmlFsPath : !!xslFsPath;
        el(`clear-${role}-btn`).style.display = locked || !hasFile ? 'none' : '';
    }
    el('lock-params-btn').textContent = locks.params ? '\uD83D\uDD12' : '\uD83D\uDD13';
    document.querySelectorAll<HTMLSelectElement | HTMLInputElement>('.param-automation,.param-input')
        .forEach(inp => { inp.disabled = locks.params; });
}

// ----------------------------------------------------------------------------
// Validation section
// ----------------------------------------------------------------------------

function updateRevalidateBtn(): void {
    el('btn-revalidate').style.display =
        (hasValidationResult && validationConfig.enabled) ? '' : 'none';
}

function onValidationChange(): void {
    const enabled = el<HTMLInputElement>('val-enabled').checked;
    let helger    = el<HTMLInputElement>('val-helger').checked;
    const profile = el<HTMLSelectElement>('val-profile').value as ValidationProfile;
    // When validation is disabled, also uncheck Helger so it doesn't stay
    // checked-but-disabled (which is impossible to toggle).
    if (!enabled && helger) {
        helger = false;
        el<HTMLInputElement>('val-helger').checked = false;
        el<HTMLInputElement>('results-helger').checked = false;
    }
    validationConfig = { enabled, helger, profile };
    el<HTMLInputElement>('results-helger').checked = helger;
    el<HTMLSelectElement>('val-profile').disabled  = !enabled;
    el<HTMLInputElement>('val-helger').disabled    = !enabled;
    updateRevalidateBtn();
    vscode.postMessage({ type: 'VALIDATION_CONFIG_CHANGED', enabled, helger, profile });
}

function onResultsHelgerChange(): void {
    validationConfig.helger = el<HTMLInputElement>('results-helger').checked;
    el<HTMLInputElement>('val-helger').checked = validationConfig.helger;
    vscode.postMessage({ type: 'VALIDATION_CONFIG_CHANGED', ...validationConfig });
}

function applyValidationProfileDetected(profile: ValidationProfile | null, source: 'xml' | 'xsl' | null): void {
    const select = el<HTMLSelectElement>('val-profile');
    const hint   = el('val-hint');
    if (profile) {
        select.value = profile;
        validationConfig.profile = profile;
        hint.textContent = `CustomizationID found in ${source === 'xml' ? 'input XML' : 'XSL stylesheet'} \u00B7 override if needed`;
        hint.className   = 'hint';
    } else {
        select.value = 'auto';
        validationConfig.profile = 'auto';
        hint.textContent = 'CustomizationID not detected \u2014 select a profile, use auto-detect, or disable validation';
        hint.className   = 'hint amber';
    }
}

// ----------------------------------------------------------------------------
// Automation preview — shown in the value cell for non-manual automations
// ----------------------------------------------------------------------------

function getAutomationPreview(automation: string): string {
    const now = new Date();
    switch (automation) {
        case 'today': {
            const y = now.getFullYear();
            const mo = String(now.getMonth() + 1).padStart(2, '0');
            const d  = String(now.getDate()).padStart(2, '0');
            return `${y}-${mo}-${d}`;
        }
        case 'timestamp':
            return now.toISOString();
        case 'filename': {
            if (!xmlFsPath) { return '(select XML first)'; }
            return xmlFsPath.split(/[\\/]/).pop() ?? '(select XML first)';
        }
        case 'basename': {
            if (!xmlFsPath) { return '(select XML first)'; }
            const fname = xmlFsPath.split(/[\\/]/).pop() ?? '';
            return fname.replace(/\.[^.]+$/, '');
        }
        case 'uuid':
            return 'auto-generated UUID';
        default:
            return '\u2014';
    }
}

// ----------------------------------------------------------------------------
// Param table (safe DOM only)
// ----------------------------------------------------------------------------

function renderParams(paramList: ParamEntry[]): void {
    params = paramList;
    const summary   = el('params-summary');
    const container = el('params-table-container');
    clearChildren(container);

    const paramsBody = el('params-body');
    const isOpen = paramsBody.style.display !== 'none';
    if (params.length === 0) {
        summary.textContent = 'no params';
        const hint = document.createElement('div');
        hint.className = 'hint';
        hint.setAttribute('style', 'padding:6px;');
        hint.textContent = 'No parameters in this stylesheet.';
        container.appendChild(hint);
        if (isOpen) { toggleSection('params'); }
        return;
    }
    if (!isOpen) { toggleSection('params'); }
    summary.textContent = `${params.length} param${params.length === 1 ? '' : 's'}`;

    const table = document.createElement('div');
    table.className = 'param-table';

    const header = document.createElement('div');
    header.className = 'param-header';
    for (const label of ['Name', 'Automation', 'Value']) {
        const s = document.createElement('span');
        s.textContent = label;
        header.appendChild(s);
    }
    table.appendChild(header);

    params.forEach((p, i) => {
        const row = document.createElement('div');
        row.className = 'param-row';

        const nameDiv = document.createElement('div');
        nameDiv.className = 'param-name';
        nameDiv.textContent = p.name;
        nameDiv.title = p.name;

        const sel = document.createElement('select');
        sel.className = 'param-automation';
        sel.dataset.idx = String(i);
        sel.disabled = locks.params;
        AUTOMATION_OPTIONS.forEach(([val, label]) => {
            const opt = document.createElement('option');
            opt.value = val;
            opt.textContent = label;
            const matchesXpath = val === 'xpath(...)' && p.automation.startsWith('xpath(');
            if (p.automation === val || matchesXpath) { opt.selected = true; }
            sel.appendChild(opt);
        });
        sel.addEventListener('change', () => refreshParamValueCell(i, sel.value, p));

        const valueDiv = document.createElement('div');
        valueDiv.className = 'param-value-cell';
        valueDiv.id = `pvc-${i}`;
        buildValueCell(valueDiv, p, i);

        row.appendChild(nameDiv);
        row.appendChild(sel);
        row.appendChild(valueDiv);
        table.appendChild(row);
    });

    container.appendChild(table);
}

function buildValueCell(cell: HTMLElement, p: ParamEntry, i: number): void {
    const isXpath   = p.automation.startsWith('xpath(');
    const needInput = p.automation === 'manual' || p.automation === 'literal' || isXpath;
    if (needInput) {
        const inp = document.createElement('input');
        inp.type = 'text';
        inp.className = 'param-input';
        inp.dataset.idx = String(i);
        inp.disabled = locks.params;
        inp.value = isXpath ? p.automation.slice(6, -1) : p.value;
        inp.placeholder = isXpath ? 'XPath expression' : 'value';
        cell.appendChild(inp);
    } else {
        const preview = document.createElement('span');
        preview.className = 'hint';
        preview.style.fontStyle = 'italic';
        preview.textContent = getAutomationPreview(p.automation);
        cell.appendChild(preview);
    }
}

function refreshParamValueCell(i: number, auto: string, p: ParamEntry): void {
    const cell = document.getElementById(`pvc-${i}`);
    if (!cell) { return; }
    clearChildren(cell);
    const isXpath   = auto === 'xpath(...)';
    const needInput = auto === 'manual' || auto === 'literal' || isXpath;
    if (needInput) {
        const inp = document.createElement('input');
        inp.type = 'text';
        inp.className = 'param-input';
        inp.dataset.idx = String(i);
        inp.disabled = locks.params;
        inp.placeholder = isXpath ? 'XPath expression' : 'value';
        cell.appendChild(inp);
    } else {
        const preview = document.createElement('span');
        preview.className = 'hint';
        preview.style.fontStyle = 'italic';
        preview.textContent = getAutomationPreview(auto);
        cell.appendChild(preview);
    }
}

function collectParamsAndAutomations(): { params: Record<string, string>; automations: Record<string, string> } {
    const out = { params: {} as Record<string, string>, automations: {} as Record<string, string> };
    params.forEach((p, i) => {
        const sel = document.querySelector<HTMLSelectElement>(`.param-automation[data-idx="${i}"]`);
        const inp = document.querySelector<HTMLInputElement>(`.param-input[data-idx="${i}"]`);
        const auto = sel ? sel.value : p.automation;
        out.automations[p.name] = (auto === 'xpath(...)' && inp) ? `xpath(${inp.value})` : auto;
        out.params[p.name] = inp ? inp.value : p.value;
    });
    return out;
}

// ----------------------------------------------------------------------------
// Profile / Scenario, Transform, Results
// ----------------------------------------------------------------------------

/** Sync the select element's title to the full text of its selected option for hover tooltip. */
function syncSelectTitle(sel: HTMLSelectElement): void {
    const opt = sel.options[sel.selectedIndex];
    sel.title = opt ? (opt.title || opt.textContent || '') : '';
}

function renderProfileList(
    currentList: string[],
    currentXsltPath: string,
    allProfiles: Array<{ xsltPath: string; profileNames: string[] }> = [],
    autoSelect?: string,
): void {
    const sel = el<HTMLSelectElement>('profile-select');
    const cur = sel.value;
    clearChildren(sel);
    const none = document.createElement('option');
    none.value = '';
    none.textContent = '\u2014 none \u2014';
    sel.appendChild(none);

    const currentGroup = document.createElement('optgroup');
    currentGroup.label = 'Current stylesheet';
    currentList.forEach(profileName => {
        const option = document.createElement('option');
        option.value = profileOptionValue(currentXsltPath, profileName);
        option.textContent = profileName;
        option.title = `${profileName} (${currentXsltPath})`;
        currentGroup.appendChild(option);
    });
    sel.appendChild(currentGroup);

    const others = allProfiles.filter(group => group.xsltPath !== currentXsltPath && group.profileNames.length > 0);
    const basenameCounts = new Map<string, number>();
    others.forEach(group => {
        const base = basename(group.xsltPath);
        basenameCounts.set(base, (basenameCounts.get(base) ?? 0) + 1);
    });
    if (others.length > 0) {
        const otherGroup = document.createElement('optgroup');
        otherGroup.label = 'Other stylesheets';
        others.forEach(group => {
            const base = basename(group.xsltPath);
            const isAmbiguous = (basenameCounts.get(base) ?? 0) > 1;
            const displayPath = isAmbiguous ? tailPath(group.xsltPath, 3) : base;
            group.profileNames.forEach(profileName => {
                const option = document.createElement('option');
                option.value = profileOptionValue(group.xsltPath, profileName);
                option.textContent = `${profileName} (${displayPath})`;
                option.title = `${profileName} (${group.xsltPath})`;
                otherGroup.appendChild(option);
            });
        });
        sel.appendChild(otherGroup);
    }

    const target = autoSelect ? profileOptionValue(currentXsltPath, autoSelect) : cur;
    if (target && Array.from(sel.options).some(option => option.value === target)) {
        sel.value = target;
    }
    syncSelectTitle(sel);
    el<HTMLButtonElement>('btn-delete-profile').disabled = !sel.value;
}

function renderScenarioList(list: ScenarioSummary[]): void {
    scenarios = list;
    const sel = el<HTMLSelectElement>('scenario-select');
    const cur = sel.value;
    clearChildren(sel);
    const none = document.createElement('option'); none.value = ''; none.textContent = '\u2014 none \u2014'; sel.appendChild(none);
    list.forEach(s => {
        const o = document.createElement('option');
        o.value = s.name;
        const xmlBase = s.xmlPath ? basename(s.xmlPath) : '';
        const xslBase = s.xsltPath ? basename(s.xsltPath) : '';
        o.textContent = xmlBase && xslBase ? `${s.name} (${xmlBase} → ${xslBase})` : s.name;
        o.title = s.xmlPath && s.xsltPath ? `${s.xmlPath} → ${s.xsltPath}` : s.name;
        sel.appendChild(o);
    });
    if (cur && list.some(s => s.name === cur)) { sel.value = cur; }
    if (activeScenarioName) { el('ps-summary').textContent = activeScenarioName; }
    syncSelectTitle(sel);
    el<HTMLButtonElement>('btn-delete-scenario').disabled = !sel.value;
}

function onProfileSelect(): void {
    const sel = el<HTMLSelectElement>('profile-select');
    const value = sel.value;
    syncSelectTitle(sel);
    el<HTMLButtonElement>('btn-delete-profile').disabled = !value;
    if (!value) { return; }
    const { xsltPath, profileName } = parseProfileOptionValue(value);
    if (!profileName || !xsltPath) { return; }
    vscode.postMessage({ type: 'PROFILE_LOAD', xsltPath, profileName });
}

function onScenarioSelect(): void {
    const sel = el<HTMLSelectElement>('scenario-select');
    const name = sel.value;
    syncSelectTitle(sel);
    el<HTMLButtonElement>('btn-delete-scenario').disabled = !name;
    if (!name) { return; }
    activeScenarioName = name;
    el('ps-summary').textContent = name;
    vscode.postMessage({ type: 'SCENARIO_LOAD_REQUEST', scenarioName: name });
}

function clearAllParams(): void {
    renderParams(params.map(p => ({ ...p, value: '', automation: 'manual' })));
}

function saveProfile(): void  {
    const { params: paramValues, automations } = collectParamsAndAutomations();
    vscode.postMessage({ type: 'SAVE_PROFILE_REQUEST', params: paramValues, automations });
}
function saveScenario(): void {
    const { params: paramValues, automations } = collectParamsAndAutomations();
    vscode.postMessage({ type: 'SAVE_SCENARIO_REQUEST', params: paramValues, automations });
}

function doTransform(): void {
    const { params: paramValues, automations } = collectParamsAndAutomations();
    vscode.postMessage({
        type: 'TRANSFORM_REQUEST', params: paramValues, automations,
        xmlPath: xmlFsPath, xsltPath: xslFsPath,
        validationProfile: validationConfig.enabled ? validationConfig.profile : undefined,
        validationEnabled: validationConfig.enabled,
    });
    switchTab('results');
    el<HTMLInputElement>('results-helger').checked = validationConfig.helger;
}

function updateBadges(errors: number, warnings: number, info: number): void {
    el('badge-errors').textContent   = `\u2715 ${errors} Error${errors     !== 1 ? 's' : ''}`;
    el('badge-warnings').textContent = `\u26A0 ${warnings} Warning${warnings !== 1 ? 's' : ''}`;
    el('badge-info').textContent     = `\u2139 ${info} Info`;
    const badge = el('tab-error-badge');
    badge.textContent   = String(errors);
    badge.style.display = errors > 0 ? '' : 'none';
}

function renderIssues(issueList: ValidationIssueSummary[]): void {
    const container = el('issue-table-container');
    clearChildren(container);

    const capped = issueList.slice(0, 200);
    if (capped.length === 0) {
        const d = document.createElement('div');
        d.className = 'hint';
        d.setAttribute('style', 'padding:6px;');
        d.textContent = 'No issues.';
        container.appendChild(d);
        return;
    }

    const table = document.createElement('div');
    table.className = 'issue-table';

    const hdr = document.createElement('div');
    hdr.className = 'issue-header';
    for (const label of ['', 'Source', 'XML', 'XSLT', 'Code']) {
        const s = document.createElement('span');
        s.textContent = label;
        hdr.appendChild(s);
    }
    table.appendChild(hdr);

    capped.forEach(issue => {
        const row = document.createElement('div');
        const sevClass = issue.severity === 'error' ? 'sev-error' : issue.severity === 'warning' ? 'sev-warning' : '';
        row.className = `issue-entry ${sevClass}`.trim();

        const iconCls  = issue.severity === 'error' ? 'icon-error' : issue.severity === 'warning' ? 'icon-warning' : 'icon-info';
        const iconChar = issue.severity === 'error' ? '\u2715' : issue.severity === 'warning' ? '\u26A0' : '\u2139';

        const header = document.createElement('div');
        header.className = 'issue-entry-header';
        const messageRow = document.createElement('div');
        messageRow.className = 'issue-entry-msg';
        messageRow.textContent = issue.message;
        messageRow.title = issue.message;

        const toggleExpanded = (): void => {
            messageRow.classList.toggle('expanded');
        };
        header.addEventListener('click', toggleExpanded);
        messageRow.addEventListener('click', toggleExpanded);

        const xmlLine = document.createElement(issue.line > 0 ? 'button' : 'span');
        xmlLine.textContent = issue.line > 0 ? String(issue.line) : '\u2014';
        if (xmlLine instanceof HTMLButtonElement) {
            xmlLine.className = 'issue-line-link';
            xmlLine.type = 'button';
            xmlLine.addEventListener('click', (event) => {
                event.stopPropagation();
                vscode.postMessage({
                    type: 'NAVIGATE_TO_LINE',
                    target: 'xml',
                    line: issue.line,
                    xmlPath: xmlFsPath,
                    outputUri: issue.outputUri,
                });
            });
        } else {
            xmlLine.className = 'issue-muted';
        }

        const xsltLine = document.createElement(issue.xsltLine && issue.xsltPath ? 'button' : 'span');
        xsltLine.textContent = issue.xsltLine ? String(issue.xsltLine) : '\u2014';
        if (xsltLine instanceof HTMLButtonElement) {
            xsltLine.className = 'issue-line-link';
            xsltLine.type = 'button';
            xsltLine.addEventListener('click', (event) => {
                event.stopPropagation();
                vscode.postMessage({
                    type: 'NAVIGATE_TO_LINE',
                    target: 'xslt',
                    line: issue.line,
                    xmlPath: xmlFsPath,
                    xsltPath: issue.xsltPath,
                    xsltLine: issue.xsltLine,
                });
            });
        } else {
            xsltLine.className = 'issue-muted';
        }

        const sourceLabel = issue.source === 'local-xsd'
            ? 'XSD'
            : issue.source === 'local-schematron'
                ? 'Schematron'
                : 'Helger';
        header.appendChild(makeSpan(iconCls, iconChar));
        header.appendChild(makeSpan('issue-muted', sourceLabel));
        header.appendChild(xmlLine);
        header.appendChild(xsltLine);
        header.appendChild(makeSpan('issue-code', issue.ruleId ?? '\u2014'));
        row.appendChild(header);
        row.appendChild(messageRow);
        table.appendChild(row);
    });

    container.appendChild(table);
}

function stackLabel(stack?: { stackId: string; primaryRulesVersion?: string; directVersions: { ddd: string; phive: string; rules: string } } | null): string {
    if (!stack) {
        return '\u2014';
    }
    const rules = stack.primaryRulesVersion ?? stack.directVersions.rules;
    return `${rules} (ddd ${stack.directVersions.ddd}, phive ${stack.directVersions.phive})`;
}

function formatShortDate(value?: string | null): string {
    if (!value) {
        return '\u2014';
    }
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
        return value;
    }
    return parsed.toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: '2-digit',
    });
}

function formatPhiveSource(source: string): string {
    switch (source) {
        case 'bundled':
            return 'Bundled';
        case 'github-release':
            return 'Curated GitHub release';
        default:
            return source;
    }
}

function stackMeta(stack?: { source: string; installedAt: string; healthVerifiedAt: string | null } | null): string {
    if (!stack) {
        return '';
    }
    const parts = [
        `Source ${formatPhiveSource(stack.source)}`,
        `Installed ${formatShortDate(stack.installedAt)}`,
    ];
    if (stack.healthVerifiedAt) {
        parts.push(`Verified ${formatShortDate(stack.healthVerifiedAt)}`);
    }
    return parts.join(' · ');
}

function candidateMeta(candidate?: { source: string; publishedAt: string; minimumExtensionVersion: string; minimumJavaMajor: number } | null): string {
    if (!candidate) {
        return '';
    }
    return [
        `Source ${formatPhiveSource(candidate.source)}`,
        `Published ${formatShortDate(candidate.publishedAt)}`,
        `Min ext ${candidate.minimumExtensionVersion}`,
        `Java ${candidate.minimumJavaMajor}+`,
    ].join(' · ');
}

function updatePhive(
    version: string,
    updateState: 'update-available' | 'up-to-date' | 'no-compatible-update' | 'empty-feed' | 'check-failed',
    updateAvailable: boolean,
    latestPublishedAt?: string,
    activeStack?: {
        stackId: string;
        primaryRulesVersion: string;
        source: string;
        installedAt: string;
        healthVerifiedAt: string | null;
        directVersions: { ddd: string; phive: string; rules: string };
    },
    availableStack?: {
        stackId: string;
        source: string;
        directVersions: { ddd: string; phive: string; rules: string };
        minimumExtensionVersion: string;
        minimumJavaMajor: number;
        publishedAt: string;
    },
    previousStack?: {
        stackId: string;
        primaryRulesVersion: string;
        source: string;
        installedAt: string;
        healthVerifiedAt: string | null;
        directVersions: { ddd: string; phive: string; rules: string };
    } | null,
    lastCheckedAt?: string,
    canRollback?: boolean,
    errorMessage?: string,
): void {
    el('phive-version').textContent = version;
    el('phive-dot').className = updateState === 'up-to-date' ? 'dot dot-green' : 'dot dot-amber';
    el('phive-update-text').textContent = updateState === 'empty-feed'
        ? 'No update information available'
        : updateState === 'check-failed'
            ? 'Could not refresh curated feed'
        : updateState === 'no-compatible-update'
            ? 'No compatible curated update'
            : updateAvailable
                ? 'Update available'
                : 'Up to date';
    el('phive-last-date').textContent   = lastCheckedAt ? `\u00B7 checked ${formatShortDate(lastCheckedAt)}` : (latestPublishedAt ? `\u00B7 published ${formatShortDate(latestPublishedAt)}` : '');
    el('phive-active-stack').textContent = stackLabel(activeStack);
    el('phive-active-stack-meta').textContent = stackMeta(activeStack);
    el('phive-available-stack').textContent = availableStack
        ? stackLabel(availableStack)
        : updateState === 'check-failed'
            ? '\u2014'
        : updateState === 'empty-feed'
            ? 'No update information available'
            : updateState === 'no-compatible-update'
                ? 'No compatible curated stack'
                : (lastCheckedAt ? 'No newer curated candidate' : '\u2014');
    el('phive-available-stack-meta').textContent = availableStack
        ? candidateMeta(availableStack)
        : updateState === 'check-failed'
            ? (errorMessage || 'Could not refresh curated feed.')
        : updateState === 'empty-feed'
            ? 'The curated feed is empty. This may indicate a temporary server issue.'
            : updateState === 'no-compatible-update'
                ? 'Your current extension or local Java version does not meet the newer stack requirements.'
                : (lastCheckedAt ? `Checked ${formatShortDate(lastCheckedAt)}` : '');
    el('phive-previous-stack').textContent = stackLabel(previousStack);
    el('phive-previous-stack-meta').textContent = stackMeta(previousStack);
    el('phive-last-checked').textContent = lastCheckedAt ? formatShortDate(lastCheckedAt) : 'Not checked yet';
    el<HTMLButtonElement>('btn-rollback-phive').style.display = canRollback ? '' : 'none';
}

function checkPhiveUpdate(): void { vscode.postMessage({ type: 'PHIVE_CHECK_UPDATE' }); }
function rollbackPhive(): void { vscode.postMessage({ type: 'PHIVE_ROLLBACK' }); }

// ----------------------------------------------------------------------------
// Message handler + global exports
// ----------------------------------------------------------------------------

window.addEventListener('message', (event: MessageEvent) => {
    const msg = event.data as HostMessage;
    switch (msg.type) {
        case 'VALIDATION_RESULT':
            hasValidationResult = true;
            updateRevalidateBtn();
            updateBadges(msg.errorCount, msg.warningCount, msg.infoCount);
            renderIssues(msg.issues);
            el('last-run-meta').textContent = msg.detectedProfile ? `Detected: ${msg.detectedProfile}` : '';
            break;
        case 'PHIVE_STATUS':
            updatePhive(
                msg.activeVersion,
                msg.updateState,
                msg.updateAvailable,
                msg.latestPublishedAt,
                msg.activeStack,
                msg.availableStack,
                msg.previousStack,
                msg.lastCheckedAt,
                msg.canRollback,
                msg.errorMessage,
            );
            break;
        case 'SCENARIO_LIST':    renderScenarioList(msg.scenarios); break;
        case 'PROFILE_LIST':     renderProfileList(msg.profiles, msg.xsltPath, msg.allProfiles, msg.savedProfileName); break;
        case 'PARAMS_CHANGED':
            renderParams(msg.params);
            if (msg.xsltPath) { xslFsPath = msg.xsltPath; }
            if (msg.xmlPath)  { xmlFsPath  = msg.xmlPath;  }
            break;
        case 'LOCK_STATE':
            locks = { xml: msg.xml, xsl: msg.xsl, params: msg.params };
            applyLockUi();
            break;
        case 'VALIDATION_PROFILE_DETECTED':
            applyValidationProfileDetected(msg.profile, msg.source);
            break;
        case 'FILE_SELECTED':
            applyFileSelected(msg.role, msg.fsPath, msg.fileName);
            break;
        case 'SCENARIO_RUN_RESULT':
            updateBadges(msg.errorCount, msg.warningCount, msg.infoCount);
            break;
        case 'SWITCH_TAB':
            switchTab(msg.tab);
            break;
        case 'VALIDATION_CONFIG_STATE':
            validationConfig = { enabled: msg.enabled, helger: msg.helger, profile: msg.profile };
            el<HTMLInputElement>('val-enabled').checked = msg.enabled;
            el<HTMLInputElement>('val-helger').checked = msg.helger;
            el<HTMLSelectElement>('val-profile').value = msg.profile;
            el<HTMLInputElement>('results-helger').checked = msg.helger;
            el<HTMLSelectElement>('val-profile').disabled = !msg.enabled;
            el<HTMLInputElement>('val-helger').disabled = !msg.enabled;
            updateRevalidateBtn();
            break;
    }
});

// Wire up all event handlers via addEventListener (avoids CSP inline-handler restrictions).
function attachEventListeners(): void {
    el('tab-transform').addEventListener('click', () => {
        switchTab('transform');
        el<HTMLSelectElement>('val-profile').value = validationConfig.profile;
    });
    el('tab-results').addEventListener('click', () => switchTab('results'));
    el('xml-filename').addEventListener('click', () => requestFilePick('xml'));
    el('clear-xml-btn').addEventListener('click', () => clearFile('xml'));
    el('lock-xml-btn').addEventListener('click', () => toggleLock('xml'));
    el('xsl-filename').addEventListener('click', () => requestFilePick('xsl'));
    el('clear-xsl-btn').addEventListener('click', () => clearFile('xsl'));
    el('lock-xsl-btn').addEventListener('click', () => toggleLock('xsl'));
    el<HTMLInputElement>('val-enabled').addEventListener('change', onValidationChange);
    el<HTMLInputElement>('val-helger').addEventListener('change', onValidationChange);
    el<HTMLSelectElement>('val-profile').addEventListener('change', onValidationChange);
    el<HTMLInputElement>('results-helger').addEventListener('change', onResultsHelgerChange);
    el('params-header').addEventListener('click', () => toggleSection('params'));
    el('lock-params-btn').addEventListener('click', (e) => { e.stopPropagation(); onParamsLockChange(); });
    el('btn-clear-params').addEventListener('click', (e) => { e.stopPropagation(); clearAllParams(); });
    el('ps-header').addEventListener('click', () => toggleSection('ps'));
    el<HTMLSelectElement>('profile-select').addEventListener('change', onProfileSelect);
    el('btn-save-profile').addEventListener('click', saveProfile);
    el('btn-delete-profile').addEventListener('click', () => {
        const value = el<HTMLSelectElement>('profile-select').value;
        if (!value) { return; }
        const { xsltPath, profileName } = parseProfileOptionValue(value);
        vscode.postMessage({ type: 'PROFILE_DELETE', xsltPath, profileName });
    });
    el<HTMLSelectElement>('scenario-select').addEventListener('change', onScenarioSelect);
    el('btn-save-scenario').addEventListener('click', saveScenario);
    el('btn-delete-scenario').addEventListener('click', () => {
        const value = el<HTMLSelectElement>('scenario-select').value;
        if (!value) { return; }
        vscode.postMessage({ type: 'SCENARIO_DELETE_REQUEST', scenarioName: value });
    });
    el('btn-manage-profiles').addEventListener('click', () => {
        vscode.postMessage({ type: 'MANAGE_PROFILES_REQUEST' });
    });
    el('btn-manage-scenarios').addEventListener('click', () => {
        vscode.postMessage({ type: 'MANAGE_SCENARIOS_REQUEST' });
    });
    el('btn-action').addEventListener('click', () => {
        if (xslFsPath) { doTransform(); } else { vscode.postMessage({ type: 'VALIDATE_REQUEST', xmlPath: xmlFsPath }); }
    });
    el('btn-revalidate').addEventListener('click', () => vscode.postMessage({ type: 'VALIDATE_REQUEST' }));
    el('btn-check-phive').addEventListener('click', checkPhiveUpdate);
    el('btn-rollback-phive').addEventListener('click', rollbackPhive);
}
attachEventListeners();
// Notify the host that the webview JS is loaded and the message listener is active.
// The host defers sendPanelInitialState() until this fires to avoid the race where
// messages posted immediately after createOrShow() arrive before the listener is ready.
vscode.postMessage({ type: 'READY' });
