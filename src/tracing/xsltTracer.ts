import * as fs from 'fs';
import { execAsync, checkToolAvailable } from '../utils/execAsync';
import { writeTempFile } from '../utils/tempFile';
import { runSaxonTransform } from '../utils/javaRunner';

export interface TraceEntry {
    outputLine: number;
    sourceFile: string;
    sourceLine: number;
    /** The element name or match pattern for context */
    elementName: string;
}

const TRACE_COMMENT_PREFIX = 'XSLT-TRACE|';
const TRACE_DELIMITER = '|';

/**
 * Regex matching literal output elements in XSLT — anything that is NOT
 * an xsl: instruction. Captures the full element name including prefix.
 * Matches opening tags like: <cbc:ID>, <cac:Party>, <Invoice>, <ext:Foo>
 * but NOT <xsl:value-of>, <xsl:apply-templates>, etc.
 */
const LITERAL_ELEMENT_REGEX = /^(\s*)<(?!xsl:|\/|!|\?)([a-zA-Z][a-zA-Z0-9_-]*(?::[a-zA-Z][a-zA-Z0-9_-]*)?)[\s>\/]/;

/**
 * Instruments an XSLT stylesheet by injecting <xsl:comment> trace markers
 * before every literal output element. This gives element-level granularity
 * so validation errors can be traced back to the exact XSLT line that
 * produces the problematic element.
 */
export function instrumentXslt(xsltPath: string): string {
    const content = fs.readFileSync(xsltPath, 'utf8');
    const lines = content.split(/\r?\n/);
    const result: string[] = [];

    // Track whether we're inside an xsl:template (only instrument inside templates)
    let inTemplate = false;
    let templateDepth = 0;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Track template boundaries
        if (/<xsl:template\b/.test(line)) {
            inTemplate = true;
            templateDepth++;
        }
        if (/<\/xsl:template\s*>/.test(line)) {
            templateDepth--;
            if (templateDepth <= 0) {
                inTemplate = false;
                templateDepth = 0;
            }
        }

        if (inTemplate) {
            const m = line.match(LITERAL_ELEMENT_REGEX);
            if (m) {
                const indent = m[1];
                const elementName = m[2];
                // Inject a trace comment before this literal element
                const traceComment = `${indent}<xsl:comment>${TRACE_COMMENT_PREFIX}${xsltPath}${TRACE_DELIMITER}${i + 1}${TRACE_DELIMITER}${elementName}</xsl:comment>`;
                result.push(traceComment);
            }
        }

        result.push(line);
    }

    return result.join('\n');
}

/**
 * Runs a transform with the instrumented XSLT, parses trace comments from
 * the output, and returns both the clean output and the trace entries.
 */
export async function runInstrumentedTransform(
    sourceXml: string,
    xsltPath: string,
    extensionPath?: string
): Promise<{ cleanOutput: string; traceEntries: TraceEntry[] }> {
    const instrumented = instrumentXslt(xsltPath);
    const tmp = writeTempFile(instrumented, '.xsl');

    try {
        let rawOutput: string;

        // Try xsltproc first
        const xsltprocAvailable = await checkToolAvailable('xsltproc');
        if (xsltprocAvailable) {
            try {
                const result = await execAsync('xsltproc', [tmp.filePath, sourceXml]);
                rawOutput = result.stdout;
            } catch (error: any) {
                if (error.stdout) {
                    rawOutput = error.stdout;
                } else {
                    throw error;
                }
            }
        } else if (extensionPath) {
            // Fallback to bundled Saxon
            rawOutput = await runSaxonTransform(extensionPath, sourceXml, tmp.filePath);
        } else {
            throw new Error(
                '"xsltproc" is not installed and no bundled Saxon available. ' +
                'Install Java to use the bundled XSLT processor.'
            );
        }

        return parseTracedOutput(rawOutput);
    } finally {
        tmp.cleanup();
    }
}

/**
 * Parses trace comments from the transform output, builds trace entries,
 * and returns the clean output with trace comments stripped.
 */
function parseTracedOutput(raw: string): { cleanOutput: string; traceEntries: TraceEntry[] } {
    const traceEntries: TraceEntry[] = [];
    const lines = raw.split(/\r?\n/);
    const cleanLines: string[] = [];
    let cleanLineNum = 0;

    for (const line of lines) {
        // Check for trace comments in this line
        let traceMatch: RegExpExecArray | null;
        const lineTraceRegex = /<!--XSLT-TRACE\|([^|]*)\|(\d+)\|(.*?)-->/g;

        while ((traceMatch = lineTraceRegex.exec(line)) !== null) {
            traceEntries.push({
                outputLine: cleanLineNum + 1,
                sourceFile: traceMatch[1],
                sourceLine: parseInt(traceMatch[2], 10),
                elementName: traceMatch[3],
            });
        }

        // Strip trace comments from the line
        const cleaned = line.replace(/<!--XSLT-TRACE\|.*?-->/g, '');

        // Only keep lines that aren't entirely trace comments (whitespace-only after strip)
        if (cleaned.trim() !== '' || !line.includes(TRACE_COMMENT_PREFIX)) {
            cleanLines.push(cleaned);
            cleanLineNum++;
        }
    }

    return {
        cleanOutput: cleanLines.join('\n'),
        traceEntries,
    };
}
