import * as path from 'path';

import { buildSaveLocationOptions } from '../ui/editorPlacement';

describe('buildSaveLocationOptions', () => {
    it('returns options in order: workspace, mapper, input, browse', () => {
        const options = buildSaveLocationOptions({
            workspaceRootFsPath: '/repo',
            sourceXsltPath: '/repo/mapper/transform.xslt',
            sourceXmlPath: '/repo/input/invoice.xml',
        });

        expect(options.map(opt => opt.kind)).toEqual(['workspace', 'mapper', 'input', 'browse']);
        expect(options[0].folderFsPath).toBe('/repo');
        expect(options[1].folderFsPath).toBe('/repo/mapper');
        expect(options[2].folderFsPath).toBe('/repo/input');
    });

    it('maps mapper to XSLT folder and input to XML folder', () => {
        const options = buildSaveLocationOptions({
            sourceXsltPath: '/data/maps/main.xsl',
            sourceXmlPath: '/data/invoices/sample.xml',
        });

        const mapper = options.find(opt => opt.kind === 'mapper');
        const input = options.find(opt => opt.kind === 'input');

        expect(mapper?.folderFsPath).toBe(path.dirname('/data/maps/main.xsl'));
        expect(input?.folderFsPath).toBe(path.dirname('/data/invoices/sample.xml'));
    });

    it('deduplicates identical folders while preserving first option order', () => {
        const options = buildSaveLocationOptions({
            workspaceRootFsPath: '/shared',
            sourceXsltPath: '/shared/mapper.xslt',
            sourceXmlPath: '/shared/input.xml',
        });

        expect(options.map(opt => opt.kind)).toEqual(['workspace', 'browse']);
    });

    it('deduplicates mapper/input when both point to same folder', () => {
        const options = buildSaveLocationOptions({
            sourceXsltPath: '/same-dir/main.xsl',
            sourceXmlPath: '/same-dir/doc.xml',
        });

        expect(options.map(opt => opt.kind)).toEqual(['mapper', 'browse']);
    });

    it('omits unavailable folders safely and keeps browse as fallback', () => {
        const options = buildSaveLocationOptions({});
        expect(options).toEqual([{ kind: 'browse', label: 'Browse' }]);
    });
});
