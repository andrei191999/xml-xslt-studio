import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    activateInstalledStack,
    buildStackManifestFromJars,
    canRollbackPhiveStack,
    createStackId,
    getActiveJarsDir,
    getInstalledStackDir,
    getInstalledStackManifestPath,
    getPhiveStackStatus,
    readPhiveState,
    rollbackPhiveStack,
    writePhiveState,
    writeStackManifestFile,
} from '../validation/phiveStackRuntime';

function makeTempDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'xml-xslt-phive-'));
}

const bundledVersions = { ddd: '0.8.5', phive: '12.0.3', rules: '4.3.0' };
const updatedBundledVersions = { ddd: '0.8.6', phive: '12.0.4', rules: '4.3.1' };
const installedVersions = { ddd: '0.8.7', phive: '12.0.5', rules: '4.3.2' };

function writeTrackedJars(dir: string, versions: { ddd: string; phive: string; rules: string }): void {
    fs.mkdirSync(dir, { recursive: true });
    const jarNames = [
        `ddd-${versions.ddd}.jar`,
        `phive-api-${versions.phive}.jar`,
        `phive-xml-${versions.phive}.jar`,
        `phive-rules-api-${versions.rules}.jar`,
        `phive-rules-en16931-${versions.rules}.jar`,
        `phive-rules-peppol-${versions.rules}.jar`,
    ];
    for (const jarName of jarNames) {
        fs.writeFileSync(path.join(dir, jarName), '');
    }
}

function createBundledStack(root: string, versions = bundledVersions) {
    const extensionPath = path.join(root, 'extension');
    const jarsDir = path.join(extensionPath, 'lib', 'phive-jars');
    writeTrackedJars(jarsDir, versions);
    fs.writeFileSync(path.join(extensionPath, 'package.json'), JSON.stringify({ version: '0.1.0' }), 'utf8');
    const manifest = buildStackManifestFromJars(jarsDir, versions, 'bundled', '2026-04-21T00:00:00.000Z', '2026-04-21T00:00:00.000Z');
    writeStackManifestFile(path.join(extensionPath, 'lib', 'phive-stack.json'), manifest);
    return { extensionPath, manifest };
}

afterEach(() => {
    jest.restoreAllMocks();
});

describe('phiveStackRuntime', () => {
    it('builds a manifest from tracked jars', () => {
        const root = makeTempDir();
        const jarsDir = path.join(root, 'jars');
        writeTrackedJars(jarsDir, bundledVersions);

        const manifest = buildStackManifestFromJars(jarsDir, bundledVersions, 'github-release');

        expect(manifest.stackId).toBe(createStackId(bundledVersions));
        expect(manifest.resolvedVersions.phiveRulesPeppol).toBe('4.3.0');
        expect(manifest.primaryRulesVersion).toBe('4.3.0');
    });

    it('resolves the bundled stack as active by default', () => {
        const root = makeTempDir();
        const { extensionPath, manifest } = createBundledStack(root);
        const globalStorage = path.join(root, 'storage');

        expect(getActiveJarsDir(extensionPath, globalStorage)).toBe(path.join(extensionPath, 'lib', 'phive-jars'));
        expect(getPhiveStackStatus(extensionPath, globalStorage).activeStack.stackId).toBe(manifest.stackId);
    });

    it('activates a new stack and keeps one rollback slot', () => {
        const root = makeTempDir();
        const { extensionPath, manifest: bundled } = createBundledStack(root);
        const globalStorage = path.join(root, 'storage');
        const stackDir = getInstalledStackDir(globalStorage, createStackId(installedVersions));
        writeTrackedJars(stackDir, installedVersions);
        const updateManifest = buildStackManifestFromJars(stackDir, installedVersions, 'github-release');
        writeStackManifestFile(getInstalledStackManifestPath(globalStorage, updateManifest.stackId), updateManifest);

        activateInstalledStack(extensionPath, globalStorage, updateManifest);

        const status = getPhiveStackStatus(extensionPath, globalStorage);
        expect(status.activeStack.stackId).toBe(updateManifest.stackId);
        expect(status.previousStack?.stackId).toBe(bundled.stackId);
        expect(canRollbackPhiveStack(extensionPath, globalStorage)).toBe(true);
    });

    it('rolls back to the previous stack and removes the failed newer stack', () => {
        const root = makeTempDir();
        const { extensionPath, manifest: bundled } = createBundledStack(root);
        const globalStorage = path.join(root, 'storage');
        const stackDir = getInstalledStackDir(globalStorage, createStackId(installedVersions));
        writeTrackedJars(stackDir, installedVersions);
        const updateManifest = buildStackManifestFromJars(stackDir, installedVersions, 'github-release');
        writeStackManifestFile(getInstalledStackManifestPath(globalStorage, updateManifest.stackId), updateManifest);
        activateInstalledStack(extensionPath, globalStorage, updateManifest);

        const restored = rollbackPhiveStack(extensionPath, globalStorage);

        expect(restored.stackId).toBe(bundled.stackId);
        expect(getPhiveStackStatus(extensionPath, globalStorage).activeStack.stackId).toBe(bundled.stackId);
        expect(canRollbackPhiveStack(extensionPath, globalStorage)).toBe(false);
        expect(fs.existsSync(stackDir)).toBe(false);
    });

    it('normalizes stale bundled stack IDs after the bundled baseline changes', () => {
        const root = makeTempDir();
        const { extensionPath } = createBundledStack(root, updatedBundledVersions);
        const globalStorage = path.join(root, 'storage');
        writePhiveState(globalStorage, {
            activeStackId: createStackId(bundledVersions),
            previousStackId: createStackId(bundledVersions),
        });

        const state = readPhiveState(extensionPath, globalStorage);

        expect(state.activeStackId).toBe(createStackId(updatedBundledVersions));
        expect(state.previousStackId).toBeNull();
    });

    it('keeps an installed stack authoritative when it still exists', () => {
        const root = makeTempDir();
        const { extensionPath } = createBundledStack(root, updatedBundledVersions);
        const globalStorage = path.join(root, 'storage');
        const installedStackId = createStackId(bundledVersions);
        const stackDir = getInstalledStackDir(globalStorage, installedStackId);
        writeTrackedJars(stackDir, bundledVersions);
        const manifest = buildStackManifestFromJars(stackDir, bundledVersions, 'github-release');
        writeStackManifestFile(getInstalledStackManifestPath(globalStorage, installedStackId), manifest);
        writePhiveState(globalStorage, {
            activeStackId: installedStackId,
            previousStackId: null,
        });

        const status = getPhiveStackStatus(extensionPath, globalStorage);

        expect(status.activeStack.stackId).toBe(installedStackId);
        expect(getActiveJarsDir(extensionPath, globalStorage)).toBe(stackDir);
    });

    it('rejects duplicate tracked component jars', () => {
        const root = makeTempDir();
        const jarsDir = path.join(root, 'jars');
        writeTrackedJars(jarsDir, bundledVersions);
        fs.writeFileSync(path.join(jarsDir, 'ddd-0.8.4.jar'), '');

        expect(() => buildStackManifestFromJars(
            jarsDir,
            bundledVersions,
            'github-release',
        )).toThrow('Duplicate tracked PHIVE component jars for ddd');
    });
});
