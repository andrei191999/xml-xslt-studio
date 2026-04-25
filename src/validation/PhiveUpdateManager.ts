import * as crypto from 'crypto';
import * as fs from 'fs';
import * as https from 'https';
import * as path from 'path';
import { spawn } from 'child_process';
import type * as vscode from 'vscode';
import { ensureJava } from '../utils/javaRunner';
import { extractZipToDirectory } from './phiveBundleZip';
import {
    parsePhiveCuratedFeed,
    selectCuratedStackCandidate,
    type PhiveUpdateAvailability,
} from './phiveCuratedFeed';
import {
    activateInstalledStack,
    canRollbackPhiveStack,
    cleanupInactiveStacks,
    getActiveJarsDir,
    getInstalledStackDir,
    getInstalledStackManifestPath,
    getPhiveStackStatus,
    getPhiveStagingDir,
    type PhiveCuratedFeedV1,
    type PhiveStackCandidate,
    type PhiveStackManifest,
    type PhiveStackState,
    readPhiveState,
    readStackManifestFile,
    writePhiveState,
    rollbackPhiveStack,
    verifyStackJars,
    writeStackManifestFile,
} from './phiveStackRuntime';

const DEFAULT_CHECK_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_CURATED_FEED_URL = 'https://andrei191999.github.io/xml-xslt-studio/phive/stable.json';
const HEALTH_CHECK_TIMEOUT_MS = 30_000;
const TRANSIENT_NETWORK_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND']);
const RETRY_DELAY_MS = 2_000;

interface SmokeValidationResult {
    profile: string | null;
    vesid: string | null;
    dddDetected: boolean;
    issues: Array<{ severity: string }>;
    error?: string;
}

interface UrlResponse {
    statusCode: number;
    body: Buffer;
}

interface PhiveUpdateManagerOptions {
    currentExtensionVersion?: string;
    checkIntervalMs?: number;
    detectJavaMajor?: () => Promise<number>;
    downloadUrl?: (url: string) => Promise<Buffer>;
    fetchText?: (url: string) => Promise<string>;
    feedUrl?: string;
}

export interface PhiveLastCheckInfo {
    checkedAt: string;
    candidate?: PhiveStackCandidate;
    errorAt?: string;
    errorMessage?: string;
}

export interface PhiveUpdateCheckResult {
    status: PhiveUpdateAvailability;
    candidate?: PhiveStackCandidate;
    extensionVersion: string;
    javaMajor: number;
    feedGeneratedAt: string;
}

export type PhiveRecordedStatusState = 'check-failed' | 'update-available' | 'up-to-date';

export interface PhiveRecordedStatusSnapshot {
    updateState: PhiveRecordedStatusState;
    candidate?: PhiveStackCandidate;
    errorMessage?: string;
}

function toErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function toTimestamp(value?: string): number | null {
    if (!value) {
        return null;
    }
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
}

export function hasRecordedCheckFailure(lastCheck: PhiveLastCheckInfo | null): boolean {
    if (!lastCheck?.errorMessage) {
        return false;
    }
    const errorAt = toTimestamp(lastCheck.errorAt) ?? toTimestamp(lastCheck.checkedAt);
    const checkedAt = toTimestamp(lastCheck.checkedAt);
    return errorAt !== null && (checkedAt === null || errorAt >= checkedAt);
}

export function resolveRecordedCheckStatus(
    lastCheck: PhiveLastCheckInfo | null,
    activeStackId: string,
): PhiveRecordedStatusSnapshot | null {
    if (!lastCheck) {
        return null;
    }
    if (hasRecordedCheckFailure(lastCheck)) {
        return {
            updateState: 'check-failed',
            errorMessage: lastCheck.errorMessage,
        };
    }
    if (lastCheck.candidate && lastCheck.candidate.stackId !== activeStackId) {
        return {
            updateState: 'update-available',
            candidate: lastCheck.candidate,
        };
    }
    return {
        updateState: 'up-to-date',
    };
}

