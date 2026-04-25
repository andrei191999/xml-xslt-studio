import * as fs from 'fs';
import * as path from 'path';

export interface PhiveStackDirectVersions {
    ddd: string;
    phive: string;
    rules: string;
}

export interface PhiveStackBundleRef {
    assetName: string;
    url: string;
    sizeBytes: number;
    sha256: string;
}

export interface PhiveCuratedStackEntry {
    stackId: string;
    publishedAt: string;
    source: string;
    directVersions: PhiveStackDirectVersions;
    minimumExtensionVersion: string;
    minimumJavaMajor: number;
    bundle: PhiveStackBundleRef;
}

export interface PhiveCuratedFeedV1 {
    schemaVersion: 1;
    generatedAt: string;
    channel: 'stable';
    stacks: PhiveCuratedStackEntry[];
    feedSorted?: boolean;
}

export interface PhiveStackManifest {
    stackId: string;
    source: string;
    installedAt: string;
    healthVerifiedAt: string | null;
    primaryRulesVersion: string;
    directVersions: PhiveStackDirectVersions;
    resolvedVersions: {
        ddd: string;
        phiveApi: string;
        phiveXml: string;
        phiveRulesApi: string;
        phiveRulesEn16931: string;
        phiveRulesPeppol: string;
    };
}

export interface PhiveStackState {
    activeStackId: string;
    previousStackId: string | null;
}

export interface PhiveStackStatus {
    activeStack: PhiveStackManifest;
    previousStack: PhiveStackManifest | null;
}

export type PhiveStackCandidate = PhiveCuratedStackEntry;

type ResolvedComponentKey = keyof PhiveStackManifest['resolvedVersions'];

const TRACKED_COMPONENT_PATTERNS: Record<ResolvedComponentKey, RegExp> = {
    ddd: /^ddd-(.+)\.jar$/i,
    phiveApi: /^phive-api-(.+)\.jar$/i,
    phiveXml: /^phive-xml-(.+)\.jar$/i,
    phiveRulesApi: /^phive-rules-api-(.+)\.jar$/i,
    phiveRulesEn16931: /^phive-rules-en16931-(.+)\.jar$/i,
    phiveRulesPeppol: /^phive-rules-peppol-(.+)\.jar$/i,
};

export function createStackId(directVersions: PhiveStackDirectVersions): string {
    return `ddd-${directVersions.ddd}_phive-${directVersions.phive}_rules-${directVersions.rules}`;
}

export function getPhiveRootDir(globalStorageFsPath: string): string {
    return path.join(globalStorageFsPath, 'phive');
}

export function getPhiveStacksDir(globalStorageFsPath: string): string {
    return path.join(getPhiveRootDir(globalStorageFsPath), 'stacks');
}

export function getPhiveStagingDir(globalStorageFsPath: string): string {
    return path.join(getPhiveRootDir(globalStorageFsPath), 'staging');
}

export function getPhiveStateFile(globalStorageFsPath: string): string {
    return path.join(getPhiveRootDir(globalStorageFsPath), 'state.json');
}

export function getBundledStackManifestPath(extensionPath: string): string {
    return path.join(extensionPath, 'lib', 'phive-stack.json');
}

export function getBundledJarsDir(extensionPath: string): string {
    return path.join(extensionPath, 'lib', 'phive-jars');
}

export function getInstalledStackDir(globalStorageFsPath: string, stackId: string): string {
    return path.join(getPhiveStacksDir(globalStorageFsPath), stackId);
}

export function getInstalledStackManifestPath(globalStorageFsPath: string, stackId: string): string {
    return path.join(getInstalledStackDir(globalStorageFsPath, stackId), 'manifest.json');
}

export function readStackManifestFile(manifestPath: string): PhiveStackManifest {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as PhiveStackManifest;
}

export function writeStackManifestFile(manifestPath: string, manifest: PhiveStackManifest): void {
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
}

export function readBundledStackManifest(extensionPath: string): PhiveStackManifest {
    return readStackManifestFile(getBundledStackManifestPath(extensionPath));
}

export function getDefaultPhiveState(extensionPath: string): PhiveStackState {
    return {
        activeStackId: readBundledStackManifest(extensionPath).stackId,
        previousStackId: null,
    };
}

function readStoredPhiveState(extensionPath: string, globalStorageFsPath: string): PhiveStackState {
    const stateFile = getPhiveStateFile(globalStorageFsPath);
    if (!fs.existsSync(stateFile)) {
        return getDefaultPhiveState(extensionPath);
    }
    const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as Partial<PhiveStackState>;
    const fallback = getDefaultPhiveState(extensionPath);
    return {
        activeStackId: parsed.activeStackId ?? fallback.activeStackId,
        previousStackId: parsed.previousStackId ?? null,
    };
}

