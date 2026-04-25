import { execFile } from 'child_process';
import { promisify } from 'util';
import * as process from 'process';

/** Returns a HH:MM:SS.mmm timestamp string for output channel log prefixes. */
export function ts(): string {
    const d = new Date();
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    const ms = String(d.getMilliseconds()).padStart(3, '0');
    return `${hh}:${mm}:${ss}.${ms}`;
}

const execFilePromise = promisify(execFile);

const MAX_BUFFER = 1024 * 1024 * 1024; // 1GB

export function execAsync(
    command: string,
    args: string[],
    options?: { maxBuffer?: number }
): Promise<{ stdout: string; stderr: string }> {
    return execFilePromise(command, args, {
        maxBuffer: options?.maxBuffer ?? MAX_BUFFER,
    });
}

const INSTALL_INSTRUCTIONS: Record<string, Record<string, string>> = {
    xmllint: {
        darwin: 'It should be pre-installed on macOS. If missing, install with: xcode-select --install',
        linux: 'Install with: sudo apt install libxml2-utils (Debian/Ubuntu) or sudo yum install libxml2 (RHEL/CentOS)',
        win32: 'Install libxml2 from https://www.zlatkovic.com/libxml.en.html or use Chocolatey: choco install xsltproc',
    },
    xsltproc: {
        darwin: 'It should be pre-installed on macOS. If missing, install with: brew install libxslt',
        linux: 'Install with: sudo apt install xsltproc (Debian/Ubuntu) or sudo yum install libxslt (RHEL/CentOS)',
        win32: 'Install libxslt from https://www.zlatkovic.com/libxml.en.html or use Chocolatey: choco install xsltproc',
    },
    java: {
        darwin: 'Install with: brew install openjdk',
        linux: 'Install with: sudo apt install default-jre (Debian/Ubuntu) or sudo yum install java-17-openjdk (RHEL/CentOS)',
        win32: 'Download from https://adoptium.net/ or install with: winget install EclipseAdoptium.Temurin.21.JRE',
    },
};

export function getInstallInstructions(tool: string): string {
    const platform = process.platform;
    const instructions = INSTALL_INSTRUCTIONS[tool];
    if (!instructions) {
        return `Please install "${tool}" and make sure it is available in your system PATH.`;
    }
    return instructions[platform] || instructions['linux'] ||
        `Please install "${tool}" and make sure it is available in your system PATH.`;
}

export async function checkToolAvailable(tool: string): Promise<boolean> {
    try {
        // Use 'where' on Windows, 'which' on Unix
        const cmd = process.platform === 'win32' ? 'where' : 'which';
        await execAsync(cmd, [tool], { maxBuffer: 1024 * 1024 });
        return true;
    } catch {
        return false;
    }
}
