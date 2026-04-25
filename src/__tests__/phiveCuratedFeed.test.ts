import {
    compareLooseVersions,
    parsePhiveCuratedFeed,
    selectCuratedStackCandidate,
} from '../validation/phiveCuratedFeed';

describe('phiveCuratedFeed', () => {
    it('rejects unsupported schema versions', () => {
        expect(() => parsePhiveCuratedFeed(JSON.stringify({
            schemaVersion: 2,
            generatedAt: '2026-04-21T00:00:00.000Z',
            channel: 'stable',
            stacks: [],
        }))).toThrow('Unsupported curated PHIVE feed schema version 2');
    });

    it('selects the first compatible stack from a newest-first curated feed', () => {
        const feed = parsePhiveCuratedFeed(JSON.stringify({
            schemaVersion: 1,
            generatedAt: '2026-04-21T00:00:00.000Z',
            channel: 'stable',
            stacks: [
                {
                    stackId: 'ddd-0.8.7_phive-12.0.5_rules-4.3.2',
                    publishedAt: '2026-04-22T00:00:00.000Z',
                    source: 'github-release',
                    directVersions: { ddd: '0.8.7', phive: '12.0.5', rules: '4.3.2' },
                    minimumExtensionVersion: '0.2.0',
                    minimumJavaMajor: 17,
                    bundle: {
                        assetName: 'phive-stack-ddd-0.8.7_phive-12.0.5_rules-4.3.2.zip',
                        url: 'https://example.invalid/1.zip',
                        sizeBytes: 1,
                        sha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                    },
                },
                {
                    stackId: 'ddd-0.8.6_phive-12.0.4_rules-4.3.1',
                    publishedAt: '2026-04-21T00:00:00.000Z',
                    source: 'github-release',
                    directVersions: { ddd: '0.8.6', phive: '12.0.4', rules: '4.3.1' },
                    minimumExtensionVersion: '0.1.0',
                    minimumJavaMajor: 17,
                    bundle: {
                        assetName: 'phive-stack-ddd-0.8.6_phive-12.0.4_rules-4.3.1.zip',
                        url: 'https://example.invalid/2.zip',
                        sizeBytes: 1,
                        sha256: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
                    },
                },
            ],
        }));

        const result = selectCuratedStackCandidate(feed, {
            activeStackId: 'ddd-0.8.5_phive-12.0.3_rules-4.3.0',
            extensionVersion: '0.1.0',
            javaMajor: 17,
        });

        expect(result.status).toBe('update-available');
        expect(result.candidate?.stackId).toBe('ddd-0.8.6_phive-12.0.4_rules-4.3.1');
    });

    it('reports no-compatible-update when newer curated stacks require a newer extension or Java', () => {
        const feed = parsePhiveCuratedFeed(JSON.stringify({
            schemaVersion: 1,
            generatedAt: '2026-04-21T00:00:00.000Z',
            channel: 'stable',
            stacks: [
                {
                    stackId: 'ddd-0.8.7_phive-12.0.5_rules-4.3.2',
                    publishedAt: '2026-04-22T00:00:00.000Z',
                    source: 'github-release',
                    directVersions: { ddd: '0.8.7', phive: '12.0.5', rules: '4.3.2' },
                    minimumExtensionVersion: '0.2.0',
                    minimumJavaMajor: 21,
                    bundle: {
                        assetName: 'phive-stack-ddd-0.8.7_phive-12.0.5_rules-4.3.2.zip',
                        url: 'https://example.invalid/1.zip',
                        sizeBytes: 1,
                        sha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                    },
                },
                {
                    stackId: 'ddd-0.8.5_phive-12.0.3_rules-4.3.0',
                    publishedAt: '2026-04-21T00:00:00.000Z',
                    source: 'github-release',
                    directVersions: { ddd: '0.8.5', phive: '12.0.3', rules: '4.3.0' },
                    minimumExtensionVersion: '0.1.0',
                    minimumJavaMajor: 17,
                    bundle: {
                        assetName: 'phive-stack-ddd-0.8.5_phive-12.0.3_rules-4.3.0.zip',
                        url: 'https://example.invalid/0.zip',
                        sizeBytes: 1,
                        sha256: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
                    },
                },
            ],
        }));

        const result = selectCuratedStackCandidate(feed, {
            activeStackId: 'ddd-0.8.5_phive-12.0.3_rules-4.3.0',
            extensionVersion: '0.1.0',
            javaMajor: 17,
        });

        expect(result).toEqual({ status: 'no-compatible-update' });
    });

    it('returns empty-feed when the curated feed has zero stacks', () => {
        const feed = parsePhiveCuratedFeed(JSON.stringify({
            schemaVersion: 1,
            generatedAt: '2026-04-21T00:00:00.000Z',
            channel: 'stable',
            stacks: [],
        }));

        const result = selectCuratedStackCandidate(feed, {
            activeStackId: 'ddd-0.8.5_phive-12.0.3_rules-4.3.0',
            extensionVersion: '0.1.0',
            javaMajor: 17,
        });

        expect(result).toEqual({ status: 'empty-feed' });
    });

    it('ranks release versions above prerelease versions with the same numeric base', () => {
        expect(compareLooseVersions('1.0.0', '1.0.0-beta.1')).toBeGreaterThan(0);
        expect(compareLooseVersions('1.0.0-beta.1', '1.0.0')).toBeLessThan(0);
        expect(compareLooseVersions('1.0.0-alpha', '1.0.0-beta')).toBeLessThan(0);
        expect(compareLooseVersions('1.0.0-rc.1', '1.0.0-rc.2')).toBeLessThan(0);
    });

    it('compares release numbers numerically across major boundaries', () => {
        expect(compareLooseVersions('2.0.0', '1.9.9')).toBeGreaterThan(0);
    });

    it('treats numeric prerelease identifiers as lower precedence than alphanumeric ones', () => {
        expect(compareLooseVersions('1.0.0-1', '1.0.0-alpha')).toBeLessThan(0);
    });

    it('compares numeric prerelease identifiers numerically', () => {
        expect(compareLooseVersions('1.0.0-rc.2', '1.0.0-rc.10')).toBeLessThan(0);
    });

    it('re-sorts a mis-ordered feed by publishedAt newest-first', () => {
        const feed = parsePhiveCuratedFeed(JSON.stringify({
            schemaVersion: 1,
            generatedAt: '2026-04-21T00:00:00.000Z',
            channel: 'stable',
            stacks: [
                {
                    stackId: 'older',
                    publishedAt: '2026-04-20T00:00:00.000Z',
                    source: 'github-release',
                    directVersions: { ddd: '0.8.5', phive: '12.0.3', rules: '4.3.0' },
                    minimumExtensionVersion: '0.1.0',
                    minimumJavaMajor: 17,
                    bundle: {
                        assetName: 'old.zip',
                        url: 'https://example.invalid/old.zip',
                        sizeBytes: 1,
                        sha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                    },
                },
                {
                    stackId: 'newer',
                    publishedAt: '2026-04-22T00:00:00.000Z',
                    source: 'github-release',
                    directVersions: { ddd: '0.8.7', phive: '12.0.5', rules: '4.3.2' },
                    minimumExtensionVersion: '0.1.0',
                    minimumJavaMajor: 17,
                    bundle: {
                        assetName: 'new.zip',
                        url: 'https://example.invalid/new.zip',
                        sizeBytes: 1,
                        sha256: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
                    },
                },
            ],
        }));

        expect(feed.stacks[0].stackId).toBe('newer');
        expect(feed.stacks[1].stackId).toBe('older');
        expect(feed.feedSorted).toBe(true);
    });
});
