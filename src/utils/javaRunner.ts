import * as fs from 'fs';
import * as path from 'path';
import { spawn, ChildProcess } from 'child_process';
import { execAsync, checkToolAvailable, getInstallInstructions } from './execAsync';
import { getActiveJarsDir as resolveActivePhiveJarsDir } from '../validation/phiveStackRuntime';

export interface SaxonTransformOptions {
    extensionPath: string;
    sourceFile: string;
    xsltFile: string;
    parameters?: Record<string, string>;
    enableTracing?: boolean;
}

export interface SaxonTransformResult {
    stdout: string;
    traceXml: string;
    /** Set when Saxon exited non-zero but produced partial output. The value is Saxon's stderr. */
    partialError?: string;
}

let javaAvailable: boolean | null = null;

export async function checkJavaAvailable(): Promise<boolean> {
    if (javaAvailable !== null) {
        return javaAvailable;
    }
    javaAvailable = await checkToolAvailable('java');
    return javaAvailable;
}

export function getBundledSaxonJarPath(extensionPath: string): string {
    return path.join(extensionPath, 'lib', 'saxon-he-10.9.jar');
}

export async function ensureJava(): Promise<void> {
    const available = await checkJavaAvailable();
    if (!available) {
        throw new Error(
            'Java is required but is not installed or not in your PATH. ' +
            getInstallInstructions('java')
        );
    }
}

export async function runSaxonTransform(opts: SaxonTransformOptions): Promise<SaxonTransformResult> {
    const { extensionPath, sourceFile, xsltFile, parameters, enableTracing } = opts;
    await ensureJava();
    const saxonJar = getBundledSaxonJarPath(extensionPath);

    const args = [
        '-cp', saxonJar,
        'net.sf.saxon.Transform',
        `-s:${sourceFile}`,
        `-xsl:${xsltFile}`,
    ];

    if (parameters) {
        for (const [name, value] of Object.entries(parameters)) {
            args.push(`${name}=${value}`);
        }
    }

    if (enableTracing) {
        args.push('-T');
    }

    return new Promise<SaxonTransformResult>((resolve, reject) => {
        const child = spawn('java', args, { shell: false });

        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];

        child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
        child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

        child.on('error', (err) => {
            reject(new Error(`Saxon process error: ${err.message}`));
        });

        child.on('close', (code) => {
            const stdout = Buffer.concat(stdoutChunks).toString('utf8');
            const stderr = Buffer.concat(stderrChunks).toString('utf8');

            if (code !== 0) {
                if (stdout) {
                    resolve({ stdout, traceXml: enableTracing ? stderr : '', partialError: stderr });
                } else {
                    reject(new Error(`Saxon transform failed: ${stderr}`));
                }
                return;
            }

            resolve({ stdout, traceXml: enableTracing ? stderr : '' });
        });
    });
}

export async function runXsdValidator(
    extensionPath: string,
    schemaFile: string,
    xmlFile: string
): Promise<{ stdout: string; stderr: string }> {
    await ensureJava();
    const classesDir = path.join(extensionPath, 'lib', 'classes');

    return execAsync('java', [
        '-cp', classesDir,
        'XsdValidator',
        schemaFile,
        xmlFile,
    ]);
}

/** JSON output schema emitted by PhiveRunner.java stdout. */
export interface PhiveRunnerOutput {
    profile: string | null;
    vesid: string | null;
    dddDetected: boolean;
    issues: PhiveRunnerIssue[];
    ruleResults: PhiveRunnerRuleResult[];
    error?: string;
}

export interface PhiveRunnerIssue {
    severity: 'ERROR' | 'WARNING' | 'INFORMATION';
    ruleId: string | null;
    message: string;
    line: number;
    column: number;
    test: string | null;
    location: string | null;
}

export interface PhiveRunnerRuleResult {
    ruleId: string;
    description: string;
    status: 'passed' | 'failed' | 'skipped';
    passed: boolean;
    source: 'xsd' | 'schematron' | 'phive';
}

export interface PhiveRunnerOptions {
    extensionPath: string;
    xmlFilePath: string;
    phiveJarsDir: string;
}

export interface PhiveRunnerHtmlOptions extends PhiveRunnerOptions {}

export class PhiveRunnerHtmlError extends Error {
    exitCode: number | null;
    stdout: string;
    stderr: string;
    runnerOutput?: PhiveRunnerOutput;

    constructor(
        message: string,
        details: {
            exitCode: number | null;
            stdout: string;
            stderr: string;
            runnerOutput?: PhiveRunnerOutput;
        },
    ) {
        super(message);
        Object.setPrototypeOf(this, new.target.prototype);
        this.name = 'PhiveRunnerHtmlError';
        this.exitCode = details.exitCode;
        this.stdout = details.stdout;
        this.stderr = details.stderr;
        this.runnerOutput = details.runnerOutput;
    }
}

