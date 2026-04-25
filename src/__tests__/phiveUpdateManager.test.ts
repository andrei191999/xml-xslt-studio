import { EventEmitter } from 'events';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import { Writable } from 'stream';
import type { ChildProcess } from 'child_process';

jest.mock('child_process', () => ({ spawn: jest.fn() }));
jest.mock('../utils/javaRunner', () => ({
    ensureJava: jest.fn().mockResolvedValue(undefined),
}));

import { spawn } from 'child_process';
import { extractZipToDirectory } from '../validation/phiveBundleZip';
import {
    hasRecordedCheckFailure,
    PhiveUpdateManager,
    resolveRecordedCheckStatus,
} from '../validation/PhiveUpdateManager';
import {
    activateInstalledStack,
    buildStackManifestFromJars,
    createStackId,
    getInstalledStackDir,
    getPhiveStackStatus,
    writeStackManifestFile,
} from '../validation/phiveStackRuntime';

const ZIP_LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const ZIP_CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const CRC32_TABLE = buildCrc32Table();
const mockSpawn = spawn as jest.MockedFunction<typeof spawn>;

function buildCrc32Table(): Uint32Array {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
        let c = n;
        for (let k = 0; k < 8; k += 1) {
            c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        }
        table[n] = c >>> 0;
    }
    return table;
}

function crc32(buffer: Buffer): number {
    let crc = 0xffffffff;
    for (const byte of buffer) {
        crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function makeTempDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'xml-xslt-phive-manager-'));
}

interface MockProcess {
    proc: ChildProcess;
    stderr: EventEmitter;
    stdout: EventEmitter;
    stdinWrites: string[];
    emitClose: () => void;
    emitError: (error: Error) => void;
    emitLine: (json: string) => void;
    emitReady: () => void;
}

function makeMockProcess(): MockProcess {
    const stdinWrites: string[] = [];
    const stdin = new Writable({
        write(chunk: Buffer, _encoding: string, callback: () => void) {
            stdinWrites.push(chunk.toString('utf8'));
            callback();
        },
    });
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const proc = Object.assign(
        new EventEmitter(),
        { kill: jest.fn(), stdin, stderr, stdout },
    ) as unknown as ChildProcess;

    return {
        proc,
        stderr,
        stdout,
        stdinWrites,
        emitClose: () => proc.emit('close', 0),
        emitError: (error: Error) => proc.emit('error', error),
        emitLine: (json: string) => stdout.emit('data', Buffer.from(json + '\n')),
        emitReady: () => stderr.emit('data', Buffer.from('[PhiveRunner] daemon ready\n')),
    };
}

afterEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
});

const bundledVersions = { ddd: '0.8.5', phive: '12.0.3', rules: '4.3.0' };
const updateVersions = { ddd: '0.8.6', phive: '12.0.4', rules: '4.3.1' };
const newerVersions = { ddd: '0.8.7', phive: '12.0.5', rules: '4.3.2' };

function writeTrackedJars(dir: string, versions: { ddd: string; phive: string; rules: string }): void {
    fs.mkdirSync(dir, { recursive: true });
    for (const jarName of [
        `ddd-${versions.ddd}.jar`,
        `phive-api-${versions.phive}.jar`,
        `phive-xml-${versions.phive}.jar`,
        `phive-rules-api-${versions.rules}.jar`,
        `phive-rules-en16931-${versions.rules}.jar`,
        `phive-rules-peppol-${versions.rules}.jar`,
    ]) {
        fs.writeFileSync(path.join(dir, jarName), '');
    }
}

function createBundledStack(root: string) {
    const extensionPath = path.join(root, 'extension');
    const jarsDir = path.join(extensionPath, 'lib', 'phive-jars');
    writeTrackedJars(jarsDir, bundledVersions);
    const manifest = buildStackManifestFromJars(jarsDir, bundledVersions, 'bundled');
    writeStackManifestFile(path.join(extensionPath, 'lib', 'phive-stack.json'), manifest);
    fs.mkdirSync(path.join(extensionPath, 'validation-artifacts', 'phive-smoke'), { recursive: true });
    fs.writeFileSync(path.join(extensionPath, 'validation-artifacts', 'phive-smoke', 'invoice.xml'), '<Invoice/>');
    fs.writeFileSync(path.join(extensionPath, 'validation-artifacts', 'phive-smoke', 'credit-note.xml'), '<CreditNote/>');
    fs.writeFileSync(path.join(extensionPath, 'package.json'), JSON.stringify({ version: '0.1.0' }), 'utf8');
    return extensionPath;
}

