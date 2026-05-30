import * as path from 'path';

import { makeReportFileName, makeReportPath } from '../reports/htmlReportPath';

describe('htmlReportPath', () => {
    it('creates an html filename without colons or ISO dots', () => {
        const fileName = makeReportFileName(Date.UTC(2026, 4, 16, 19, 30, 45, 123));

        expect(fileName.endsWith('.html')).toBe(true);
        expect(fileName).not.toContain(':');
        expect(fileName).not.toContain('.123Z');
        expect(fileName).toContain('2026-05-16T19-30-45-123Z');
    });

    it('creates a path under the provided temp directory', () => {
        const tmpDir = path.join('C:', 'tmp', 'reports');
        const reportPath = makeReportPath(tmpDir, Date.UTC(2026, 4, 16, 19, 30, 45, 123));

        expect(path.dirname(reportPath)).toBe(tmpDir);
        expect(path.basename(reportPath)).toBe(makeReportFileName(Date.UTC(2026, 4, 16, 19, 30, 45, 123)));
    });
});