export function writePhiveState(globalStorageFsPath: string, state: PhiveStackState): void {
    const stateFile = getPhiveStateFile(globalStorageFsPath);
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf8');
}

function installedStackExists(globalStorageFsPath: string, stackId: string): boolean {
    return fs.existsSync(getInstalledStackManifestPath(globalStorageFsPath, stackId));
}

export function normalizePhiveState(extensionPath: string, globalStorageFsPath: string): PhiveStackState {
    const bundled = readBundledStackManifest(extensionPath);
    const state = readStoredPhiveState(extensionPath, globalStorageFsPath);
    let changed = false;
    let activeStackId = state.activeStackId;
    let previousStackId = state.previousStackId;

    if (activeStackId !== bundled.stackId && !installedStackExists(globalStorageFsPath, activeStackId)) {
        activeStackId = bundled.stackId;
        changed = true;
    }

    if (previousStackId && previousStackId !== bundled.stackId && !installedStackExists(globalStorageFsPath, previousStackId)) {
        previousStackId = null;
        changed = true;
    }

    if (activeStackId === previousStackId) {
        previousStackId = null;
        changed = true;
    }

    const normalized = { activeStackId, previousStackId };
    if (changed) {
        writePhiveState(globalStorageFsPath, normalized);
    }
    return normalized;
}

export function readPhiveState(extensionPath: string, globalStorageFsPath: string): PhiveStackState {
    return normalizePhiveState(extensionPath, globalStorageFsPath);
}

export function listTrackedJarMatches(jarsDir: string): Record<ResolvedComponentKey, string[]> {
    const names = fs.existsSync(jarsDir) ? fs.readdirSync(jarsDir) : [];
    const matches = {} as Record<ResolvedComponentKey, string[]>;
    for (const key of Object.keys(TRACKED_COMPONENT_PATTERNS) as ResolvedComponentKey[]) {
        matches[key] = names.filter(name => TRACKED_COMPONENT_PATTERNS[key].test(name));
    }
    return matches;
}

export function buildStackManifestFromJars(
    jarsDir: string,
    directVersions: PhiveStackDirectVersions,
    source: string,
    installedAt = new Date().toISOString(),
    healthVerifiedAt: string | null = null,
): PhiveStackManifest {
    const matches = listTrackedJarMatches(jarsDir);
    const resolvedVersions = {} as PhiveStackManifest['resolvedVersions'];
    for (const key of Object.keys(TRACKED_COMPONENT_PATTERNS) as ResolvedComponentKey[]) {
        const files = matches[key];
        if (files.length !== 1) {
            throw new Error(
                files.length === 0
                    ? `Missing tracked PHIVE component jar for ${key}`
                    : `Duplicate tracked PHIVE component jars for ${key}: ${files.join(', ')}`,
            );
        }
        const version = files[0].match(TRACKED_COMPONENT_PATTERNS[key])?.[1];
        if (!version) {
            throw new Error(`Could not parse PHIVE component version from ${files[0]}`);
        }
        resolvedVersions[key] = version;
    }

    return {
        stackId: createStackId(directVersions),
        source,
        installedAt,
        healthVerifiedAt,
        primaryRulesVersion: resolvedVersions.phiveRulesPeppol,
        directVersions,
        resolvedVersions,
    };
}

export function verifyStackJars(jarsDir: string, manifest: PhiveStackManifest): void {
    const matches = listTrackedJarMatches(jarsDir);
    for (const key of Object.keys(TRACKED_COMPONENT_PATTERNS) as ResolvedComponentKey[]) {
        const files = matches[key];
        if (files.length !== 1) {
            throw new Error(
                files.length === 0
                    ? `Active PHIVE stack is missing ${key}`
                    : `Active PHIVE stack has duplicate jars for ${key}: ${files.join(', ')}`,
            );
        }
        const actualVersion = files[0].match(TRACKED_COMPONENT_PATTERNS[key])?.[1];
        const expectedVersion = manifest.resolvedVersions[key];
        if (actualVersion !== expectedVersion) {
            throw new Error(`Active PHIVE stack ${manifest.stackId} expected ${key} ${expectedVersion} but found ${actualVersion}`);
        }
    }
}