function createStoredZip(entries: Array<{ name: string; data: Buffer | string; externalAttributes?: number }>): Buffer {
    const dosTime = 0;
    const dosDate = 0x5a21;
    const localParts: Buffer[] = [];
    const centralParts: Buffer[] = [];
    let offset = 0;

    for (const entry of entries) {
        const fileName = Buffer.from(entry.name, 'utf8');
        const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
        const checksum = crc32(data);
        const localHeader = Buffer.alloc(30 + fileName.length);
        localHeader.writeUInt32LE(ZIP_LOCAL_FILE_HEADER_SIGNATURE, 0);
        localHeader.writeUInt16LE(20, 4);
        localHeader.writeUInt16LE(0, 6);
        localHeader.writeUInt16LE(0, 8);
        localHeader.writeUInt16LE(dosTime, 10);
        localHeader.writeUInt16LE(dosDate, 12);
        localHeader.writeUInt32LE(checksum, 14);
        localHeader.writeUInt32LE(data.length, 18);
        localHeader.writeUInt32LE(data.length, 22);
        localHeader.writeUInt16LE(fileName.length, 26);
        localHeader.writeUInt16LE(0, 28);
        fileName.copy(localHeader, 30);
        localParts.push(localHeader, data);

        const centralHeader = Buffer.alloc(46 + fileName.length);
        centralHeader.writeUInt32LE(ZIP_CENTRAL_DIRECTORY_SIGNATURE, 0);
        centralHeader.writeUInt16LE((3 << 8) | 20, 4);
        centralHeader.writeUInt16LE(20, 6);
        centralHeader.writeUInt16LE(0, 8);
        centralHeader.writeUInt16LE(0, 10);
        centralHeader.writeUInt16LE(dosTime, 12);
        centralHeader.writeUInt16LE(dosDate, 14);
        centralHeader.writeUInt32LE(checksum, 16);
        centralHeader.writeUInt32LE(data.length, 20);
        centralHeader.writeUInt32LE(data.length, 24);
        centralHeader.writeUInt16LE(fileName.length, 28);
        centralHeader.writeUInt16LE(0, 30);
        centralHeader.writeUInt16LE(0, 32);
        centralHeader.writeUInt16LE(0, 34);
        centralHeader.writeUInt16LE(0, 36);
        centralHeader.writeUInt32LE(entry.externalAttributes ?? ((0o100644 << 16) >>> 0), 38);
        centralHeader.writeUInt32LE(offset, 42);
        fileName.copy(centralHeader, 46);
        centralParts.push(centralHeader);

        offset += localHeader.length + data.length;
    }

    const centralDirectory = Buffer.concat(centralParts);
    const endRecord = Buffer.alloc(22);
    endRecord.writeUInt32LE(ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE, 0);
    endRecord.writeUInt16LE(0, 4);
    endRecord.writeUInt16LE(0, 6);
    endRecord.writeUInt16LE(entries.length, 8);
    endRecord.writeUInt16LE(entries.length, 10);
    endRecord.writeUInt32LE(centralDirectory.length, 12);
    endRecord.writeUInt32LE(offset, 16);
    endRecord.writeUInt16LE(0, 20);

    return Buffer.concat([...localParts, centralDirectory, endRecord]);
}

type TestZipEntry = {
    name: string;
    data: Buffer | string;
    compressionMethod?: 0 | 8;
    externalAttributes?: number;
    centralCompressedSize?: number;
    centralCrc32?: number;
    centralFileName?: string;
    centralFlags?: number;
    centralUncompressedSize?: number;
    localCompressedSize?: number;
    localCrc32?: number;
    localFileName?: string;
    localFlags?: number;
    localUncompressedSize?: number;
};

