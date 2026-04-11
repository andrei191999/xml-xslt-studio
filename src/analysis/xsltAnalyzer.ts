import * as fs from 'fs';

export interface XsltTemplate {
    matchPattern: string;
    line: number;
    endLine: number;
    producedElements: string[];
}

/**
 * Regex-based XSLT template parser. Identifies which UBL elements
 * each template produces by scanning for literal element output
 * within template bodies.
 */
export function analyzeXslt(xsltPath: string): XsltTemplate[] {
    const content = fs.readFileSync(xsltPath, 'utf8');
    const lines = content.split(/\r?\n/);
    const templates: XsltTemplate[] = [];

    const templateOpenRegex = /^\s*<xsl:template\b[^>]*match="([^"]*)"[^>]*>/;
    const templateCloseRegex = /^\s*<\/xsl:template\s*>/;

    // UBL element patterns: literal elements with cac:, cbc:, or UBL namespace prefixes
    const ublElementRegex = /<(?:cac|cbc|ubl|ext):([A-Za-z][A-Za-z0-9]*)/g;
    // Also match xsl:element with name containing UBL-style names
    const xslElementRegex = /<xsl:element\s+name="(?:(?:cac|cbc|ubl|ext):)?([A-Za-z][A-Za-z0-9]*)"/g;

    let inTemplate = false;
    let currentMatch = '';
    let templateStartLine = 0;
    let bodyLines: string[] = [];
    let depth = 0;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        if (!inTemplate) {
            const m = line.match(templateOpenRegex);
            if (m) {
                inTemplate = true;
                currentMatch = m[1];
                templateStartLine = i + 1; // 1-indexed
                bodyLines = [];
                depth = 1;
                // Check if self-closing
                if (line.includes('/>') && !line.includes('>') ) {
                    // self-closing template - unlikely but handle
                    inTemplate = false;
                }
            }
        } else {
            // Count nested xsl:template opens/closes
            if (templateOpenRegex.test(line) && !line.includes('/>')) {
                depth++;
            }
            if (templateCloseRegex.test(line)) {
                depth--;
                if (depth === 0) {
                    // End of our template
                    const producedElements = extractProducedElements(bodyLines);
                    templates.push({
                        matchPattern: currentMatch,
                        line: templateStartLine,
                        endLine: i + 1,
                        producedElements,
                    });
                    inTemplate = false;
                    continue;
                }
            }
            bodyLines.push(line);
        }
    }

    return templates;
}

function extractProducedElements(lines: string[]): string[] {
    const elements = new Set<string>();
    const body = lines.join('\n');

    // Match literal UBL elements
    const ublElementRegex = /<(?:cac|cbc|ubl|ext):([A-Za-z][A-Za-z0-9]*)/g;
    let m: RegExpExecArray | null;
    while ((m = ublElementRegex.exec(body)) !== null) {
        elements.add(m[1]);
    }

    // Match xsl:element with name
    const xslElementRegex = /<xsl:element\s+name="(?:(?:cac|cbc|ubl|ext):)?([A-Za-z][A-Za-z0-9]*)"/g;
    while ((m = xslElementRegex.exec(body)) !== null) {
        elements.add(m[1]);
    }

    return Array.from(elements);
}
