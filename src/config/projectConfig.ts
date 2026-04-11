import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export interface ProjectProfile {
    name: string;
    sourceXml: string;
    xsltStylesheet: string;
    validationScope: 'full' | 'xsd-only' | 'business-rules-only';
    enabled: boolean;
}

export interface ProjectConfig {
    version: number;
    defaultProfile: string;
    profiles: ProjectProfile[];
}

const CONFIG_FILENAME = '.ublproject.json';

export function findConfigFile(): string | null {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
        return null;
    }
    for (const folder of workspaceFolders) {
        const configPath = path.join(folder.uri.fsPath, CONFIG_FILENAME);
        if (fs.existsSync(configPath)) {
            return configPath;
        }
    }
    return null;
}

export function loadConfig(configPath: string): ProjectConfig {
    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw);
    validateConfig(parsed);
    return parsed as ProjectConfig;
}

function validateConfig(obj: any): void {
    if (!obj || typeof obj !== 'object') {
        throw new Error('Config must be a JSON object');
    }
    if (obj.version !== 1) {
        throw new Error(`Unsupported config version: ${obj.version}. Expected 1.`);
    }
    if (!Array.isArray(obj.profiles) || obj.profiles.length === 0) {
        throw new Error('Config must have at least one profile');
    }
    for (const p of obj.profiles) {
        if (!p.name || typeof p.name !== 'string') {
            throw new Error('Each profile must have a "name" string');
        }
        if (!p.sourceXml || typeof p.sourceXml !== 'string') {
            throw new Error(`Profile "${p.name}": missing "sourceXml"`);
        }
        if (!p.xsltStylesheet || typeof p.xsltStylesheet !== 'string') {
            throw new Error(`Profile "${p.name}": missing "xsltStylesheet"`);
        }
    }
}

export function resolveProfilePaths(
    profile: ProjectProfile,
    configDir: string
): { sourceXml: string; xsltStylesheet: string } {
    return {
        sourceXml: path.resolve(configDir, profile.sourceXml),
        xsltStylesheet: path.resolve(configDir, profile.xsltStylesheet),
    };
}

export async function pickProfile(config: ProjectConfig): Promise<ProjectProfile | undefined> {
    const enabledProfiles = config.profiles.filter(p => p.enabled !== false);
    if (enabledProfiles.length === 0) {
        vscode.window.showWarningMessage('No enabled profiles in .ublproject.json');
        return undefined;
    }
    if (enabledProfiles.length === 1) {
        return enabledProfiles[0];
    }

    // If there's a default, offer it first
    const defaultProfile = enabledProfiles.find(p => p.name === config.defaultProfile);
    const items = enabledProfiles.map(p => ({
        label: p.name,
        description: p.name === config.defaultProfile ? '(default)' : undefined,
        detail: `${p.sourceXml} -> ${p.xsltStylesheet}`,
        profile: p,
    }));

    // Sort default first
    if (defaultProfile) {
        items.sort((a, b) => {
            if (a.profile === defaultProfile) { return -1; }
            if (b.profile === defaultProfile) { return 1; }
            return 0;
        });
    }

    const picked = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select a profile',
    });

    return picked?.profile;
}
