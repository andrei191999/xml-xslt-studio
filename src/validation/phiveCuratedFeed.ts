import type {
    PhiveCuratedFeedV1,
    PhiveCuratedStackEntry,
    PhiveStackCandidate,
    PhiveStackDirectVersions,
} from './phiveStackRuntime';

export type PhiveUpdateAvailability = 'update-available' | 'up-to-date' | 'no-compatible-update' | 'empty-feed';

export interface PhiveFeedSelectionOptions {
    activeStackId: string;
    extensionVersion: string;
    javaMajor: number;
}

export interface PhiveFeedSelectionResult {
    status: PhiveUpdateAvailability;
    candidate?: PhiveStackCandidate;
}

type VersionIdentifier = number | string;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function expectString(record: Record<string, unknown>, key: string): string {
    const value = record[key];
    if (typeof value !== 'string' || value.trim() === '') {
        throw new Error(`Curated PHIVE feed field "${key}" must be a non-empty string.`);
    }
    return value;
}

function expectNumber(record: Record<string, unknown>, key: string): number {
    const value = record[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`Curated PHIVE feed field "${key}" must be a finite number.`);
    }
    return value;
}

function parseDirectVersions(value: unknown): PhiveStackDirectVersions {
    if (!isRecord(value)) {
        throw new Error('Curated PHIVE feed field "directVersions" must be an object.');
    }
    return {
        ddd: expectString(value, 'ddd'),
        phive: expectString(value, 'phive'),
        rules: expectString(value, 'rules'),
    };
}

function parseBundle(value: unknown): PhiveCuratedStackEntry['bundle'] {
    if (!isRecord(value)) {
        throw new Error('Curated PHIVE feed field "bundle" must be an object.');
    }
    const sha256 = expectString(value, 'sha256').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(sha256)) {
        throw new Error('Curated PHIVE feed field "bundle.sha256" must be a 64-character lowercase hex string.');
    }
    return {
        assetName: expectString(value, 'assetName'),
        url: expectString(value, 'url'),
        sizeBytes: expectNumber(value, 'sizeBytes'),
        sha256,
    };
}

function parseStackEntry(value: unknown): PhiveCuratedStackEntry {
    if (!isRecord(value)) {
        throw new Error('Curated PHIVE feed stacks must contain objects.');
    }
    const minimumJavaMajor = expectNumber(value, 'minimumJavaMajor');
    if (!Number.isInteger(minimumJavaMajor) || minimumJavaMajor < 1) {
        throw new Error('Curated PHIVE feed field "minimumJavaMajor" must be a positive integer.');
    }
    return {
        stackId: expectString(value, 'stackId'),
        publishedAt: expectString(value, 'publishedAt'),
        source: expectString(value, 'source'),
        directVersions: parseDirectVersions(value.directVersions),
        minimumExtensionVersion: expectString(value, 'minimumExtensionVersion'),
        minimumJavaMajor,
        bundle: parseBundle(value.bundle),
    };
}

function compareFeedStackOrder(left: PhiveCuratedStackEntry, right: PhiveCuratedStackEntry): number {
    if (left.publishedAt !== right.publishedAt) {
        return left.publishedAt > right.publishedAt ? -1 : 1;
    }
    if (left.stackId !== right.stackId) {
        return left.stackId < right.stackId ? -1 : 1;
    }
    return 0;
}

