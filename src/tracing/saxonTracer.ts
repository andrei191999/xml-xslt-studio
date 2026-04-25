import * as path from 'path';
import * as vscode from 'vscode';

/**
 * Parses Saxon HE 10.9 trace XML (from stderr) into a map of
 * output line → XSLT source Location.
 *
 * Saxon trace format: XML to stderr when run with -T flag.
 * <xsl:template> elements carry line + module attributes.
 * The trace is an execution tree — we flatten it to an ordered list,
 * then map output line N to the nearest preceding template invocation.
 *
 * Returns empty Map on parse error, empty input, or file not found.
 * Never throws.
 */
export function parseSaxonTrace(
    traceXml: string,
    xsltAbsPath: string   // used as fallback module path if module attr is relative
): Map<number, vscode.Location> {
    try {
        if (!traceXml || !traceXml.trim()) {
            return new Map();
        }

        const xsltDir = path.dirname(xsltAbsPath);

        interface TemplateEntry { xsltLine: number; xsltModule: string; }
        const entries: TemplateEntry[] = [];

        // Matches <xsl:template ... line="N" ... module="M" ...> (line before module)
        const templateRegex = /<xsl:template\b[^>]*line="(\d+)"[^>]*module="([^"]*)"[^>]*>/g;
        let m: RegExpExecArray | null;
        while ((m = templateRegex.exec(traceXml)) !== null) {
            entries.push({ xsltLine: parseInt(m[1], 10), xsltModule: m[2] });
        }

        // Matches <xsl:template ... module="M" ... line="N" ...> (module before line)
        const templateRegexAlt = /<xsl:template\b[^>]*module="([^"]*)"[^>]*line="(\d+)"[^>]*>/g;
        while ((m = templateRegexAlt.exec(traceXml)) !== null) {
            entries.push({ xsltLine: parseInt(m[2], 10), xsltModule: m[1] });
        }

        if (entries.length === 0) {
            return new Map();
        }

        // Build map: assign consecutive output lines starting from 1
        const traceMap = new Map<number, vscode.Location>();
        for (let i = 0; i < entries.length; i++) {
            const outputLine = i + 1;
            const { xsltLine, xsltModule } = entries[i];

            // Resolve module to absolute path
            const absModule = path.isAbsolute(xsltModule)
                ? xsltModule
                : path.resolve(xsltDir, xsltModule);

            const uri = vscode.Uri.file(absModule);
            // vscode.Position is 0-indexed; xsltLine from trace is 1-indexed
            const position = new vscode.Position(Math.max(0, xsltLine - 1), 0);
            traceMap.set(outputLine, new vscode.Location(uri, position));
        }

        return traceMap;
    } catch {
        return new Map();
    }
}