export class PhiveUpdateManager {
    private readonly currentExtensionVersion: string;
    private readonly downloadUrl: (url: string) => Promise<Buffer>;
    private readonly extensionPath: string;
    private readonly feedUrl: string;
    private readonly fetchText: (url: string) => Promise<string>;
    private readonly globalStorageFsPath: string;
    private readonly detectJavaMajorImpl: () => Promise<number>;
    private readonly checkIntervalMs: number;
    private readonly onStackActivated?: (jarsDir: string) => Promise<void>;
    private javaMajorPromise: Promise<number> | null = null;
    private installLock: Promise<PhiveStackManifest> | null = null;
    private checkLock: Promise<PhiveUpdateCheckResult> | null = null;

    constructor(
        globalStorageFsPath: string,
        extensionPath: string,
        onStackActivated?: (jarsDir: string) => Promise<void>,
        options: PhiveUpdateManagerOptions = {},
    ) {
        this.globalStorageFsPath = globalStorageFsPath;
        this.extensionPath = extensionPath;
        this.onStackActivated = onStackActivated;
        this.currentExtensionVersion = options.currentExtensionVersion ?? this.readExtensionVersion();
        this.checkIntervalMs = options.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
        this.feedUrl = options.feedUrl ?? DEFAULT_CURATED_FEED_URL;
        this.fetchText = options.fetchText ?? (async (url) => (await this.fetchUrl(url)).body.toString('utf8'));
        this.downloadUrl = options.downloadUrl ?? (async (url) => (await this.fetchUrl(url)).body);
        this.detectJavaMajorImpl = options.detectJavaMajor ?? (() => this.readJavaMajor());
    }

    getActiveVersion(): string {
        return this.getStackStatus().activeStack.primaryRulesVersion;
    }

    getStackStatus() {
        return getPhiveStackStatus(this.extensionPath, this.globalStorageFsPath);
    }

    canRollback(): boolean {
        return canRollbackPhiveStack(this.extensionPath, this.globalStorageFsPath);
    }

    getLastCheckInfo(): PhiveLastCheckInfo | null {
        try {
            return JSON.parse(fs.readFileSync(this.getLastCheckFile(), 'utf8')) as PhiveLastCheckInfo;
        } catch {
            return null;
        }
    }

    async queryLatestVersion(): Promise<{ version: string; publishedAt: string } | null> {
        const candidate = await this.queryLatestStackCandidate();
        if (!candidate) {
            return null;
        }
        return {
            version: candidate.directVersions.rules,
            publishedAt: candidate.publishedAt,
        };
    }

    async queryLatestStackCandidate(): Promise<PhiveStackCandidate | null> {
        const result = await this.checkForUpdates();
        return result.candidate ?? null;
    }

    async checkForUpdates(): Promise<PhiveUpdateCheckResult> {
        if (this.checkLock) {
            return this.checkLock;
        }
        const run = async (): Promise<PhiveUpdateCheckResult> => {
            await ensureJava();
            const javaMajor = await this.getJavaMajor();
            const feed = await this.fetchCuratedFeed();
            const activeStackId = this.getStackStatus().activeStack.stackId;
            const selection = selectCuratedStackCandidate(feed, {
                activeStackId,
                extensionVersion: this.currentExtensionVersion,
                javaMajor,
            });

            return {
                status: selection.status,
                candidate: selection.candidate,
                extensionVersion: this.currentExtensionVersion,
                javaMajor,
                feedGeneratedAt: feed.generatedAt,
            };
        };
        this.checkLock = run();
        try {
            return await this.checkLock;
        } finally {
            this.checkLock = null;
        }
    }

    async isUpdateAvailable(): Promise<boolean> {
        try {
            return (await this.checkForUpdates()).status === 'update-available';
        } catch {
            return false;
        }
    }

    shouldCheckNow(): boolean {
        try {
            const data = JSON.parse(fs.readFileSync(this.getLastCheckFile(), 'utf8')) as { checkedAt: string };
            return Date.now() - new Date(data.checkedAt).getTime() > this.checkIntervalMs;
        } catch {
            return true;
        }
    }

    recordSuccessfulCheck(candidate?: PhiveStackCandidate): void {
        const checkFile = this.getLastCheckFile();
        const payload: PhiveLastCheckInfo = {
            checkedAt: new Date().toISOString(),
        };
        if (candidate) {
            payload.candidate = candidate;
        }
        fs.mkdirSync(path.dirname(checkFile), { recursive: true });
        fs.writeFileSync(checkFile, JSON.stringify(payload, null, 2), 'utf8');
    }