function createZipForTest(entries: TestZipEntry[]): Buffer {
    const dosTime = 0;
    const dosDate = 0x5a21;
    const localParts: Buffer[] = [];
    const centralParts: Buffer[] = [];
    let offset = 0;

    for (const entry of entries) {
        const rawData = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
        const compressionMethod = entry.compressionMethod ?? 0;
        const compressedData = compressionMethod === 8
            ? zlib.deflateRawSync(rawData, { level: 9 })
            : rawData;
        const checksum = crc32(rawData);
        const localFileName = Buffer.from(entry.localFileName ?? entry.name, 'utf8');
        const centralFileName = Buffer.from(entry.centralFileName ?? entry.name, 'utf8');
        const localCompressedSize = entry.localCompressedSize ?? compressedData.length;
        const centralCompressedSize = entry.centralCompressedSize ?? compressedData.length;
        const localUncompressedSize = entry.localUncompressedSize ?? rawData.length;
        const centralUncompressedSize = entry.centralUncompressedSize ?? rawData.length;
        const localFlags = entry.localFlags ?? 0;
        const centralFlags = entry.centralFlags ?? localFlags;
        const localChecksum = entry.localCrc32 ?? checksum;
        const centralChecksum = entry.centralCrc32 ?? checksum;

        const localHeader = Buffer.alloc(30 + localFileName.length);
        localHeader.writeUInt32LE(ZIP_LOCAL_FILE_HEADER_SIGNATURE, 0);
        localHeader.writeUInt16LE(20, 4);
        localHeader.writeUInt16LE(localFlags, 6);
        localHeader.writeUInt16LE(compressionMethod, 8);
        localHeader.writeUInt16LE(dosTime, 10);
        localHeader.writeUInt16LE(dosDate, 12);
        localHeader.writeUInt32LE(localChecksum, 14);
        localHeader.writeUInt32LE(localCompressedSize, 18);
        localHeader.writeUInt32LE(localUncompressedSize, 22);
        localHeader.writeUInt16LE(localFileName.length, 26);
        localHeader.writeUInt16LE(0, 28);
        localFileName.copy(localHeader, 30);
        localParts.push(localHeader, compressedData);

        const centralHeader = Buffer.alloc(46 + centralFileName.length);
        centralHeader.writeUInt32LE(ZIP_CENTRAL_DIRECTORY_SIGNATURE, 0);
        centralHeader.writeUInt16LE((3 << 8) | 20, 4);
        centralHeader.writeUInt16LE(20, 6);
        centralHeader.writeUInt16LE(centralFlags, 8);
        centralHeader.writeUInt16LE(compressionMethod, 10);
        centralHeader.writeUInt16LE(dosTime, 12);
        centralHeader.writeUInt16LE(dosDate, 14);
        centralHeader.writeUInt32LE(centralChecksum, 16);
        centralHeader.writeUInt32LE(centralCompressedSize, 20);
        centralHeader.writeUInt32LE(centralUncompressedSize, 24);
        centralHeader.writeUInt16LE(centralFileName.length, 28);
        centralHeader.writeUInt16LE(0, 30);
        centralHeader.writeUInt16LE(0, 32);
        centralHeader.writeUInt16LE(0, 34);
        centralHeader.writeUInt16LE(0, 36);
        centralHeader.writeUInt32LE(entry.externalAttributes ?? ((0o100644 << 16) >>> 0), 38);
        centralHeader.writeUInt32LE(offset, 42);
        centralFileName.copy(centralHeader, 46);
        centralParts.push(centralHeader);

        offset += localHeader.length + compressedData.length;
    }

    const centralDirectory = Buffer.concat(centralParts);
    const endRecord = Buffer.alloc(22);
    endRecord.writeUInt32LE(ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE, 0);
    endRecord.writeUInt16LE(0, 4);
    endRecord.writeUInt16LE(0, 6);
    endRecord.writeUInt16LE(entries.length, 8);
    endRecord.writeUInt16LE(entries.length, 10);
    endRecord.writeUInt32LE(centralDirectory.length, 12);
    endRecord.writeUInt32LE(offset, 16);
    endRecord.writeUInt16LE(0, 20);

    return Buffer.concat([...localParts, centralDirectory, endRecord]);
}

function createBundleZip(
    versions: { ddd: string; phive: string; rules: string },
    entryMutator?: (entries: Array<{ name: string; data: Buffer | string; externalAttributes?: number }>) => void,
): { manifest: ReturnType<typeof buildBundleManifest>; zipBytes: Buffer } {
    const manifest = buildBundleManifest(versions);
    const entries = [
        { name: `ddd-${versions.ddd}.jar`, data: '' },
        { name: `phive-api-${versions.phive}.jar`, data: '' },
        { name: `phive-xml-${versions.phive}.jar`, data: '' },
        { name: `phive-rules-api-${versions.rules}.jar`, data: '' },
        { name: `phive-rules-en16931-${versions.rules}.jar`, data: '' },
        { name: `phive-rules-peppol-${versions.rules}.jar`, data: '' },
        { name: 'manifest.json', data: JSON.stringify(manifest, null, 2) },
    ];
    entryMutator?.(entries);
    return {
        manifest,
        zipBytes: createStoredZip(entries),
    };
}

function buildBundleManifest(versions: { ddd: string; phive: string; rules: string }) {
    return {
        stackId: createStackId(versions),
        source: 'github-release',
        installedAt: '2026-04-21T00:00:00.000Z',
        healthVerifiedAt: '2026-04-21T00:00:00.000Z',
        primaryRulesVersion: versions.rules,
        directVersions: versions,
        resolvedVersions: {
            ddd: versions.ddd,
            phiveApi: versions.phive,
            phiveXml: versions.phive,
            phiveRulesApi: versions.rules,
            phiveRulesEn16931: versions.rules,
            phiveRulesPeppol: versions.rules,
        },
    };
}

