import * as path from 'path';

export function makeReportFileName(timestamp: number): string {
    const safe = new Date(timestamp).toISOString().replace(/[:.]/g, '-');
    return `xslt-studio-validation-${safe}.html`;
}

export function makeReportPath(tmpDir: string, timestamp: number): string {
    return path.join(tmpDir, makeReportFileName(timestamp));
}