    recordFailedCheck(error: unknown): void {
        const existing = this.getLastCheckInfo();
        const now = new Date().toISOString();
        const payload: PhiveLastCheckInfo = existing
            ? { ...existing }
            : { checkedAt: now };
        payload.errorAt = now;
        payload.errorMessage = toErrorMessage(error);
        const checkFile = this.getLastCheckFile();
        fs.mkdirSync(path.dirname(checkFile), { recursive: true });
        fs.writeFileSync(checkFile, JSON.stringify(payload, null, 2), 'utf8');
    }

    async installUpdate(
        progress: vscode.Progress<{ message?: string }>,
        candidate?: PhiveStackCandidate,
    ): Promise<PhiveStackManifest> {
        // B2 — concurrency guard
        if (this.installLock) {
            throw new Error('A PHIVE update is already in progress.');
        }

        const run = async (): Promise<PhiveStackManifest> => {
            await ensureJava();
            const nextCandidate = candidate ?? await this.requireLatestCandidate();
            const stacksDir = path.join(this.globalStorageFsPath, 'phive', 'stacks');
            const stagingDir = path.join(getPhiveStagingDir(this.globalStorageFsPath), nextCandidate.stackId);
            const targetDir = getInstalledStackDir(this.globalStorageFsPath, nextCandidate.stackId);
            const bundlePath = path.join(getPhiveStagingDir(this.globalStorageFsPath), `${nextCandidate.stackId}.zip`);
            const previousState = readPhiveState(this.extensionPath, this.globalStorageFsPath);
            const installPhase = {
                downloaded: false,
                extracted: false,
                renamed: false,
                activated: false,
                restarted: false,
            };

            progress.report({ message: `Downloading curated PHIVE bundle ${nextCandidate.bundle.assetName}` });
            fs.mkdirSync(stacksDir, { recursive: true });
            fs.rmSync(stagingDir, { recursive: true, force: true });
            fs.rmSync(targetDir, { recursive: true, force: true });
            fs.rmSync(bundlePath, { force: true });
            fs.mkdirSync(stagingDir, { recursive: true });

            try {
                await this.downloadBundle(nextCandidate, bundlePath);
                installPhase.downloaded = true;

                progress.report({ message: `Extracting ${nextCandidate.bundle.assetName}` });
                extractZipToDirectory(bundlePath, stagingDir);
                installPhase.extracted = true;

                progress.report({ message: 'Verifying curated bundle manifest' });
                const extractedManifestPath = path.join(stagingDir, 'manifest.json');
                if (!fs.existsSync(extractedManifestPath)) {
                    throw new Error('Curated PHIVE bundle is missing manifest.json.');
                }
                const extractedManifest = readStackManifestFile(extractedManifestPath);
                this.verifyBundleManifest(extractedManifest, nextCandidate);
                verifyStackJars(stagingDir, extractedManifest);

                progress.report({ message: 'Running PHIVE health check' });
                await this.runHealthCheck(stagingDir);

                const activatedAt = new Date().toISOString();
                const installedManifest: PhiveStackManifest = {
                    ...extractedManifest,
                    source: nextCandidate.source,
                    installedAt: activatedAt,
                    healthVerifiedAt: activatedAt,
                };

                // B1 — write manifest into staging BEFORE the atomic rename
                writeStackManifestFile(path.join(stagingDir, 'manifest.json'), installedManifest);
                fs.renameSync(stagingDir, targetDir);
                installPhase.renamed = true;
                activateInstalledStack(this.extensionPath, this.globalStorageFsPath, installedManifest);
                installPhase.activated = true;
                await this.restartRuntime();
                installPhase.restarted = true;
                cleanupInactiveStacks(this.extensionPath, this.globalStorageFsPath);
                return readStackManifestFile(getInstalledStackManifestPath(this.globalStorageFsPath, installedManifest.stackId));
            } catch (error) {
                fs.rmSync(stagingDir, { recursive: true, force: true });
                let rollbackError: unknown;

                if (installPhase.renamed && !installPhase.restarted) {
                    rollbackError = await this.restorePreviousRuntimeState(previousState, targetDir);
                } else if (installPhase.renamed && fs.existsSync(targetDir)) {
                    fs.rmSync(targetDir, { recursive: true, force: true });
                }

                cleanupInactiveStacks(this.extensionPath, this.globalStorageFsPath);
                if (rollbackError) {
                    throw new Error(
                        `PHIVE stack update failed: ${toErrorMessage(error)}. Rollback also failed: ${toErrorMessage(rollbackError)}`,
                    );
                }
                throw error;
            } finally {
                fs.rmSync(bundlePath, { force: true });
            }
        };

        this.installLock = run().finally(() => { this.installLock = null; });
        return this.installLock;
    }

