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
    verifyStackJars,
    writePhiveState,
    writeStackManifestFile,
} from '../validation/phiveStackRuntime';

function makeTempDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'xml-xslt-phive-'));
}

const bundledVersions = { ddd: '0.8.5', phive: '12.0.3', rules: '4.3.0' };
const updatedBundledVersions = { ddd: '0.8.6', phive: '12.0.4', rules: '4.3.1' };
const installedVersions = { ddd: '0.8.7', phive: '12.0.5', rules: '4.3.2' };

function writeTrackedJars(
    dir: string,
    versions: { ddd: string; phive: string; rules: string },
    options: { resultHtmlVersions?: string[] } = {},
): void {
    fs.mkdirSync(dir, { recursive: true });
    const jarNames = [
        `ddd-${versions.ddd}.jar`,
        `phive-api-${versions.phive}.jar`,
        `phive-xml-${versions.phive}.jar`,
        `phive-rules-api-${versions.rules}.jar`,
        `phive-rules-en16931-${versions.rules}.jar`,
        `phive-rules-peppol-${versions.rules}.jar`,
        'jaxb-runtime-4.0.5.jar',
    ];
    for (const jarName of jarNames) {
        fs.writeFileSync(path.join(dir, jarName), '');
    }
    for (const resultHtmlVersion of options.resultHtmlVersions ?? []) {
        fs.writeFileSync(path.join(dir, `phive-result-html-${resultHtmlVersion}.jar`), '');
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
        expect(manifest.resolvedVersions.jaxbRuntime).toBe('4.0.5');
        expect(manifest.primaryRulesVersion).toBe('4.3.0');
    });

    it('builds a manifest with optional phive-result-html when present', () => {
        const root = makeTempDir();
        const jarsDir = path.join(root, 'jars');
        writeTrackedJars(jarsDir, bundledVersions, { resultHtmlVersions: [bundledVersions.phive] });

        const manifest = buildStackManifestFromJars(jarsDir, bundledVersions, 'github-release');

        expect(manifest.resolvedVersions.phiveResultHtml).toBe('12.0.3');
    });

    it('verifies a legacy manifest without phive-result-html', () => {
        const root = makeTempDir();
        const jarsDir = path.join(root, 'jars');
        writeTrackedJars(jarsDir, bundledVersions);
        const manifest = buildStackManifestFromJars(jarsDir, bundledVersions, 'bundled');

        expect(() => verifyStackJars(jarsDir, manifest)).not.toThrow();
    });

    it('verifies a legacy manifest when an undeclared phive-result-html jar is present', () => {
        const root = makeTempDir();
        const jarsDir = path.join(root, 'jars');
        writeTrackedJars(jarsDir, bundledVersions);
        const manifest = buildStackManifestFromJars(jarsDir, bundledVersions, 'bundled');

        delete manifest.resolvedVersions.phiveResultHtml;
        fs.writeFileSync(path.join(jarsDir, `phive-result-html-${bundledVersions.phive}.jar`), '');

        expect(() => verifyStackJars(jarsDir, manifest)).not.toThrow();
    });

    it('rejects an undeclared phive-result-html jar that does not match the phive version', () => {
        const root = makeTempDir();
        const jarsDir = path.join(root, 'jars');
        writeTrackedJars(jarsDir, bundledVersions);
        const manifest = buildStackManifestFromJars(jarsDir, bundledVersions, 'bundled');

        delete manifest.resolvedVersions.phiveResultHtml;
        fs.writeFileSync(path.join(jarsDir, 'phive-result-html-12.0.4.jar'), '');

        expect(() => verifyStackJars(jarsDir, manifest)).toThrow(
            'has undeclared phiveResultHtml 12.0.4; expected 12.0.3',
        );
    });

    it('requires jaxb-runtime because DDD needs it at runtime', () => {
        const root = makeTempDir();
        const jarsDir = path.join(root, 'jars');
        writeTrackedJars(jarsDir, bundledVersions);
        const manifest = buildStackManifestFromJars(jarsDir, bundledVersions, 'bundled');
        fs.rmSync(path.join(jarsDir, 'jaxb-runtime-4.0.5.jar'));

        expect(() => verifyStackJars(jarsDir, manifest)).toThrow(
            'Active PHIVE stack is missing jaxbRuntime',
        );
    });

    it('verifies the bundled manifest against the local bundled jars', () => {
        const extensionPath = path.resolve(__dirname, '..', '..');
        const manifestPath = path.join(extensionPath, 'lib', 'phive-stack.json');
        const jarsDir = path.join(extensionPath, 'lib', 'phive-jars');

        expect(fs.existsSync(manifestPath)).toBe(true);
        expect(fs.existsSync(jarsDir)).toBe(true);
        expect(() => getActiveJarsDir(extensionPath)).not.toThrow();
    });

    it('requires phive-result-html when the manifest declares it', () => {
        const root = makeTempDir();
        const jarsDir = path.join(root, 'jars');
        writeTrackedJars(jarsDir, bundledVersions, { resultHtmlVersions: [bundledVersions.phive] });
        const manifest = buildStackManifestFromJars(jarsDir, bundledVersions, 'bundled');
        fs.rmSync(path.join(jarsDir, `phive-result-html-${bundledVersions.phive}.jar`));

        expect(() => verifyStackJars(jarsDir, manifest)).toThrow(
            'Active PHIVE stack is missing phiveResultHtml',
        );
    });

    it('rejects a wrong-version phive-result-html jar when the manifest declares it', () => {
        const root = makeTempDir();
        const jarsDir = path.join(root, 'jars');
        writeTrackedJars(jarsDir, bundledVersions, { resultHtmlVersions: [bundledVersions.phive] });
        const manifest = buildStackManifestFromJars(jarsDir, bundledVersions, 'bundled');
        fs.rmSync(path.join(jarsDir, `phive-result-html-${bundledVersions.phive}.jar`));
        fs.writeFileSync(path.join(jarsDir, 'phive-result-html-12.0.4.jar'), '');

        expect(() => verifyStackJars(jarsDir, manifest)).toThrow(
            'expected phiveResultHtml 12.0.3 but found 12.0.4',
        );
    });

    it('rejects duplicate phive-result-html jars when building a manifest', () => {
        const root = makeTempDir();
        const jarsDir = path.join(root, 'jars');
        writeTrackedJars(jarsDir, bundledVersions, { resultHtmlVersions: [bundledVersions.phive, '12.0.4'] });

        expect(() => buildStackManifestFromJars(jarsDir, bundledVersions, 'github-release')).toThrow(
            'Duplicate tracked PHIVE component jars for phiveResultHtml',
        );
    });

    it('rejects duplicate phive-result-html jars when verifying a manifest', () => {
        const root = makeTempDir();
        const jarsDir = path.join(root, 'jars');
        writeTrackedJars(jarsDir, bundledVersions, { resultHtmlVersions: [bundledVersions.phive] });
        const manifest = buildStackManifestFromJars(jarsDir, bundledVersions, 'bundled');
        fs.writeFileSync(path.join(jarsDir, 'phive-result-html-12.0.4.jar'), '');

        expect(() => verifyStackJars(jarsDir, manifest)).toThrow(
            'Active PHIVE stack has duplicate jars for phiveResultHtml',
        );
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