export function resolveStackManifest(
    extensionPath: string,
    globalStorageFsPath: string,
    stackId: string,
): { manifest: PhiveStackManifest; jarsDir: string; manifestPath: string } {
    const bundled = readBundledStackManifest(extensionPath);
    if (stackId === bundled.stackId) {
        const jarsDir = getBundledJarsDir(extensionPath);
        verifyStackJars(jarsDir, bundled);
        return {
            manifest: bundled,
            jarsDir,
            manifestPath: getBundledStackManifestPath(extensionPath),
        };
    }

    const manifestPath = getInstalledStackManifestPath(globalStorageFsPath, stackId);
    if (!fs.existsSync(manifestPath)) {
        throw new Error(`PHIVE stack manifest not found for ${stackId}`);
    }
    const manifest = readStackManifestFile(manifestPath);
    const jarsDir = getInstalledStackDir(globalStorageFsPath, stackId);
    verifyStackJars(jarsDir, manifest);
    return { manifest, jarsDir, manifestPath };
}

export function getPhiveStackStatus(extensionPath: string, globalStorageFsPath: string): PhiveStackStatus {
    const state = readPhiveState(extensionPath, globalStorageFsPath);
    const activeStack = resolveStackManifest(extensionPath, globalStorageFsPath, state.activeStackId).manifest;
    const previousStack = state.previousStackId
        ? resolveStackManifest(extensionPath, globalStorageFsPath, state.previousStackId).manifest
        : null;
    return { activeStack, previousStack };
}

export function getActiveJarsDir(extensionPath: string, globalStorageFsPath?: string): string {
    if (!globalStorageFsPath) {
        const bundled = readBundledStackManifest(extensionPath);
        const jarsDir = getBundledJarsDir(extensionPath);
        verifyStackJars(jarsDir, bundled);
        return jarsDir;
    }

    const state = readPhiveState(extensionPath, globalStorageFsPath);
    return resolveStackManifest(extensionPath, globalStorageFsPath, state.activeStackId).jarsDir;
}

export function cleanupInactiveStacks(extensionPath: string, globalStorageFsPath: string): void {
    const state = readPhiveState(extensionPath, globalStorageFsPath);
    const keep = new Set<string>([
        readBundledStackManifest(extensionPath).stackId,
        state.activeStackId,
        ...(state.previousStackId ? [state.previousStackId] : []),
    ]);

    const stacksDir = getPhiveStacksDir(globalStorageFsPath);
    if (fs.existsSync(stacksDir)) {
        for (const entry of fs.readdirSync(stacksDir, { withFileTypes: true })) {
            if (!entry.isDirectory()) {
                continue;
            }
            if (!keep.has(entry.name)) {
                fs.rmSync(path.join(stacksDir, entry.name), { recursive: true, force: true });
            }
        }
    }

    const stagingDir = getPhiveStagingDir(globalStorageFsPath);
    if (fs.existsSync(stagingDir)) {
        for (const entry of fs.readdirSync(stagingDir, { withFileTypes: true })) {
            fs.rmSync(path.join(stagingDir, entry.name), { recursive: true, force: true });
        }
    }
}

export function activateInstalledStack(
    extensionPath: string,
    globalStorageFsPath: string,
    manifest: PhiveStackManifest,
): void {
    const current = readPhiveState(extensionPath, globalStorageFsPath);
    const nextState: PhiveStackState = {
        activeStackId: manifest.stackId,
        previousStackId: current.activeStackId === manifest.stackId ? current.previousStackId : current.activeStackId,
    };
    writePhiveState(globalStorageFsPath, nextState);
    cleanupInactiveStacks(extensionPath, globalStorageFsPath);
}

export function canRollbackPhiveStack(extensionPath: string, globalStorageFsPath: string): boolean {
    return readPhiveState(extensionPath, globalStorageFsPath).previousStackId !== null;
}

export function rollbackPhiveStack(extensionPath: string, globalStorageFsPath: string): PhiveStackManifest {
    const state = readPhiveState(extensionPath, globalStorageFsPath);
    if (!state.previousStackId) {
        throw new Error('No previous PHIVE stack is available for rollback.');
    }

    const previous = resolveStackManifest(extensionPath, globalStorageFsPath, state.previousStackId).manifest;
    const failedActive = state.activeStackId;
    writePhiveState(globalStorageFsPath, {
        activeStackId: state.previousStackId,
        previousStackId: null,
    });

    const bundled = readBundledStackManifest(extensionPath);
    if (failedActive !== bundled.stackId) {
        fs.rmSync(getInstalledStackDir(globalStorageFsPath, failedActive), { recursive: true, force: true });
    }
    cleanupInactiveStacks(extensionPath, globalStorageFsPath);
    return previous;
}