    async rollbackActiveStack(): Promise<PhiveStackManifest> {
        const restored = rollbackPhiveStack(this.extensionPath, this.globalStorageFsPath);
        await this.restartRuntime();
        return restored;
    }

    private async restorePreviousRuntimeState(
        previousState: PhiveStackState,
        failedTargetDir: string,
    ): Promise<unknown | null> {
        try {
            writePhiveState(this.globalStorageFsPath, previousState);
            await this.restartRuntime();
        } catch (error) {
            return error;
        } finally {
            if (fs.existsSync(failedTargetDir)) {
                fs.rmSync(failedTargetDir, { recursive: true, force: true });
            }
        }
        return null;
    }

    private async requireLatestCandidate(): Promise<PhiveStackCandidate> {
        const result = await this.checkForUpdates();
        if (result.candidate) {
            return result.candidate;
        }
        if (result.status === 'no-compatible-update') {
            throw new Error(
                `No compatible curated PHIVE update is available for extension ${result.extensionVersion} on Java ${result.javaMajor}.`,
            );
        }
        throw new Error('PHIVE stack is already up to date.');
    }

    private verifyBundleManifest(manifest: PhiveStackManifest, candidate: PhiveStackCandidate): void {
        if (manifest.stackId !== candidate.stackId) {
            throw new Error(`Curated PHIVE bundle stack ID mismatch: expected ${candidate.stackId} but found ${manifest.stackId}.`);
        }
        for (const key of Object.keys(candidate.directVersions) as Array<keyof PhiveStackCandidate['directVersions']>) {
            if (manifest.directVersions[key] !== candidate.directVersions[key]) {
                throw new Error(
                    `Curated PHIVE bundle direct version mismatch for ${key}: expected ${candidate.directVersions[key]} but found ${manifest.directVersions[key]}.`,
                );
            }
        }
    }

