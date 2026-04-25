import { parseSaxonTrace } from '../tracing/saxonTracer';

// All paths use Unix-style so path.isAbsolute() returns true on both platforms.
// The vscode mock makes Uri.file() a plain object, so fsPath assertions are safe.
const XSLT_PATH = '/project/transform.xsl';

// Trace with two template invocations — line before module order (primary regex).
const SAMPLE_TRACE = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<trace>',
    '  <xsl:template line="10" module="/project/transform.xsl"/>',
    '  <xsl:template line="25" module="/project/transform.xsl"/>',
    '</trace>',
].join('\n');

// Trace with module before line — exercises the alt regex.
const ALT_ORDER_TRACE = [
    '<trace>',
    '  <xsl:template module="/project/transform.xsl" line="5"/>',
    '</trace>',
].join('\n');

describe('parseSaxonTrace', () => {
    it('produces one map entry per matched xsl:template', () => {
        const result = parseSaxonTrace(SAMPLE_TRACE, XSLT_PATH);
        // Expect exactly 2 entries (one per template element).
        expect(result.size).toBe(2);
    });

    it('maps output line 1 to the correct 0-indexed XSLT line', () => {
        const result = parseSaxonTrace(SAMPLE_TRACE, XSLT_PATH);
        const loc = result.get(1)!;
        // xslt line 10 (1-indexed) → position.line 9 (0-indexed)
        expect((loc as any).range.line).toBe(9);
    });

    it('maps output line 2 to the second template line', () => {
        const result = parseSaxonTrace(SAMPLE_TRACE, XSLT_PATH);
        const loc = result.get(2)!;
        expect((loc as any).range.line).toBe(24); // line 25 → 0-indexed 24
    });

    it('handles module-before-line attribute order via alt regex', () => {
        const result = parseSaxonTrace(ALT_ORDER_TRACE, XSLT_PATH);
        expect(result.size).toBeGreaterThan(0);
        const loc = result.get(1)!;
        expect((loc as any).range.line).toBe(4); // line 5 → 0-indexed 4
    });

    it('returns empty Map for empty string', () => {
        expect(parseSaxonTrace('', XSLT_PATH).size).toBe(0);
    });

    it('returns empty Map for whitespace-only string', () => {
        expect(parseSaxonTrace('   \n  ', XSLT_PATH).size).toBe(0);
    });

    it('returns empty Map when no xsl:template elements are present', () => {
        expect(parseSaxonTrace('<trace><foo/></trace>', XSLT_PATH).size).toBe(0);
    });

    it('does not throw on malformed input', () => {
        expect(() => parseSaxonTrace('<<bad>xml', XSLT_PATH)).not.toThrow();
    });

    it('clamps negative line numbers to 0', () => {
        const trace = '<trace><xsl:template line="0" module="/project/transform.xsl"/></trace>';
        const result = parseSaxonTrace(trace, XSLT_PATH);
        const loc = result.get(1)!;
        expect((loc as any).range.line).toBe(0); // Math.max(0, 0 - 1) = 0
    });
});