/**
 * Returns the directory containing phive JARs to use at runtime.
 * Prefers globalStorage (updated via Maven) when a version.json is present there;
 * falls back to the bundled baseline in lib/phive-jars/.
 */
export function getActiveJarsDir(extensionPath: string, globalStorageFsPath?: string): string {
    return resolveActivePhiveJarsDir(extensionPath, globalStorageFsPath);
}

export async function runPhiveRunner(opts: PhiveRunnerOptions): Promise<PhiveRunnerOutput> {
    await ensureJava();
    const { extensionPath, xmlFilePath, phiveJarsDir } = opts;

    // Use the persistent daemon when it is ready — avoids JVM startup cost on each call.
    if (phiveDaemon.isReady()) {
        try {
            return await phiveDaemon.validate(xmlFilePath);
        } catch {
            // Daemon died unexpectedly — fall through to fresh-spawn below.
        }
    }

    // Fresh-spawn fallback (first call before daemon is warm, or after daemon crash).
    const classesDir = path.join(extensionPath, 'lib', 'classes');
    const classpath = classesDir + path.delimiter + path.join(phiveJarsDir, '*');

    return new Promise<PhiveRunnerOutput>((resolve, reject) => {
        const child = spawn('java', [
            '-cp', classpath,
            'PhiveRunner',
            '--xml', xmlFilePath,
            '--jars', phiveJarsDir,
        ], { shell: false });

        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];

        child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
        child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
        child.on('error', (err) => reject(new Error(`PhiveRunner process error: ${err.message}`)));

        child.on('close', (code) => {
            const stdout = Buffer.concat(stdoutChunks).toString('utf8').trim();
            try {
                resolve(JSON.parse(stdout) as PhiveRunnerOutput);
            } catch {
                const stderr = Buffer.concat(stderrChunks).toString('utf8');
                reject(new Error(`PhiveRunner invalid JSON (exit ${code}): ${stderr}`));
            }
        });
    });
}

export async function runPhiveRunnerHtml(opts: PhiveRunnerHtmlOptions): Promise<string> {
    await ensureJava();
    const { extensionPath, xmlFilePath, phiveJarsDir } = opts;

    const classesDir = path.join(extensionPath, 'lib', 'classes');
    const classpath = classesDir + path.delimiter + path.join(phiveJarsDir, '*');

    return new Promise<string>((resolve, reject) => {
        let settled = false;
        const child = spawn('java', [
            '-cp', classpath,
            'PhiveRunner',
            '--xml', xmlFilePath,
            '--jars', phiveJarsDir,
            '--format', 'html',
        ], { shell: false });

        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];
        const settleResolve = (html: string) => {
            if (settled) {
                return;
            }
            settled = true;
            resolve(html);
        };
        const settleReject = (err: PhiveRunnerHtmlError) => {
            if (settled) {
                return;
            }
            settled = true;
            reject(err);
        };
        const getStdout = () => Buffer.concat(stdoutChunks).toString('utf8');
        const getStderr = () => Buffer.concat(stderrChunks).toString('utf8').trim();
        const tryParseRunnerOutput = (stdout: string): PhiveRunnerOutput | undefined => {
            try {
                return JSON.parse(stdout) as PhiveRunnerOutput;
            } catch {
                return undefined;
            }
        };
        const buildHtmlError = (
            message: string,
            exitCode: number | null,
            stdout: string,
            stderr: string,
        ): PhiveRunnerHtmlError => new PhiveRunnerHtmlError(message, {
            exitCode,
            stdout,
            stderr,
            runnerOutput: stdout.trim() ? tryParseRunnerOutput(stdout.trim()) : undefined,
        });

        child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
        child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
        child.on('error', (err) => {
            settleReject(buildHtmlError(`PhiveRunner HTML process error: ${err.message}`, null, getStdout(), getStderr()));
        });

        child.on('close', (code) => {
            const stdout = getStdout();
            const stderr = getStderr();

            if (code !== 0) {
                settleReject(buildHtmlError(
                    `PhiveRunner HTML failed (exit ${code}): stdout=${JSON.stringify(stdout.trim())} stderr=${JSON.stringify(stderr)}`,
                    code,
                    stdout,
                    stderr,
                ));
                return;
            }

            if (!stdout.trim()) {
                settleReject(buildHtmlError(
                    `PhiveRunner HTML returned empty stdout (exit ${code}): stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`,
                    code,
                    stdout,
                    stderr,
                ));
                return;
            }

            settleResolve(stdout);
        });
    });
}

// ---------------------------------------------------------------------------
// Persistent daemon — keeps the JVM warm between validation calls
// ---------------------------------------------------------------------------

/**
 * Manages a long-running PhiveRunner process in daemon mode.
 * The JVM starts once (on extension activation), pre-initialises the EN16931/Peppol
 * registry, and then handles each validation request via stdin/stdout JSON-RPC.
 * This reduces per-validation cost from ~3.8s to ~0.3s after the first warm-up.
 */
