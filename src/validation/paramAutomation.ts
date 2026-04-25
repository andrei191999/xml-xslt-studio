import { DOMParser } from '@xmldom/xmldom';
import * as xpathLib from 'xpath';
import * as path from 'path';
import * as crypto from 'crypto';

const UBL_NAMESPACES = {
    cbc: 'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2',
    cac: 'urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2',
    ubl: 'urn:oasis:names:specification:ubl:schema:xsd:Invoice-2',
    cn:  'urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2',
    ext: 'urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2',
};

/**
 * Resolve parameter automation to a concrete value.
 *
 * Supports:
 * - 'manual': returns empty string (caller provides value separately)
 * - 'uuid': returns a UUID v4
 * - 'today': returns today's date as YYYY-MM-DD (UTC)
 * - 'timestamp': returns current UTC ISO-8601 datetime
 * - 'filename': returns basename of xmlPath
 * - 'basename': returns basename without extension
 * - xpath(...): evaluates XPath expression against xmlContent
 * - any other string: treated as a literal value and returned as-is
 *
 * @param automation The automation mode or literal value
 * @param xmlPath The file path to the XML document
 * @param xmlContent The XML document content as a string
 * @param onWarning Optional callback for warnings (e.g., XPath errors)
 * @returns Resolved string value
 */
export async function resolveAutomation(
    automation: string,
    xmlPath: string,
    xmlContent: string,
    onWarning?: (msg: string) => void,
): Promise<string> {
    // 'manual' — caller provides value separately
    if (automation === 'manual') {
        return '';
    }

    // 'uuid' — generate UUID v4
    if (automation === 'uuid') {
        return crypto.randomUUID();
    }

    // 'today' — return today's date as YYYY-MM-DD
    if (automation === 'today') {
        const now = new Date();
        const year = now.getUTCFullYear();
        const month = String(now.getUTCMonth() + 1).padStart(2, '0');
        const day = String(now.getUTCDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }

    // 'timestamp' — return current UTC ISO-8601 datetime
    if (automation === 'timestamp') {
        return new Date().toISOString();
    }

    // 'filename' — return basename of xmlPath
    if (automation === 'filename') {
        return path.basename(xmlPath);
    }

    // 'basename' — return basename without extension
    if (automation === 'basename') {
        return path.basename(xmlPath, path.extname(xmlPath));
    }

    // xpath(...) — evaluate XPath expression
    if (automation.startsWith('xpath(') && automation.endsWith(')')) {
        try {
            // Extract the XPath expression
            const expr = automation.slice(6, -1);

            // Parse XML
            const doc = new DOMParser().parseFromString(xmlContent, 'text/xml');

            // Evaluate XPath with UBL namespaces.
            // Cast to `any` bridges the @xmldom/xmldom Document type and
            // the xpath package's Node type (structurally compatible at runtime).
            const evaluate = xpathLib.useNamespaces(UBL_NAMESPACES);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const result = evaluate(expr, doc as any);

            // Handle different result types
            if (Array.isArray(result)) {
                // Node array — return textContent of first node
                return result[0]?.textContent ?? '';
            } else if (typeof result === 'string') {
                // String result
                return result;
            } else if (typeof result === 'boolean' || typeof result === 'number') {
                // Convert to string
                return String(result);
            }

            return '';
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            onWarning?.(`XPath automation failed: ${message}`);
            return '';
        }
    }

    // Any other string — treat as a literal value
    return automation;
}
