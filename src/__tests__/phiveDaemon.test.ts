/**
 * Unit tests for PhiveDaemon — the persistent JVM daemon in javaRunner.ts.
 *
 * child_process.spawn is replaced with a controllable EventEmitter so no JVM
 * is spawned.  execAsync utilities are mocked so ensureJava() passes without
 * a real java binary.  Singleton state is reset between tests via stop().
 */

import { EventEmitter } from 'events';
import { Writable } from 'stream';
import type { ChildProcess } from 'child_process';

// Mocks must be declared before any import that touches the real modules.
jest.mock('child_process', () => ({ spawn: jest.fn() }));
jest.mock('../utils/execAsync', () => ({
    execAsync: jest.fn(),
    checkToolAvailable: jest.fn().mockResolvedValue(true),
    getInstallInstructions: jest.fn().mockReturnValue(''),
}));

import { spawn } from 'child_process';
import { phiveDaemon, runPhiveRunner } from '../utils/javaRunner';

const mockSpawn = spawn as jest.MockedFunction<typeof spawn>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SAMPLE_JSON = JSON.stringify({
    profile: 'eu.peppol.bis3.ubl.invoice:2025.11.0',
    vesid:   'eu.peppol.bis3.ubl.invoice:2025.11.0',
    dddDetected: true,
    issues: [],
});

interface MockProcess {
    proc: ChildProcess;
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdinWrites: string[];
    emitReady: () => void;
    emitLine:  (json: string) => void;
    emitClose: () => void;
    emitError: (err: Error) => void;
}

function makeMockProcess(): MockProcess {
    const stdinWrites: string[] = [];
    const stdin = new Writable({
        write(chunk: Buffer, _enc: string, cb: () => void) {
            stdinWrites.push(chunk.toString('utf8'));
            cb();
        },
    });
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const proc = Object.assign(new EventEmitter(), { stdin, stdout, stderr, kill: jest.fn() }) as unknown as ChildProcess;

    return {
        proc,
        stdout,
        stderr,
        stdinWrites,
        emitReady:  () => stderr.emit('data', Buffer.from('[PhiveRunner] daemon ready\n')),
        emitLine:   (json) => stdout.emit('data', Buffer.from(json + '\n')),
        emitClose:  () => proc.emit('close', 0),
        emitError:  (err) => proc.emit('error', err),
    };
}

/** Wire up spawn mock and call start() without signalling ready. */
function startDaemon(m: MockProcess): void {
    mockSpawn.mockReturnValue(m.proc);
    phiveDaemon.start('/ext', '/jars');
}

/** Wire up spawn mock, call start(), and emit the ready signal. */
function startAndReady(m: MockProcess): void {
    startDaemon(m);
    m.emitReady();
}