class PhiveDaemon {
    private _proc: ChildProcess | null = null;
    private _startupPromise: Promise<void> | null = null;
    private _buf = '';
    // Pending line reader: [resolve, reject] so the close handler can unblock it.
    private _lineWaiter: [(line: string) => void, (err: Error) => void] | null = null;
    private _lineQueue: string[] = [];
    // Serialises concurrent callers — stdin/stdout is one request at a time.
    private _reqQueue: Promise<unknown> = Promise.resolve();

    /** Spawn the daemon. Called once from extension activate(). Non-blocking. */
    start(extensionPath: string, phiveJarsDir: string): void {
        if (this._proc || this._startupPromise) { return; } // already running — guard against double-start
        const classesDir = path.join(extensionPath, 'lib', 'classes');
        const classpath = classesDir + path.delimiter + path.join(phiveJarsDir, '*');

        const proc = spawn('java', ['-cp', classpath, 'PhiveRunner', '--daemon'], { shell: false });
        this._startupPromise = new Promise((resolve, reject) => {
            let started = false;
            let stderrBuf = '';

            proc.stderr.on('data', (chunk: Buffer) => {
                stderrBuf += chunk.toString('utf8');
                if (!started && stderrBuf.includes('[PhiveRunner] daemon ready')) {
                    started = true;
                    this._proc = proc;
                    this._startupPromise = null;
                    resolve();
                }
            });

            proc.on('close', () => {
                this._proc = null;
                this._startupPromise = null;
                if (!started) {
                    reject(new Error('PhiveDaemon: process closed before ready'));
                }
                // Unblock any pending _nextLine() so the caller can error and fall back.
                if (this._lineWaiter) {
                    const [, rej] = this._lineWaiter;
                    this._lineWaiter = null;
                    rej(new Error('PhiveDaemon: process closed unexpectedly'));
                }
            });

            proc.on('error', () => {
                this._proc = null;
                this._startupPromise = null;
                if (!started) {
                    reject(new Error('PhiveDaemon: process error during startup'));
                }
                if (this._lineWaiter) {
                    const [, rej] = this._lineWaiter;
                    this._lineWaiter = null;
                    rej(new Error('PhiveDaemon: process error'));
                }
            });
        });

        proc.stdout.on('data', (chunk: Buffer) => {
            this._buf += chunk.toString('utf8');
            const parts = this._buf.split('\n');
            this._buf = parts.pop()!; // keep any incomplete trailing chunk
            for (const line of parts) {
                const trimmed = line.trim();
                if (!trimmed) { continue; }
                if (this._lineWaiter) {
                    const [res] = this._lineWaiter;
                    this._lineWaiter = null;
                    res(trimmed);
                } else {
                    this._lineQueue.push(trimmed);
                }
            }
        });

    }

    /** True once the daemon process has signalled readiness on stderr. */
    isReady(): boolean { return this._proc !== null; }

    async waitUntilReady(): Promise<void> {
        if (this._proc) {
            return;
        }
        if (!this._startupPromise) {
            throw new Error('PhiveDaemon: not running');
        }
        await this._startupPromise;
    }

    /**
     * Send a validation request and return the parsed result.
     * Concurrent callers are queued — only one request is in-flight at a time.
     */
    async validate(xmlFilePath: string): Promise<PhiveRunnerOutput> {
        const p = this._reqQueue.then(() => this._send(xmlFilePath));
        this._reqQueue = p.catch(() => {}); // keep queue alive; caller gets p directly
        return p;
    }

    private _nextLine(): Promise<string> {
        if (this._lineQueue.length > 0) { return Promise.resolve(this._lineQueue.shift()!); }
        return new Promise<string>((resolve, reject) => { this._lineWaiter = [resolve, reject]; });
    }

    private async _send(xmlFilePath: string): Promise<PhiveRunnerOutput> {
        if (!this._proc) { throw new Error('PhiveDaemon: not running'); }
        this._proc.stdin!.write(JSON.stringify({ xml: xmlFilePath }) + '\n');
        const line = await this._nextLine();
        return JSON.parse(line) as PhiveRunnerOutput;
    }

    /** Kill the daemon process. Called from extension deactivate(). */
    stop(): void {
        this._startupPromise = null;
        // Unblock any pending _nextLine() before killing — prevents stale waiter on restart.
        if (this._lineWaiter) {
            const [, rej] = this._lineWaiter;
            this._lineWaiter = null;
            rej(new Error('PhiveDaemon: stopped'));
        }
        if (this._proc) {
            this._proc.kill();
            this._proc = null;
        }
    }

    async restart(extensionPath: string, phiveJarsDir: string): Promise<void> {
        this.stop();
        this.start(extensionPath, phiveJarsDir);
        await this.waitUntilReady();
    }
}

/** Singleton daemon instance used by runPhiveRunner() and wired into extension lifecycle. */
export const phiveDaemon = new PhiveDaemon();
