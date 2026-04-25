interface XPathSegment {
    elementName: string;
    index: number; // 1-based occurrence index
}

/**
 * Parse an SVRL XPath location into structured segments.
 * XPaths look like: /*:Invoice[1]/*:AccountingSupplierParty[1]/*:Party[1]/*:PartyName[1]/*:Name[1]
 * or: /Invoice/AccountingSupplierParty[1]/Party[1]/PartyName[1]/Name[1]
 */
function parseXPathSegments(xpath: string): XPathSegment[] {
    const parts = xpath.split('/').filter(s => s.length > 0);
    const segments: XPathSegment[] = [];

    for (const part of parts) {
        // Match patterns like: *:ElementName[2], cac:ElementName[1], ElementName, *:ElementName
        const m = part.match(/(?:[a-zA-Z0-9_*-]+:)?([a-zA-Z][a-zA-Z0-9_-]*)\[?(\d+)?\]?/);
        if (m) {
            segments.push({
                elementName: m[1],
                index: m[2] ? parseInt(m[2], 10) : 1,
            });
        }
    }

    return segments;
}

/**
 * Find the line range (start, end) of the Nth occurrence of an element
 * within a given line range of the source. Tracks nesting depth to find
 * the matching closing tag so child searches are scoped correctly.
 */
function findElementRange(
    elementName: string,
    occurrence: number,
    sourceLines: string[],
    searchStart: number,
    searchEnd: number
): { startLine: number; endLine: number } | null {
    // Regex to find opening tags: <Element or <prefix:Element
    const openRegex = new RegExp(`<(?:[a-zA-Z0-9_-]+:)?${escapeRegex(elementName)}(?:\\s|>|/)`);
    // Regex to find self-closing tags on the same line
    const selfCloseRegex = new RegExp(`<(?:[a-zA-Z0-9_-]+:)?${escapeRegex(elementName)}\\b[^>]*/>`);
    // Regex to find closing tags
    const closeRegex = new RegExp(`</(?:[a-zA-Z0-9_-]+:)?${escapeRegex(elementName)}\\s*>`);

    let count = 0;

    for (let i = searchStart; i <= searchEnd && i < sourceLines.length; i++) {
        const line = sourceLines[i];
        if (!openRegex.test(line)) {
            continue;
        }

        count++;
        if (count !== occurrence) {
            continue;
        }

        // Found the right occurrence. Now find where it ends.
        // Check for self-closing tag on same line
        if (selfCloseRegex.test(line)) {
            return { startLine: i, endLine: i };
        }

        // Walk forward to find the closing tag, tracking nesting depth
        let depth = 1;
        for (let j = i + 1; j <= searchEnd && j < sourceLines.length; j++) {
            const scanLine = sourceLines[j];
            // Count additional opens of the same element (nesting)
            if (openRegex.test(scanLine) && !selfCloseRegex.test(scanLine)) {
                depth++;
            }
            if (closeRegex.test(scanLine)) {
                depth--;
                if (depth === 0) {
                    return { startLine: i, endLine: j };
                }
            }
        }

        // Couldn't find closing tag - return just the opening line
        // with range extending to end of search area
        return { startLine: i, endLine: searchEnd };
    }

    return null;
}

/**
 * Walk the full XPath from root to leaf, narrowing the search range at each
 * step so that each segment is resolved within its parent element's scope.
 * This correctly handles repeated element names (e.g. multiple InvoiceLine
 * each containing an Item/Name).
 */
export function resolveLineFromXPath(xpath: string, sourceLines: string[]): number {
    if (!xpath) {
        return 1;
    }

    const segments = parseXPathSegments(xpath);
    if (segments.length === 0) {
        return 1;
    }

    let rangeStart = 0;
    let rangeEnd = sourceLines.length - 1;
    let lastFoundLine = 0; // 0-indexed

    for (const segment of segments) {
        const range = findElementRange(
            segment.elementName,
            segment.index,
            sourceLines,
            rangeStart,
            rangeEnd
        );

        if (!range) {
            // Can't resolve further - use what we have so far
            break;
        }

        lastFoundLine = range.startLine;
        // Narrow scope: children live between the open and close of this element
        rangeStart = range.startLine + 1;
        rangeEnd = range.endLine;
    }

    return lastFoundLine + 1; // convert to 1-indexed
}

function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