export function parsePhiveCuratedFeed(text: string): PhiveCuratedFeedV1 {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch (error) {
        throw new Error(`Curated PHIVE feed is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!isRecord(parsed)) {
        throw new Error('Curated PHIVE feed root must be an object.');
    }
    const schemaVersion = expectNumber(parsed, 'schemaVersion');
    if (schemaVersion !== 1) {
        throw new Error(`Unsupported curated PHIVE feed schema version ${schemaVersion}.`);
    }
    const channel = expectString(parsed, 'channel');
    if (channel !== 'stable') {
        throw new Error(`Unsupported curated PHIVE feed channel "${channel}".`);
    }
    const stacksValue = parsed.stacks;
    if (!Array.isArray(stacksValue)) {
        throw new Error('Curated PHIVE feed field "stacks" must be an array.');
    }
    const stacks = stacksValue.map(parseStackEntry);

    const sortedStacks = stacks.slice().sort(compareFeedStackOrder);
    const needsSort = sortedStacks.some((stack, index) => stack !== stacks[index]);

    return {
        schemaVersion,
        generatedAt: expectString(parsed, 'generatedAt'),
        channel,
        stacks: needsSort ? sortedStacks : stacks,
        feedSorted: needsSort,
    };
}

function normalizeVersionPart(part: string): VersionIdentifier {
    return /^\d+$/.test(part) ? Number(part) : part;
}

function splitVersion(version: string): { release: VersionIdentifier[]; prerelease: VersionIdentifier[] | null } {
    const dashIndex = version.indexOf('-');
    if (dashIndex === -1) {
        return { release: version.split('.').map(normalizeVersionPart), prerelease: null };
    }
    return {
        release: version.slice(0, dashIndex).split('.').map(normalizeVersionPart),
        prerelease: version.slice(dashIndex + 1).split('.').map(normalizeVersionPart),
    };
}

function compareReleaseParts(left: VersionIdentifier[], right: VersionIdentifier[]): number {
    const max = Math.max(left.length, right.length);
    for (let index = 0; index < max; index += 1) {
        const leftPart = left[index] ?? 0;
        const rightPart = right[index] ?? 0;
        if (typeof leftPart === 'number' && typeof rightPart === 'number') {
            if (leftPart !== rightPart) {
                return leftPart - rightPart;
            }
            continue;
        }
        const cmp = String(leftPart) < String(rightPart) ? -1 : String(leftPart) > String(rightPart) ? 1 : 0;
        if (cmp !== 0) {
            return cmp;
        }
    }
    return 0;
}

function comparePrereleaseParts(left: VersionIdentifier[], right: VersionIdentifier[]): number {
    const max = Math.max(left.length, right.length);
    for (let index = 0; index < max; index += 1) {
        const leftPart = left[index];
        const rightPart = right[index];
        if (leftPart === undefined) {
            return -1;
        }
        if (rightPart === undefined) {
            return 1;
        }
        if (typeof leftPart === 'number' && typeof rightPart === 'number') {
            if (leftPart !== rightPart) {
                return leftPart - rightPart;
            }
            continue;
        }
        if (typeof leftPart === 'number') {
            return -1;
        }
        if (typeof rightPart === 'number') {
            return 1;
        }
        const cmp = leftPart < rightPart ? -1 : leftPart > rightPart ? 1 : 0;
        if (cmp !== 0) {
            return cmp;
        }
    }
    return 0;
}

export function compareLooseVersions(left: string, right: string): number {
    const leftSplit = splitVersion(left);
    const rightSplit = splitVersion(right);

    const releaseCmp = compareReleaseParts(leftSplit.release, rightSplit.release);
    if (releaseCmp !== 0) {
        return releaseCmp;
    }

    if (leftSplit.prerelease === null && rightSplit.prerelease === null) {
        return 0;
    }
    if (leftSplit.prerelease === null) {
        return 1;
    }
    if (rightSplit.prerelease === null) {
        return -1;
    }

    return comparePrereleaseParts(leftSplit.prerelease, rightSplit.prerelease);
}

export function isVersionAtLeast(version: string, minimumVersion: string): boolean {
    return compareLooseVersions(version, minimumVersion) >= 0;
}

export function isStackCompatible(
    stack: PhiveCuratedStackEntry,
    extensionVersion: string,
    javaMajor: number,
): boolean {
    return isVersionAtLeast(extensionVersion, stack.minimumExtensionVersion)
        && javaMajor >= stack.minimumJavaMajor;
}

export function selectCuratedStackCandidate(
    feed: PhiveCuratedFeedV1,
    options: PhiveFeedSelectionOptions,
): PhiveFeedSelectionResult {
    // C1 — distinguish empty feed from up-to-date
    if (feed.stacks.length === 0) {
        return { status: 'empty-feed' };
    }

    let sawBlockedStack = false;

    for (const stack of feed.stacks) {
        if (stack.stackId === options.activeStackId) {
            return {
                status: sawBlockedStack ? 'no-compatible-update' : 'up-to-date',
            };
        }

        if (isStackCompatible(stack, options.extensionVersion, options.javaMajor)) {
            return {
                status: 'update-available',
                candidate: stack,
            };
        }

        sawBlockedStack = true;
    }

    return {
        status: sawBlockedStack ? 'no-compatible-update' : 'up-to-date',
    };
}
