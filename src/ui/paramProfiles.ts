import * as vscode from 'vscode';

export interface ParamProfile {
	name: string;
	params: Record<string, string>;
	automations: Record<string, string>;
}

export class ParamProfileManager {
	private readonly _ws: vscode.ExtensionContext['workspaceState'];

	constructor(workspaceState: vscode.ExtensionContext['workspaceState']) {
		this._ws = workspaceState;
	}

	private _key(xsltPath: string): string {
		return `xmlXslt.paramProfiles.${xsltPath}`;
	}

	private _load(xsltPath: string): ParamProfile[] {
		return this._ws.get<ParamProfile[]>(this._key(xsltPath)) ?? [];
	}

	/** Save (or overwrite) a profile for the given XSLT path. */
	async saveProfile(xsltPath: string, name: string, params: Record<string, string>, automations: Record<string, string>): Promise<void> {
		const profiles = this._load(xsltPath).filter(p => p.name !== name);
		profiles.push({ name, params, automations });
		await this._ws.update(this._key(xsltPath), profiles);
	}

	/** Load a profile by name. Returns undefined if not found. */
	loadProfile(xsltPath: string, name: string): ParamProfile | undefined {
		return this._load(xsltPath).find(p => p.name === name);
	}

	/** List all profile names for the given XSLT path. */
	listProfiles(xsltPath: string): string[] {
		return this._load(xsltPath).map(p => p.name);
	}

	listAllProfiles(): Array<{ xsltPath: string; profiles: ParamProfile[] }> {
		return this._ws.keys()
			.filter(key => key.startsWith('xmlXslt.paramProfiles.'))
			.map(key => ({
				xsltPath: key.slice('xmlXslt.paramProfiles.'.length),
				profiles: this._ws.get<ParamProfile[]>(key) ?? [],
			}))
			.filter(entry => entry.profiles.length > 0);
	}

	/** Delete a profile by name. No-op if not found. */
	async deleteProfile(xsltPath: string, name: string): Promise<void> {
		const profiles = this._load(xsltPath).filter(p => p.name !== name);
		await this._ws.update(this._key(xsltPath), profiles);
	}
}