    private async downloadBundle(candidate: PhiveStackCandidate, bundlePath: string): Promise<void> {
        // B5 — single retry on transient network failure
        let lastError: unknown;
        for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
                const bytes = await this.downloadUrl(candidate.bundle.url);
                if (bytes.length !== candidate.bundle.sizeBytes) {
                    throw new Error(
                        `Curated PHIVE bundle size mismatch for ${candidate.bundle.assetName}: expected ${candidate.bundle.sizeBytes} bytes but received ${bytes.length}.`,
                    );
                }
                const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
                if (sha256 !== candidate.bundle.sha256) {
                    throw new Error(`Curated PHIVE bundle SHA-256 mismatch for ${candidate.bundle.assetName}.`);
                }
                fs.mkdirSync(path.dirname(bundlePath), { recursive: true });
                fs.writeFileSync(bundlePath, bytes);
                return;
            } catch (error) {
                lastError = error;
                if (!this.isTransientError(error) || attempt > 0) {
                    throw error;
                }
                await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
            }
        }
        throw lastError;
    }

    private isTransientError(error: unknown): boolean {
        if (error instanceof Error) {
            if (TRANSIENT_NETWORK_CODES.has((error as NodeJS.ErrnoException).code ?? '')) {
                return true;
            }
            if (/HTTP [5]\d{2}/.test(error.message)) {
                return true;
            }
        }
        return false;
    }

    private async fetchCuratedFeed(): Promise<PhiveCuratedFeedV1> {
        return parsePhiveCuratedFeed(await this.fetchText(this.feedUrl));
    }

    private async restartRuntime(): Promise<void> {
        if (!this.onStackActivated) {
            return;
        }
        await this.onStackActivated(getActiveJarsDir(this.extensionPath, this.globalStorageFsPath));
    }

    private async runHealthCheck(jarsDir: string): Promise<void> {
        const smokeDir = path.join(this.extensionPath, 'validation-artifacts', 'phive-smoke');
        const classesDir = path.join(this.extensionPath, 'lib', 'classes');
        const classpath = classesDir + path.delimiter + path.join(jarsDir, '*');
        const invoice = path.join(smokeDir, 'invoice.xml');
        const creditNote = path.join(smokeDir, 'credit-note.xml');

        const daemon = await this.spawnHealthDaemon(classpath);
        try {
            for (const fixturePath of [invoice, creditNote]) {
                const result = await daemon.validate(fixturePath);
                if (result.error) {
                    throw new Error(`PHIVE health check failed for ${path.basename(fixturePath)}: ${result.error}`);
                }
                if (!result.dddDetected || !result.vesid) {
                    throw new Error(`PHIVE health check did not detect a VESID for ${path.basename(fixturePath)}`);
                }
                const hardErrors = result.issues.filter(issue => issue.severity === 'ERROR');
                if (hardErrors.length > 0) {
                    throw new Error(`PHIVE health check reported ${hardErrors.length} error(s) for ${path.basename(fixturePath)}`);
                }
            }
        } finally {
            daemon.stop();
        }
    }

    private async spawnHealthDaemon(classpath: string): Promise<{
        validate: (xmlPath: string) => Promise<SmokeValidationResult>;
        stop: () => void;
    }> {
        await ensureJava();
        const proc = spawn('java', ['-cp', classpath, 'PhiveRunner', '--daemon'], { shell: false });
        const stdoutQueue: string[] = [];
        let stdoutBuffer = '';
        let pending:
            | { resolve: (result: SmokeValidationResult) => void; reject: (error: Error) => void }
            | null = null;
        let startupResolved = false;
        let startupTimer: NodeJS.Timeout | null = null;

        const clearStartupTimer = (): void => {
            if (startupTimer) {
                clearTimeout(startupTimer);
                startupTimer = null;
            }
        };

        const rejectPending = (error: Error): void => {
            if (pending) {
                pending.reject(error);
                pending = null;
            }
        };

        const onStdoutData = (chunk: Buffer): void => {
            stdoutBuffer += chunk.toString('utf8');
            const parts = stdoutBuffer.split('\n');
            stdoutBuffer = parts.pop() ?? '';
            for (const line of parts) {
                const trimmed = line.trim();
                if (!trimmed) {
                    continue;
                }
                if (pending) {
                    const current = pending;
                    pending = null;
                    current.resolve(JSON.parse(trimmed) as SmokeValidationResult);
                } else {
                    stdoutQueue.push(trimmed);
                }
            }
        };

        const onProcessError = (error: Error): void => {
            const wrapped = new Error(`PHIVE health daemon process error: ${error.message}`);
            rejectPending(wrapped);
            if (!startupResolved) {
                startupReject?.(wrapped);
                cleanupStartupListeners();
            }
        };

        const onProcessClose = (): void => {
            const closeError = new Error(
                startupResolved
                    ? 'PHIVE health daemon closed unexpectedly.'
                    : 'PHIVE health daemon closed before reporting ready.',
            );
            rejectPending(closeError);
            if (!startupResolved) {
                startupReject?.(closeError);
                cleanupStartupListeners();
            }
        };

        proc.stdout.on('data', onStdoutData);
        proc.on('error', onProcessError);
        proc.on('close', onProcessClose);

        let startupResolve: (() => void) | null = null;
        let startupReject: ((error: Error) => void) | null = null;
        const cleanupStartupListeners = (): void => {
            clearStartupTimer();
            proc.stderr.off('data', onReadyStderr);
            startupResolve = null;
            startupReject = null;
        };
        const onReadyStderr = (chunk: Buffer): void => {
            if (chunk.toString('utf8').includes('[PhiveRunner] daemon ready')) {
                startupResolved = true;
                startupResolve?.();
                cleanupStartupListeners();
            }
        };

        proc.stderr.on('data', onReadyStderr);
        const startup = new Promise<void>((resolve, reject) => {
            startupResolve = resolve;
            startupReject = reject;
            startupTimer = setTimeout(() => {
                proc.kill();
                reject(new Error('PHIVE health check timed out after ' + HEALTH_CHECK_TIMEOUT_MS + 'ms.'));
                cleanupStartupListeners();
            }, HEALTH_CHECK_TIMEOUT_MS);
        });

        try {
            await startup;
        } catch (error) {
            proc.stdout.off('data', onStdoutData);
            proc.off('error', onProcessError);
            proc.off('close', onProcessClose);
            rejectPending(new Error('PHIVE health daemon stopped.'));
            proc.kill();
            throw error;
        }

        return {
            validate: (xmlPath: string) => new Promise<SmokeValidationResult>((resolve, reject) => {
                if (stdoutQueue.length > 0) {
                    resolve(JSON.parse(stdoutQueue.shift()!) as SmokeValidationResult);
                    return;
                }
                pending = { resolve, reject };
                proc.stdin?.write(JSON.stringify({ xml: xmlPath }) + '\n');
            }),
            stop: () => {
                clearStartupTimer();
                proc.stderr.off('data', onReadyStderr);
                if (pending) {
                    pending.reject(new Error('PHIVE health daemon stopped.'));
                    pending = null;
                }
                proc.stdout.off('data', onStdoutData);
                proc.off('error', onProcessError);
                proc.off('close', onProcessClose);
                proc.kill();
            },
        };
    }

    private async getJavaMajor(): Promise<number> {
        if (!this.javaMajorPromise) {
            this.javaMajorPromise = this.detectJavaMajorImpl();
        }
        return this.javaMajorPromise;
    }

    private async readJavaMajor(): Promise<number> {
        return new Promise<number>((resolve, reject) => {
            const child = spawn('java', ['-version'], { shell: false });
            let stderr = '';
            let stdout = '';
            child.stdout.on('data', (chunk: Buffer) => {
                stdout += chunk.toString('utf8');
            });
            child.stderr.on('data', (chunk: Buffer) => {
                stderr += chunk.toString('utf8');
            });
            child.on('error', reject);
            child.on('close', (code) => {
                if (code !== 0) {
                    reject(new Error(stderr.trim() || stdout.trim() || `java -version exited with code ${code}`));
                    return;
                }
                const rawVersion = (stderr + stdout).match(/version "([^"]+)"/)?.[1]
                    ?? (stderr + stdout).match(/openjdk (\d+(?:\.\d+)*)/)?.[1];
                if (!rawVersion) {
                    reject(new Error('Could not determine the local Java major version.'));
                    return;
                }
                const major = rawVersion.startsWith('1.')
                    ? Number(rawVersion.split('.')[1])
                    : Number(rawVersion.split('.')[0]);
                if (!Number.isInteger(major) || major < 1) {
                    reject(new Error(`Could not parse Java major version from "${rawVersion}".`));
                    return;
                }
                resolve(major);
            });
        });
    }

    private readExtensionVersion(): string {
        const packageJsonPath = path.join(this.extensionPath, 'package.json');
        const parsed = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as { version?: string };
        if (!parsed.version) {
            throw new Error('Could not determine the current extension version.');
        }
        return parsed.version;
    }

    private async fetchUrl(url: string, redirectCount = 0): Promise<UrlResponse> {
        if (redirectCount > 5) {
            throw new Error(`Too many redirects while fetching ${url}`);
        }
        return new Promise((resolve, reject) => {
            const req = https.get(url, (res) => {
                const statusCode = res.statusCode ?? 0;
                const location = res.headers.location;
                if (statusCode >= 300 && statusCode < 400 && location) {
                    res.resume();
                    const nextUrl = new URL(location, url).toString();
                    this.fetchUrl(nextUrl, redirectCount + 1).then(resolve, reject);
                    return;
                }
                if (statusCode !== 200) {
                    reject(new Error(`Curated PHIVE download returned HTTP ${statusCode} for ${url}`));
                    res.resume();
                    return;
                }
                const chunks: Buffer[] = [];
                res.on('data', (chunk: Buffer) => chunks.push(chunk));
                res.on('end', () => resolve({ statusCode, body: Buffer.concat(chunks) }));
                res.on('error', reject);
            });
            req.setTimeout(20_000, () => req.destroy(new Error(`Curated PHIVE request to ${url} timed out`)));
            req.on('error', reject);
        });
    }

    private getLastCheckFile(): string {
        return path.join(this.globalStorageFsPath, 'phive', 'last-check.json');
    }
}
