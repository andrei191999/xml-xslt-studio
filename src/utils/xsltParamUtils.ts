/**
 * Shared utility for extracting top-level XSLT parameter names.
 *
 * Only surfaces <xsl:param> elements that are direct children of
 * <xsl:stylesheet> / <xsl:transform>. Template-local params (inside
 * <xsl:template>) are excluded because they receive values via
 * <xsl:with-param> and are never supplied by an external caller.
 */
export function extractParamNames(xsltText: string): string[] {
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { DOMParser } = require('@xmldom/xmldom') as typeof import('@xmldom/xmldom');
        const doc  = new DOMParser().parseFromString(xsltText, 'text/xml');
        const root = doc.documentElement;
        if (!root) { return []; }
        const names: string[] = [];
        for (let i = 0; i < root.childNodes.length; i++) {
            const node = root.childNodes[i];
            if (node.nodeType !== 1) { continue; }   // ELEMENT_NODE only
            // xmldom's Node type doesn't overlap with the browser Element type in TS —
            // go through unknown to satisfy the type checker.
            const el = node as unknown as Element;
            const localName = el.localName ?? el.nodeName.replace(/^[^:]+:/, '');
            if (localName === 'param') {
                const name = el.getAttribute('name');
                if (name && !names.includes(name)) { names.push(name); }
            }
        }
        return names;
    } catch {
        // Fallback: regex scan (surfaces ALL params — less accurate but never crashes)
        const names: string[] = [];
        for (const m of xsltText.matchAll(/<xsl:param\b([^>]*?)(?:\/>|>)/g)) {
            const nm = m[1]?.match(/name="([^"]+)"/);
            if (nm && !names.includes(nm[1])) { names.push(nm[1]); }
        }
        return names;
    }
}