afterEach(() => {
    phiveDaemon.stop();
    jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe('PhiveDaemon — lifecycle', () => {
    it('isReady() is false before start()', () => {
        expect(phiveDaemon.isReady()).toBe(false);
    });

    it('isReady() is false after start() but before the ready signal', () => {
        const m = makeMockProcess();
        startDaemon(m);
        expect(phiveDaemon.isReady()).toBe(false);
    });

    it('isReady() becomes true after [PhiveRunner] daemon ready on stderr', () => {
        const m = makeMockProcess();
        startAndReady(m);
        expect(phiveDaemon.isReady()).toBe(true);
    });

    it('spawns the JVM with --daemon flag', () => {
        const m = makeMockProcess();
        startDaemon(m);
        expect(mockSpawn).toHaveBeenCalledWith(
            'java',
            expect.arrayContaining(['--daemon']),
            expect.any(Object),
        );
    });

    it('double-start guard: second start() call does not spawn a new process', () => {
        const m = makeMockProcess();
        startAndReady(m);
        phiveDaemon.start('/ext', '/jars'); // second call — should be a no-op
        expect(mockSpawn).toHaveBeenCalledTimes(1);
    });

    it('isReady() becomes false after the process closes', () => {
        const m = makeMockProcess();
        startAndReady(m);
        m.emitClose();
        expect(phiveDaemon.isReady()).toBe(false);
    });

    it('stop() makes isReady() false', () => {
        const m = makeMockProcess();
        startAndReady(m);
        phiveDaemon.stop();
        expect(phiveDaemon.isReady()).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// Validate — happy path
// ---------------------------------------------------------------------------

describe('PhiveDaemon — validate', () => {
    it('writes a JSON request to stdin and returns the parsed response', async () => {
        const m = makeMockProcess();
        startAndReady(m);

        const promise = phiveDaemon.validate('/invoice.xml');
        m.emitLine(SAMPLE_JSON);
        const result = await promise;

        expect(m.stdinWrites).toHaveLength(1);
        expect(JSON.parse(m.stdinWrites[0])).toEqual({ xml: '/invoice.xml' });
        expect(result.dddDetected).toBe(true);
        expect(result.vesid).toBe('eu.peppol.bis3.ubl.invoice:2025.11.0');
    });

    it('rejects with "not running" when daemon is not ready', async () => {
        // _proc is null — daemon was never started (or was stopped by afterEach)
        await expect(phiveDaemon.validate('/invoice.xml')).rejects.toThrow('not running');
    });

    it('rejects when the process closes before responding', async () => {
        const m = makeMockProcess();
        startAndReady(m);

        const promise = phiveDaemon.validate('/invoice.xml');
        // Yield one tick so _send() runs and _lineWaiter is set before the close fires.
        await Promise.resolve();
        m.emitClose();
        await expect(promise).rejects.toThrow('process closed unexpectedly');
    });

    it('rejects when the process emits an error mid-request', async () => {
        const m = makeMockProcess();
        startAndReady(m);

        const promise = phiveDaemon.validate('/invoice.xml');
        // Yield one tick so _send() runs and _lineWaiter is set before the error fires.
        await Promise.resolve();
        m.emitError(new Error('ENOENT'));
        await expect(promise).rejects.toThrow('process error');
    });
});

// ---------------------------------------------------------------------------
// Line buffering
// ---------------------------------------------------------------------------

describe('PhiveDaemon — line buffering', () => {
    it('assembles a response split across two data chunks', async () => {
        const m = makeMockProcess();
        startAndReady(m);

        const promise = phiveDaemon.validate('/invoice.xml');
        const split = Math.floor(SAMPLE_JSON.length / 2);
        m.stdout.emit('data', Buffer.from(SAMPLE_JSON.slice(0, split)));
        m.stdout.emit('data', Buffer.from(SAMPLE_JSON.slice(split) + '\n'));

        const result = await promise;
        expect(result.dddDetected).toBe(true);
    });

    it('skips blank lines interspersed between JSON responses', async () => {
        const m = makeMockProcess();
        startAndReady(m);

        const promise = phiveDaemon.validate('/invoice.xml');
        // Blank lines before the real response — should be silently ignored
        m.stdout.emit('data', Buffer.from('\n\n' + SAMPLE_JSON + '\n'));

        const result = await promise;
        expect(result.dddDetected).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// Request serialization
// ---------------------------------------------------------------------------

describe('PhiveDaemon — request serialization', () => {
    it('serves concurrent validate() calls in FIFO order', async () => {
        const m = makeMockProcess();
        startAndReady(m);

        const completed: number[] = [];
        const p1 = phiveDaemon.validate('/a.xml').then(r => { completed.push(1); return r; });
        const p2 = phiveDaemon.validate('/b.xml').then(r => { completed.push(2); return r; });
        const p3 = phiveDaemon.validate('/c.xml').then(r => { completed.push(3); return r; });

        m.emitLine(SAMPLE_JSON); await p1;
        m.emitLine(SAMPLE_JSON); await p2;
        m.emitLine(SAMPLE_JSON); await p3;

        expect(completed).toEqual([1, 2, 3]);
    });

    it('continues serving requests after a previous one completes', async () => {
        const m = makeMockProcess();
        startAndReady(m);

        const p1 = phiveDaemon.validate('/a.xml');
        m.emitLine(SAMPLE_JSON);
        await expect(p1).resolves.toMatchObject({ dddDetected: true });

        const p2 = phiveDaemon.validate('/b.xml');
        m.emitLine(SAMPLE_JSON);
        await expect(p2).resolves.toMatchObject({ dddDetected: true });
    });
});

// ---------------------------------------------------------------------------
// stop() unblocking
// ---------------------------------------------------------------------------

describe('PhiveDaemon — stop() unblocking', () => {
    it('rejects a pending validate() when stop() is called', async () => {
        const m = makeMockProcess();
        startAndReady(m);

        const promise = phiveDaemon.validate('/invoice.xml');
        // Yield one microtask tick so _reqQueue.then() runs and _lineWaiter is set.
        await Promise.resolve();
        phiveDaemon.stop(); // should reject the pending _lineWaiter
        await expect(promise).rejects.toThrow('stopped');
    });
});

// ---------------------------------------------------------------------------
// runPhiveRunner routing
// ---------------------------------------------------------------------------

describe('runPhiveRunner — routing', () => {
    it('delegates to the daemon when it is ready', async () => {
        const m = makeMockProcess();
        startAndReady(m);

        const promise = runPhiveRunner({ extensionPath: '/ext', xmlFilePath: '/invoice.xml', phiveJarsDir: '/jars' });
        m.emitLine(SAMPLE_JSON);
        const result = await promise;

        expect(result.dddDetected).toBe(true);
        // Only one spawn: the daemon start — no fresh JVM was spawned
        expect(mockSpawn).toHaveBeenCalledTimes(1);
    });

    it('falls back to a fresh JVM spawn when the daemon is not ready', async () => {
        const m = makeMockProcess();
        mockSpawn.mockReturnValue(m.proc);
        expect(phiveDaemon.isReady()).toBe(false);

        const promise = runPhiveRunner({ extensionPath: '/ext', xmlFilePath: '/invoice.xml', phiveJarsDir: '/jars' });
        // Use setImmediate so all microtasks (ensureJava) complete and spawn's
        // event listeners are attached before we emit the fake response.
        setImmediate(() => {
            m.stdout.emit('data', Buffer.from(SAMPLE_JSON));
            m.emitClose();
        });
        const result = await promise;

        expect(result.dddDetected).toBe(true);
        const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
        expect(spawnArgs).not.toContain('--daemon');
    });
});
