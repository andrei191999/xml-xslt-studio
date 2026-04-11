import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

const CONFIG_FILENAME = '.ublproject.json';

export async function initConfigCommand(): Promise<void> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        vscode.window.showWarningMessage('Open a workspace folder first.');
        return;
    }

    let targetFolder: vscode.WorkspaceFolder;
    if (workspaceFolders.length === 1) {
        targetFolder = workspaceFolders[0];
    } else {
        const picked = await vscode.window.showWorkspaceFolderPick({
            placeHolder: 'Select workspace folder for .ublproject.json',
        });
        if (!picked) {
            return;
        }
        targetFolder = picked;
    }

    const configPath = path.join(targetFolder.uri.fsPath, CONFIG_FILENAME);
    if (fs.existsSync(configPath)) {
        const overwrite = await vscode.window.showWarningMessage(
            '.ublproject.json already exists. Overwrite?',
            'Yes', 'No'
        );
        if (overwrite !== 'Yes') {
            return;
        }
    }

    const profileName = await vscode.window.showInputBox({
        prompt: 'Profile name',
        value: 'invoice-mapping',
        validateInput: v => v.trim() ? null : 'Name is required',
    });
    if (!profileName) {
        return;
    }

    const sourceXml = await vscode.window.showInputBox({
        prompt: 'Path to source XML (relative to workspace root)',
        value: 'examples/input.xml',
    });
    if (!sourceXml) {
        return;
    }

    const xsltStylesheet = await vscode.window.showInputBox({
        prompt: 'Path to XSLT stylesheet (relative to workspace root)',
        value: 'mappings/to-ubl-invoice.xsl',
    });
    if (!xsltStylesheet) {
        return;
    }

    const scopeChoice = await vscode.window.showQuickPick(
        [
            { label: 'Full (XSD + Business Rules)', value: 'full' },
            { label: 'XSD Only', value: 'xsd-only' },
            { label: 'Business Rules Only', value: 'business-rules-only' },
        ],
        { placeHolder: 'Validation scope' }
    );
    if (!scopeChoice) {
        return;
    }

    const config = {
        version: 1,
        defaultProfile: profileName,
        profiles: [
            {
                name: profileName,
                sourceXml,
                xsltStylesheet,
                validationScope: scopeChoice.value,
                enabled: true,
            },
        ],
    };

    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
    const doc = await vscode.workspace.openTextDocument(configPath);
    await vscode.window.showTextDocument(doc);
    vscode.window.showInformationMessage(`Created ${CONFIG_FILENAME} in ${targetFolder.name}`);
}