function createCandidate(
    versions: { ddd: string; phive: string; rules: string },
    zipBytes: Buffer,
    overrides: Partial<{
        minimumExtensionVersion: string;
        minimumJavaMajor: number;
        publishedAt: string;
        sha256: string;
        sizeBytes: number;
    }> = {},
) {
    const stackId = createStackId(versions);
    return {
        stackId,
        publishedAt: overrides.publishedAt ?? '2026-04-21T00:00:00.000Z',
        source: 'github-release',
        directVersions: versions,
        minimumExtensionVersion: overrides.minimumExtensionVersion ?? '0.1.0',
        minimumJavaMajor: overrides.minimumJavaMajor ?? 17,
        bundle: {
            assetName: `phive-stack-${stackId}.zip`,
            url: `https://example.invalid/${stackId}.zip`,
            sizeBytes: overrides.sizeBytes ?? zipBytes.length,
            sha256: overrides.sha256 ?? crypto.createHash('sha256').update(zipBytes).digest('hex'),
        },
    };
}

function curatedFeed(stacks: unknown[]): string {
    return JSON.stringify({
        schemaVersion: 1,
        generatedAt: '2026-04-21T00:00:00.000Z',
        channel: 'stable',
        stacks,
    });
}

describe('PhiveUpdateManager', () => {
    it('selects the latest compatible candidate from the curated feed', async () => {
        const root = makeTempDir();
        const extensionPath = createBundledStack(root);
        const storagePath = path.join(root, 'storage');
        const { zipBytes: blockedBytes } = createBundleZip(newerVersions);
        const { zipBytes: updateBytes } = createBundleZip(updateVersions);
        const blockedCandidate = createCandidate(newerVersions, blockedBytes, {
            minimumExtensionVersion: '0.2.0',
            minimumJavaMajor: 21,
        });
        const compatibleCandidate = createCandidate(updateVersions, updateBytes);

        const manager = new PhiveUpdateManager(storagePath, extensionPath, undefined, {
            currentExtensionVersion: '0.1.0',
            detectJavaMajor: async () => 17,
            fetchText: async () => curatedFeed([blockedCandidate, compatibleCandidate]),
        });

        const result = await manager.checkForUpdates();

        expect(result.status).toBe('update-available');
        expect(result.candidate?.stackId).toBe(compatibleCandidate.stackId);
    });

    it('retains the last successful candidate snapshot on disk but hides it from the failed-check UI state', () => {
        const root = makeTempDir();
        const extensionPath = createBundledStack(root);
        const storagePath = path.join(root, 'storage');
        const { zipBytes } = createBundleZip(updateVersions);
        const candidate = createCandidate(updateVersions, zipBytes);
        const manager = new PhiveUpdateManager(storagePath, extensionPath, undefined, {
            currentExtensionVersion: '0.1.0',
            detectJavaMajor: async () => 17,
        });

        manager.recordSuccessfulCheck(candidate);
        const checkedAt = manager.getLastCheckInfo()?.checkedAt;
        manager.recordFailedCheck(new Error('network'));

        expect(manager.getLastCheckInfo()).toEqual({
            checkedAt,
            candidate,
            errorAt: expect.any(String),
            errorMessage: 'network',
        });
        expect(hasRecordedCheckFailure(manager.getLastCheckInfo())).toBe(true);
        expect(resolveRecordedCheckStatus(manager.getLastCheckInfo(), createStackId(bundledVersions))).toEqual({
            updateState: 'check-failed',
            errorMessage: 'network',
        });
    });

    it('installs a curated bundle, activates it, and restarts the runtime callback', async () => {
        const root = makeTempDir();
        const extensionPath = createBundledStack(root);
        const storagePath = path.join(root, 'storage');
        const activated: string[] = [];
        const { zipBytes } = createBundleZip(updateVersions);
        const candidate = createCandidate(updateVersions, zipBytes);
        const manager = new PhiveUpdateManager(storagePath, extensionPath, async (jarsDir) => {
            activated.push(jarsDir);
        }, {
            currentExtensionVersion: '0.1.0',
            detectJavaMajor: async () => 17,
            downloadUrl: async () => zipBytes,
        });

        (manager as any).runHealthCheck = jest.fn().mockResolvedValue(undefined);

        const installed = await manager.installUpdate({ report: () => undefined }, candidate);

        expect(installed.primaryRulesVersion).toBe('4.3.1');
        expect(getPhiveStackStatus(extensionPath, storagePath).activeStack.stackId).toBe(candidate.stackId);
        expect(activated).toEqual([getInstalledStackDir(storagePath, candidate.stackId)]);
    });

    it('keeps the current stack active when staged health verification fails', async () => {
        const root = makeTempDir();
        const extensionPath = createBundledStack(root);
        const storagePath = path.join(root, 'storage');
        const { zipBytes } = createBundleZip(updateVersions);
        const candidate = createCandidate(updateVersions, zipBytes);
        const manager = new PhiveUpdateManager(storagePath, extensionPath, async () => undefined, {
            currentExtensionVersion: '0.1.0',
            detectJavaMajor: async () => 17,
            downloadUrl: async () => zipBytes,
        });

        (manager as any).runHealthCheck = jest.fn().mockRejectedValue(new Error('boom'));

        await expect(manager.installUpdate({ report: () => undefined }, candidate)).rejects.toThrow('boom');
        expect(getPhiveStackStatus(extensionPath, storagePath).activeStack.primaryRulesVersion).toBe('4.3.0');
        expect(fs.existsSync(getInstalledStackDir(storagePath, candidate.stackId))).toBe(false);
    });

    it('restores the previous active stack when restartRuntime fails after activation', async () => {
        const root = makeTempDir();
        const extensionPath = createBundledStack(root);
        const storagePath = path.join(root, 'storage');
        const restarted: string[] = [];
        const { zipBytes } = createBundleZip(updateVersions);
        const candidate = createCandidate(updateVersions, zipBytes);
        let restartAttempt = 0;
        const manager = new PhiveUpdateManager(storagePath, extensionPath, async (jarsDir) => {
            restarted.push(jarsDir);
            restartAttempt += 1;
            if (restartAttempt === 1) {
                throw new Error('restart boom');
            }
        }, {
            currentExtensionVersion: '0.1.0',
            detectJavaMajor: async () => 17,
            downloadUrl: async () => zipBytes,
        });

        (manager as any).runHealthCheck = jest.fn().mockResolvedValue(undefined);

        await expect(manager.installUpdate({ report: () => undefined }, candidate)).rejects.toThrow('restart boom');
        expect(restarted).toEqual([
            getInstalledStackDir(storagePath, candidate.stackId),
            path.join(extensionPath, 'lib', 'phive-jars'),
        ]);
        expect(getPhiveStackStatus(extensionPath, storagePath).activeStack.stackId).toBe(createStackId(bundledVersions));
        expect(fs.existsSync(getInstalledStackDir(storagePath, candidate.stackId))).toBe(false);
    });

    it('rolls back to the previous stack and restarts the runtime callback', async () => {
        const root = makeTempDir();
        const extensionPath = createBundledStack(root);
        const storagePath = path.join(root, 'storage');
        const activated: string[] = [];
        const manager = new PhiveUpdateManager(storagePath, extensionPath, async (jarsDir) => {
            activated.push(jarsDir);
        }, {
            currentExtensionVersion: '0.1.0',
            detectJavaMajor: async () => 17,
        });
        const stackDir = getInstalledStackDir(storagePath, createStackId(updateVersions));
        writeTrackedJars(stackDir, updateVersions);
        const updateManifest = buildStackManifestFromJars(stackDir, updateVersions, 'github-release');
        writeStackManifestFile(path.join(stackDir, 'manifest.json'), updateManifest);
        activateInstalledStack(extensionPath, storagePath, updateManifest);

        const restored = await manager.rollbackActiveStack();

        expect(restored.primaryRulesVersion).toBe('4.3.0');
        expect(getPhiveStackStatus(extensionPath, storagePath).activeStack.primaryRulesVersion).toBe('4.3.0');
        expect(activated[0]).toBe(path.join(extensionPath, 'lib', 'phive-jars'));
    });

    it('reports no-compatible-update when only blocked curated stacks are newer', async () => {
        const root = makeTempDir();
        const extensionPath = createBundledStack(root);
        const storagePath = path.join(root, 'storage');
        const { zipBytes: blockedBytes } = createBundleZip(newerVersions);
        const blockedCandidate = createCandidate(newerVersions, blockedBytes, {
            minimumExtensionVersion: '0.2.0',
            minimumJavaMajor: 21,
            publishedAt: '2026-04-22T00:00:00.000Z',
        });
        const bundledCandidate = createCandidate(bundledVersions, blockedBytes);
        const manager = new PhiveUpdateManager(storagePath, extensionPath, undefined, {
            currentExtensionVersion: '0.1.0',
            detectJavaMajor: async () => 17,
            fetchText: async () => curatedFeed([{ ...blockedCandidate }, { ...bundledCandidate, stackId: createStackId(bundledVersions), directVersions: bundledVersions }]),
        });

        const result = await manager.checkForUpdates();

        expect(result).toEqual(expect.objectContaining({ status: 'no-compatible-update' }));
    });

    it('rejects bundle downloads with a SHA mismatch', async () => {
        const root = makeTempDir();
        const extensionPath = createBundledStack(root);
        const storagePath = path.join(root, 'storage');
        const { zipBytes } = createBundleZip(updateVersions);
        const candidate = createCandidate(updateVersions, zipBytes, { sha256: '0'.repeat(64) });
        const manager = new PhiveUpdateManager(storagePath, extensionPath, undefined, {
            currentExtensionVersion: '0.1.0',
            detectJavaMajor: async () => 17,
            downloadUrl: async () => zipBytes,
        });

        await expect(manager.installUpdate({ report: () => undefined }, candidate)).rejects.toThrow('SHA-256 mismatch');
    });

    it('rejects bundle downloads with a size mismatch', async () => {
        const root = makeTempDir();
        const extensionPath = createBundledStack(root);
        const storagePath = path.join(root, 'storage');
        const { zipBytes } = createBundleZip(updateVersions);
        const candidate = createCandidate(updateVersions, zipBytes, { sizeBytes: zipBytes.length + 1 });
        const manager = new PhiveUpdateManager(storagePath, extensionPath, undefined, {
            currentExtensionVersion: '0.1.0',
            detectJavaMajor: async () => 17,
            downloadUrl: async () => zipBytes,
        });

        await expect(manager.installUpdate({ report: () => undefined }, candidate)).rejects.toThrow('size mismatch');
    });

    it('surfaces bundle download failures', async () => {
        const root = makeTempDir();
        const extensionPath = createBundledStack(root);
        const storagePath = path.join(root, 'storage');
        const { zipBytes } = createBundleZip(updateVersions);
        const candidate = createCandidate(updateVersions, zipBytes);
        const manager = new PhiveUpdateManager(storagePath, extensionPath, undefined, {
            currentExtensionVersion: '0.1.0',
            detectJavaMajor: async () => 17,
            downloadUrl: async () => { throw new Error('HTTP 404'); },
        });

        await expect(manager.installUpdate({ report: () => undefined }, candidate)).rejects.toThrow('HTTP 404');
    });

    it('rejects bundle manifests that do not match the curated feed entry', async () => {
        const root = makeTempDir();
        const extensionPath = createBundledStack(root);
        const storagePath = path.join(root, 'storage');
        const { zipBytes } = createBundleZip(updateVersions, (entries) => {
            const badManifest = {
                ...buildBundleManifest({ ...updateVersions, rules: '4.9.9' }),
                stackId: createStackId(updateVersions),
            };
            const manifestEntry = entries.find((entry) => entry.name === 'manifest.json');
            if (manifestEntry) {
                manifestEntry.data = JSON.stringify(badManifest, null, 2);
            }
        });
        const candidate = createCandidate(updateVersions, zipBytes);
        const manager = new PhiveUpdateManager(storagePath, extensionPath, undefined, {
            currentExtensionVersion: '0.1.0',
            detectJavaMajor: async () => 17,
            downloadUrl: async () => zipBytes,
        });

        await expect(manager.installUpdate({ report: () => undefined }, candidate)).rejects.toThrow('direct version mismatch');
    });

    it('rejects ZIP traversal entries', async () => {
        const root = makeTempDir();
        const extensionPath = createBundledStack(root);
        const storagePath = path.join(root, 'storage');
        const { zipBytes } = createBundleZip(updateVersions, (entries) => {
            entries.push({ name: '../escape.txt', data: 'nope' });
        });
        const candidate = createCandidate(updateVersions, zipBytes);
        const manager = new PhiveUpdateManager(storagePath, extensionPath, undefined, {
            currentExtensionVersion: '0.1.0',
            detectJavaMajor: async () => 17,
            downloadUrl: async () => zipBytes,
        });

        await expect(manager.installUpdate({ report: () => undefined }, candidate)).rejects.toThrow('parent-directory traversal');
    });

    it('rejects ZIP symlink entries', async () => {
        const root = makeTempDir();
        const extensionPath = createBundledStack(root);
        const storagePath = path.join(root, 'storage');
        const { zipBytes } = createBundleZip(updateVersions, (entries) => {
            entries.push({ name: 'link-to-jar', data: 'ignored', externalAttributes: (0o120777 << 16) >>> 0 });
        });
        const candidate = createCandidate(updateVersions, zipBytes);
        const manager = new PhiveUpdateManager(storagePath, extensionPath, undefined, {
            currentExtensionVersion: '0.1.0',
            detectJavaMajor: async () => 17,
            downloadUrl: async () => zipBytes,
        });

        await expect(manager.installUpdate({ report: () => undefined }, candidate)).rejects.toThrow('symlink entry');
    });

    it('rejects a concurrent install attempt', async () => {
        const root = makeTempDir();
        const extensionPath = createBundledStack(root);
        const storagePath = path.join(root, 'storage');
        const { zipBytes } = createBundleZip(updateVersions);
        const candidate = createCandidate(updateVersions, zipBytes);
        let resolveDownload: ((value: Buffer) => void) | undefined;
        const manager = new PhiveUpdateManager(storagePath, extensionPath, async () => undefined, {
            currentExtensionVersion: '0.1.0',
            detectJavaMajor: async () => 17,
            downloadUrl: () => new Promise<Buffer>((resolve) => { resolveDownload = resolve; }),
        });
        (manager as any).runHealthCheck = jest.fn().mockResolvedValue(undefined);

        const first = manager.installUpdate({ report: () => undefined }, candidate);
        await expect(manager.installUpdate({ report: () => undefined }, candidate)).rejects.toThrow('already in progress');
        resolveDownload!(zipBytes);
        await first;
    });

    it('shares one in-flight checkForUpdates call across concurrent callers', async () => {
        const root = makeTempDir();
        const extensionPath = createBundledStack(root);
        const storagePath = path.join(root, 'storage');
        const { zipBytes } = createBundleZip(updateVersions);
        const candidate = createCandidate(updateVersions, zipBytes);
        let resolveFeed: ((value: string) => void) | undefined;
        const fetchText = jest.fn(() => new Promise<string>((resolve) => { resolveFeed = resolve; }));
        const manager = new PhiveUpdateManager(storagePath, extensionPath, undefined, {
            currentExtensionVersion: '0.1.0',
            detectJavaMajor: async () => 17,
            fetchText,
        });

        const first = manager.checkForUpdates();
        const second = manager.checkForUpdates();
        await new Promise<void>((resolve) => setImmediate(resolve));
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(fetchText).toHaveBeenCalledTimes(1);

        resolveFeed!(curatedFeed([candidate]));
        await expect(first).resolves.toMatchObject({ status: 'update-available', candidate });
        await expect(second).resolves.toMatchObject({ status: 'update-available', candidate });
        expect(fetchText).toHaveBeenCalledTimes(1);
    });

    it('retries a transient network error once then succeeds', async () => {
        const root = makeTempDir();
        const extensionPath = createBundledStack(root);
        const storagePath = path.join(root, 'storage');
        const { zipBytes } = createBundleZip(updateVersions);
        const candidate = createCandidate(updateVersions, zipBytes);
        let callCount = 0;
        const manager = new PhiveUpdateManager(storagePath, extensionPath, async () => undefined, {
            currentExtensionVersion: '0.1.0',
            detectJavaMajor: async () => 17,
            downloadUrl: async () => {
                callCount += 1;
                if (callCount === 1) {
                    const err = new Error('connect failed') as NodeJS.ErrnoException;
                    err.code = 'ECONNRESET';
                    throw err;
                }
                return zipBytes;
            },
        });
        (manager as any).runHealthCheck = jest.fn().mockResolvedValue(undefined);

        const installed = await manager.installUpdate({ report: () => undefined }, candidate);
        expect(installed.primaryRulesVersion).toBe('4.3.1');
        expect(callCount).toBe(2);
    });

    it('does not retry on a 4xx or integrity error', async () => {
        const root = makeTempDir();
        const extensionPath = createBundledStack(root);
        const storagePath = path.join(root, 'storage');
        const { zipBytes } = createBundleZip(updateVersions);
        const candidate = createCandidate(updateVersions, zipBytes);
        let callCount = 0;
        const manager = new PhiveUpdateManager(storagePath, extensionPath, undefined, {
            currentExtensionVersion: '0.1.0',
            detectJavaMajor: async () => 17,
            downloadUrl: async () => {
                callCount += 1;
                throw new Error('HTTP 404');
            },
        });

        await expect(manager.installUpdate({ report: () => undefined }, candidate)).rejects.toThrow('HTTP 404');
        expect(callCount).toBe(1);
    });

    it('clears the startup timeout once the health daemon reports ready', async () => {
        jest.useFakeTimers();
        const root = makeTempDir();
        const extensionPath = createBundledStack(root);
        const storagePath = path.join(root, 'storage');
        const mockProcess = makeMockProcess();
        mockSpawn.mockReturnValue(mockProcess.proc);
        const manager = new PhiveUpdateManager(storagePath, extensionPath, undefined, {
            currentExtensionVersion: '0.1.0',
            detectJavaMajor: async () => 17,
        });

        const daemonPromise = (manager as any).spawnHealthDaemon('fake-classpath');
        await Promise.resolve();
        mockProcess.emitReady();
        const daemon = await daemonPromise;

        jest.advanceTimersByTime(30_001);
        expect(mockProcess.proc.kill).not.toHaveBeenCalled();

        const validation = daemon.validate('/invoice.xml');
        mockProcess.emitLine(JSON.stringify({
            profile: null,
            vesid: 'vesid',
            dddDetected: true,
            issues: [],
        }));
        await expect(validation).resolves.toMatchObject({ dddDetected: true, vesid: 'vesid' });
        daemon.stop();
    });
});

describe('extractZipToDirectory safety', () => {
    it('rejects a ZIP whose total uncompressed size exceeds 200 MB', () => {
        const bigData = Buffer.alloc(0);
        const entries = [
            { name: 'big.bin', data: bigData },
        ];
        const zipBytes = createStoredZipForTest(entries, 201 * 1024 * 1024);
        const zipPath = path.join(makeTempDir(), 'bomb.zip');
        fs.writeFileSync(zipPath, zipBytes);
        const destDir = path.join(makeTempDir(), 'out');
        expect(() => extractZipToDirectory(zipPath, destDir)).toThrow('exceeds the');
    });

    it('rejects a ZIP entry with a filename longer than 260 characters', () => {
        const longName = 'a'.repeat(300) + '.txt';
        const entries = [{ name: longName, data: 'test' }];
        const zipBytes = createStoredZipForTest(entries);
        const zipPath = path.join(makeTempDir(), 'longname.zip');
        fs.writeFileSync(zipPath, zipBytes);
        const destDir = path.join(makeTempDir(), 'out');
        expect(() => extractZipToDirectory(zipPath, destDir)).toThrow('exceeds 260 characters');
    });

    it('rejects a ZIP whose central directory understates the uncompressed size', () => {
        const zipBytes = createZipForTest([
            {
                name: 'manifest.json',
                data: '{"ok":true}',
                centralUncompressedSize: 1,
                localUncompressedSize: 11,
            },
        ]);
        const zipPath = path.join(makeTempDir(), 'understated.zip');
        fs.writeFileSync(zipPath, zipBytes);
        const destDir = path.join(makeTempDir(), 'out');
        expect(() => extractZipToDirectory(zipPath, destDir)).toThrow('mismatched uncompressed size');
    });

    it('rejects a ZIP whose local header metadata does not match the central directory', () => {
        const zipBytes = createZipForTest([
            {
                name: 'folder/manifest.json',
                data: '{"ok":true}',
                localFileName: 'folder/tampered.json',
            },
        ]);
        const zipPath = path.join(makeTempDir(), 'mismatch.zip');
        fs.writeFileSync(zipPath, zipBytes);
        const destDir = path.join(makeTempDir(), 'out');
        expect(() => extractZipToDirectory(zipPath, destDir)).toThrow('mismatched filename');
    });

    it('rejects oversized deflate output before writing it to disk', () => {
        const zipBytes = createZipForTest([
            {
                name: 'bomb.txt',
                data: Buffer.alloc(50 * 1024 * 1024 + 2, 0x61),
                compressionMethod: 8,
                centralUncompressedSize: 1,
                localUncompressedSize: 1,
            },
        ]);
        const zipPath = path.join(makeTempDir(), 'oversized-deflate.zip');
        fs.writeFileSync(zipPath, zipBytes);
        const destDir = path.join(makeTempDir(), 'out');
        expect(() => extractZipToDirectory(zipPath, destDir)).toThrow('extraction limit');
    });

    it('rejects ZIP entries that use Windows alternate data stream syntax', () => {
        const zipBytes = createZipForTest([
            { name: 'docs/invoice.xml:evil', data: '<Invoice />' },
        ]);
        const zipPath = path.join(makeTempDir(), 'ads.zip');
        fs.writeFileSync(zipPath, zipBytes);
        const destDir = path.join(makeTempDir(), 'out');
        expect(() => extractZipToDirectory(zipPath, destDir)).toThrow('unsupported Windows ":" path segment');
    });

    it('rejects ZIP entries that use reserved Windows device basenames', () => {
        const zipBytes = createZipForTest([
            { name: 'docs/NUL.txt', data: 'blocked' },
        ]);
        const zipPath = path.join(makeTempDir(), 'reserved-name.zip');
        fs.writeFileSync(zipPath, zipBytes);
        const destDir = path.join(makeTempDir(), 'out');
        expect(() => extractZipToDirectory(zipPath, destDir)).toThrow('reserved Windows device name');
    });

    it('cleans up the destination directory on partial extraction failure', () => {
        const entries = [
            { name: 'ok.txt', data: 'fine' },
            { name: '../escape.txt', data: 'bad' },
        ];
        const zipBytes = createStoredZipForTest(entries);
        const zipPath = path.join(makeTempDir(), 'partial.zip');
        fs.writeFileSync(zipPath, zipBytes);
        const destDir = path.join(makeTempDir(), 'partial-out');
        expect(() => extractZipToDirectory(zipPath, destDir)).toThrow('parent-directory traversal');
        expect(fs.existsSync(destDir)).toBe(false);
    });
});

function createStoredZipForTest(
    entries: Array<{ name: string; data: Buffer | string; externalAttributes?: number }>,
    fakeUncompressedSize?: number,
): Buffer {
    return createZipForTest(entries.map((entry) => ({
        ...entry,
        centralUncompressedSize: fakeUncompressedSize ?? Buffer.byteLength(
            Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8'),
        ),
        localUncompressedSize: fakeUncompressedSize ?? Buffer.byteLength(
            Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8'),
        ),
    })));
}
